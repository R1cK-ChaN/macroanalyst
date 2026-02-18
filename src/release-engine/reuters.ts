import { createHash } from "node:crypto";
import type { OpenClawConfig } from "../config/config.js";
import { createWebFetchTool } from "../agents/tools/web-fetch.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";

const REUTERS_ORIGIN = "https://www.reuters.com";
const REUTERS_SEARCH_PATH = "/site-search/";
const DEFAULT_MAX_CANDIDATES = 20;
const MIN_REQUIRED_CANDIDATES = 5;
const MIN_FULL_BODY_CHARS = 800;
const LIGHT_META_BATCH_SIZE = 4;

const US_KEYWORD_RE = /\b(?:US|U\.S\.|United States|American)\b/i;
const CPI_TITLE_KEYWORD_RE = /\b(?:CPI|consumer price|inflation|prices)\b/i;
const PREVIEW_NUMERIC_RE = /%|\bbasis points?\b|\bbps\b|\bpoints?\b/i;
const PREVIEW_EXPECTATION_RE = /\b(?:forecast|expected|economists|poll)\b/i;
const PREVIEW_CPI_RE = /\b(?:CPI|consumer prices?|inflation)\b/i;

type ReutersCandidateSeed = {
  url: string;
  title?: string;
  snippet?: string;
};

type ReutersCandidateMeta = ReutersCandidateSeed & {
  title: string;
  publishedTimeRaw: string;
  publishedTimeMs: number;
  publishedTimeIso: string;
  bodyPreview: string;
};

export type ReutersScoredCandidate = ReutersCandidateMeta & {
  score: number;
  reasons: string[];
  dropped: boolean;
  dropReason?: string;
  deltaHours?: number;
};

type ReutersAlternate = {
  url: string;
  title: string;
  publishedTimeMs: number;
  publishedTimeIso: string;
  score: number;
  reasons: string[];
};

type ReutersSelectedArticle = ReutersAlternate & {
  publishedTimeRaw: string;
  bodyFull: string;
  bodyHash: string;
};

export type ReutersFetchForCpiResult = {
  mode: "ok" | "degraded";
  reason?: string;
  query: string;
  searchUrl: string;
  releaseTimeMs: number;
  releaseTimeIso: string;
  fetchedAtMs: number;
  fetchedAtIso: string;
  selected: ReutersSelectedArticle | null;
  alternates: ReutersAlternate[];
  candidates: ReutersScoredCandidate[];
};

function resolveIsoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

function toEpochMsUtc(value: string | undefined, fallbackMs: number): number {
  if (!value || !value.trim()) {
    return fallbackMs;
  }
  const trimmed = value.trim();
  const parsed = Date.parse(trimmed);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const utc = Date.parse(`${trimmed}T00:00:00.000Z`);
    if (Number.isFinite(utc)) {
      return utc;
    }
  }
  return fallbackMs;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll(/&nbsp;/gi, " ")
    .replaceAll(/&amp;/gi, "&")
    .replaceAll(/&lt;/gi, "<")
    .replaceAll(/&gt;/gi, ">")
    .replaceAll(/&#39;/gi, "'")
    .replaceAll(/&quot;/gi, '"');
}

function stripHtml(value: string): string {
  return escapeHtml(
    value
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " "),
  ).trim();
}

function normalizeReutersUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw, REUTERS_ORIGIN);
    if (parsed.origin !== REUTERS_ORIGIN) {
      return null;
    }
    const pathname = parsed.pathname.toLowerCase();
    if (
      pathname.includes("/video/") ||
      pathname.includes("/pictures/") ||
      pathname.includes("/live/") ||
      pathname.includes("/world/europe") ||
      pathname.includes("/world/asia")
    ) {
      return null;
    }
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function extractCandidateSeeds(html: string, maxCandidates: number): ReutersCandidateSeed[] {
  const seeds: ReutersCandidateSeed[] = [];
  const linkRe = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const seen = new Set<string>();

  for (const match of html.matchAll(linkRe)) {
    const href = match[1] ?? "";
    const inner = match[2] ?? "";
    const normalized = normalizeReutersUrl(href);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    const title = stripHtml(inner);
    if (!title) {
      continue;
    }
    seen.add(normalized);
    seeds.push({ url: normalized, title });
    if (seeds.length >= maxCandidates) {
      break;
    }
  }

  return seeds;
}

function parseMetaContent(html: string, attrName: "name" | "property", key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `<meta[^>]+${attrName}=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`,
    "i",
  );
  const match = html.match(re);
  return match?.[1]?.trim() ?? "";
}

function parseTitle(html: string): string {
  const og = parseMetaContent(html, "property", "og:title");
  if (og) {
    return stripHtml(og);
  }
  const twitter = parseMetaContent(html, "name", "twitter:title");
  if (twitter) {
    return stripHtml(twitter);
  }
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return stripHtml(titleMatch?.[1] ?? "");
}

function parsePublishedTimeRaw(html: string): string {
  const candidates = [
    parseMetaContent(html, "property", "article:published_time"),
    parseMetaContent(html, "property", "og:article:published_time"),
    parseMetaContent(html, "name", "article:published_time"),
    parseMetaContent(html, "name", "date"),
    parseMetaContent(html, "name", "publish-date"),
    parseMetaContent(html, "name", "pubdate"),
    parseMetaContent(html, "name", "sailthru.date"),
  ].filter(Boolean);
  return candidates[0] ?? "";
}

function parseBodyPreview(html: string, maxChars = 500): string {
  const paragraphs = Array.from(html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi))
    .map((match) => stripHtml(match[1] ?? ""))
    .filter(Boolean)
    .join(" ");
  const base = paragraphs || stripHtml(html);
  return base.slice(0, maxChars).trim();
}

async function fetchLightMetadata(params: {
  seed: ReutersCandidateSeed;
  timeoutMs: number;
}): Promise<ReutersCandidateMeta | null> {
  const { response, release } = await fetchWithSsrFGuard({
    url: params.seed.url,
    init: {
      method: "GET",
      headers: {
        Accept: "text/html, text/plain;q=0.8, */*;q=0.1",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      },
    },
    timeoutMs: params.timeoutMs,
    maxRedirects: 3,
    auditContext: "release-engine-reuters-meta",
  });

  try {
    if (!response.ok) {
      return null;
    }
    const html = (await response.text()).slice(0, 1_200_000);
    const title = parseTitle(html);
    if (!title) {
      return null;
    }
    const publishedTimeRaw = parsePublishedTimeRaw(html);
    const publishedTimeMs = Date.parse(publishedTimeRaw);
    if (!publishedTimeRaw || !Number.isFinite(publishedTimeMs)) {
      return null;
    }
    const bodyPreview = parseBodyPreview(html, 500);
    return {
      url: params.seed.url,
      title,
      snippet: params.seed.snippet,
      publishedTimeRaw,
      publishedTimeMs,
      publishedTimeIso: resolveIsoFromMs(publishedTimeMs),
      bodyPreview,
    };
  } finally {
    await release();
  }
}

function scoreCandidate(params: {
  item: ReutersCandidateMeta;
  releaseTimeMs: number;
}): ReutersScoredCandidate {
  const reasons: string[] = [];
  let score = 0;
  let dropped = false;
  let dropReason: string | undefined;

  const deltaHours = Math.abs(params.item.publishedTimeMs - params.releaseTimeMs) / 3_600_000;
  if (deltaHours <= 2) {
    score += 3;
    reasons.push("time<=2h:+3");
  } else if (deltaHours <= 6) {
    score += 1;
    reasons.push("2h<time<=6h:+1");
  } else {
    dropped = true;
    dropReason = "time_window>6h";
    reasons.push("drop:time_window>6h");
  }

  if (!dropped) {
    const hasUs = US_KEYWORD_RE.test(params.item.title);
    const hasCpi = CPI_TITLE_KEYWORD_RE.test(params.item.title);
    if (hasUs && hasCpi) {
      score += 3;
      reasons.push("title:US&CPI:+3");
    } else if (hasCpi) {
      score += 1;
      reasons.push("title:CPI_only:+1");
    } else if (!hasUs && !hasCpi) {
      dropped = true;
      dropReason = "title_missing_us_and_cpi";
      reasons.push("drop:title_missing_us_and_cpi");
    } else {
      dropped = true;
      dropReason = "title_missing_cpi_keywords";
      reasons.push("drop:title_missing_cpi_keywords");
    }
  }

  if (!dropped) {
    let featureCount = 0;
    if (PREVIEW_NUMERIC_RE.test(params.item.bodyPreview)) {
      featureCount += 1;
    }
    if (PREVIEW_EXPECTATION_RE.test(params.item.bodyPreview)) {
      featureCount += 1;
    }
    if (PREVIEW_CPI_RE.test(params.item.bodyPreview)) {
      featureCount += 1;
    }
    if (featureCount >= 3) {
      score += 2;
      reasons.push("preview_features=3:+2");
    } else if (featureCount === 2) {
      score += 1;
      reasons.push("preview_features=2:+1");
    } else {
      reasons.push("preview_features<=1:+0");
    }
  }

  if (!dropped) {
    let pathname = "";
    try {
      pathname = new URL(params.item.url).pathname.toLowerCase();
    } catch {
      pathname = "";
    }
    if (
      pathname.includes("/world/us") ||
      pathname.includes("/markets/us") ||
      pathname.includes("/business")
    ) {
      score += 1;
      reasons.push("url_prefer:+1");
    }
    if (
      pathname.includes("/markets/asia") ||
      pathname.includes("/markets/europe") ||
      pathname.includes("/markets/global")
    ) {
      score -= 1;
      reasons.push("url_penalty:-1");
    }
  }

  return {
    ...params.item,
    score,
    reasons,
    dropped,
    dropReason,
    deltaHours,
  };
}

function toAlternate(item: ReutersScoredCandidate): ReutersAlternate {
  return {
    url: item.url,
    title: item.title ?? "",
    publishedTimeMs: item.publishedTimeMs,
    publishedTimeIso: item.publishedTimeIso,
    score: item.score,
    reasons: item.reasons,
  };
}

function resolveFullText(details: unknown): string {
  const record = asRecord(details);
  if (!record) {
    return "";
  }
  const text = record.text;
  return typeof text === "string" ? text.trim() : "";
}

function resolveFullTitle(details: unknown): string {
  const record = asRecord(details);
  if (!record) {
    return "";
  }
  const title = record.title;
  return typeof title === "string" ? title.trim() : "";
}

function buildDegradedResult(params: {
  query: string;
  searchUrl: string;
  releaseTimeMs: number;
  fetchedAtMs: number;
  reason: string;
  candidates: ReutersScoredCandidate[];
  alternates?: ReutersAlternate[];
}): ReutersFetchForCpiResult {
  return {
    mode: "degraded",
    reason: params.reason,
    query: params.query,
    searchUrl: params.searchUrl,
    releaseTimeMs: params.releaseTimeMs,
    releaseTimeIso: resolveIsoFromMs(params.releaseTimeMs),
    fetchedAtMs: params.fetchedAtMs,
    fetchedAtIso: resolveIsoFromMs(params.fetchedAtMs),
    selected: null,
    alternates: params.alternates ?? [],
    candidates: params.candidates,
  };
}

export async function fetchReutersForCpi(params: {
  cfg: OpenClawConfig;
  releaseTimeMs: number;
  query: string;
  maxCandidates?: number;
  maxChars?: number;
}): Promise<ReutersFetchForCpiResult> {
  const fetchedAtMs = Date.now();
  const maxCandidates = Math.min(
    DEFAULT_MAX_CANDIDATES,
    Math.max(MIN_REQUIRED_CANDIDATES, Math.floor(params.maxCandidates ?? DEFAULT_MAX_CANDIDATES)),
  );
  const maxChars = Math.max(2_000, Math.floor(params.maxChars ?? 20_000));
  const searchUrl = new URL(REUTERS_SEARCH_PATH, REUTERS_ORIGIN);
  searchUrl.searchParams.set("query", params.query);

  const { response, release } = await fetchWithSsrFGuard({
    url: searchUrl.toString(),
    init: {
      method: "GET",
      headers: {
        Accept: "text/html, text/plain;q=0.8, */*;q=0.1",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      },
    },
    timeoutMs: 20_000,
    maxRedirects: 3,
    auditContext: "release-engine-reuters-search",
  });

  let seeds: ReutersCandidateSeed[] = [];
  try {
    if (!response.ok) {
      return buildDegradedResult({
        query: params.query,
        searchUrl: searchUrl.toString(),
        releaseTimeMs: params.releaseTimeMs,
        fetchedAtMs,
        reason: `reuters_search_http_${response.status}`,
        candidates: [],
      });
    }
    const html = (await response.text()).slice(0, 2_000_000);
    seeds = extractCandidateSeeds(html, maxCandidates);
  } finally {
    await release();
  }

  if (seeds.length < MIN_REQUIRED_CANDIDATES) {
    return buildDegradedResult({
      query: params.query,
      searchUrl: searchUrl.toString(),
      releaseTimeMs: params.releaseTimeMs,
      fetchedAtMs,
      reason: `reuters_candidates_lt_${MIN_REQUIRED_CANDIDATES}`,
      candidates: [],
    });
  }

  const metaRows: ReutersCandidateMeta[] = [];
  for (let index = 0; index < seeds.length; index += LIGHT_META_BATCH_SIZE) {
    const batch = seeds.slice(index, index + LIGHT_META_BATCH_SIZE);
    const resolved = await Promise.all(
      batch.map((seed) =>
        fetchLightMetadata({
          seed,
          timeoutMs: 12_000,
        }).catch(() => null),
      ),
    );
    for (const row of resolved) {
      if (row) {
        metaRows.push(row);
      }
    }
  }

  if (metaRows.length === 0) {
    return buildDegradedResult({
      query: params.query,
      searchUrl: searchUrl.toString(),
      releaseTimeMs: params.releaseTimeMs,
      fetchedAtMs,
      reason: "reuters_meta_unavailable",
      candidates: [],
    });
  }

  const scored = metaRows.map((item) =>
    scoreCandidate({
      item,
      releaseTimeMs: params.releaseTimeMs,
    }),
  );

  const survivors = scored
    .filter((item) => !item.dropped)
    .toSorted((a, b) => b.score - a.score || a.publishedTimeMs - b.publishedTimeMs);
  if (survivors.length === 0) {
    return buildDegradedResult({
      query: params.query,
      searchUrl: searchUrl.toString(),
      releaseTimeMs: params.releaseTimeMs,
      fetchedAtMs,
      reason: "reuters_no_scored_survivor",
      candidates: scored,
    });
  }

  const best = survivors[0];
  if (!best || best.score < 6) {
    return buildDegradedResult({
      query: params.query,
      searchUrl: searchUrl.toString(),
      releaseTimeMs: params.releaseTimeMs,
      fetchedAtMs,
      reason: "reuters_best_score_lt_6",
      candidates: scored,
      alternates: survivors.slice(0, 3).map(toAlternate),
    });
  }

  const webFetch = createWebFetchTool({ config: params.cfg });
  if (!webFetch) {
    return buildDegradedResult({
      query: params.query,
      searchUrl: searchUrl.toString(),
      releaseTimeMs: params.releaseTimeMs,
      fetchedAtMs,
      reason: "web_fetch_disabled",
      candidates: scored,
      alternates: survivors.slice(0, 3).map(toAlternate),
    });
  }

  let fetched: Awaited<ReturnType<typeof webFetch.execute>>;
  try {
    fetched = await webFetch.execute(`release-engine-reuters-full-${Date.now()}`, {
      url: best.url,
      extractMode: "text",
      maxChars,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return buildDegradedResult({
      query: params.query,
      searchUrl: searchUrl.toString(),
      releaseTimeMs: params.releaseTimeMs,
      fetchedAtMs,
      reason: `reuters_full_fetch_failed:${message}`,
      candidates: scored,
      alternates: survivors.slice(0, 3).map(toAlternate),
    });
  }
  const bodyFull = resolveFullText(fetched.details);
  const title = resolveFullTitle(fetched.details) || best.title || "";
  const hasCpiKeyword = PREVIEW_CPI_RE.test(bodyFull);
  if (bodyFull.length <= MIN_FULL_BODY_CHARS || !hasCpiKeyword) {
    return buildDegradedResult({
      query: params.query,
      searchUrl: searchUrl.toString(),
      releaseTimeMs: params.releaseTimeMs,
      fetchedAtMs,
      reason: "reuters_full_text_validation_failed",
      candidates: scored,
      alternates: survivors.slice(0, 3).map(toAlternate),
    });
  }

  const selected: ReutersSelectedArticle = {
    url: best.url,
    title,
    publishedTimeRaw: best.publishedTimeRaw,
    publishedTimeMs: best.publishedTimeMs,
    publishedTimeIso: best.publishedTimeIso,
    score: best.score,
    reasons: best.reasons,
    bodyFull,
    bodyHash: createHash("sha256").update(bodyFull).digest("hex"),
  };

  return {
    mode: "ok",
    query: params.query,
    searchUrl: searchUrl.toString(),
    releaseTimeMs: params.releaseTimeMs,
    releaseTimeIso: resolveIsoFromMs(params.releaseTimeMs),
    fetchedAtMs,
    fetchedAtIso: resolveIsoFromMs(fetchedAtMs),
    selected,
    alternates: survivors.slice(1, 4).map(toAlternate),
    candidates: scored,
  };
}

export type ReutersMediaFetchResult = {
  source: "reuters";
  mode: "ok" | "degraded";
  reason?: string;
  query: string;
  searchUrl: string;
  releaseTimeMs: number;
  releaseTimeIso: string;
  articleTimeMs?: number;
  articleTimeIso?: string;
  fetchedAtMs: number;
  fetchedAtIso: string;
  articleUrl?: string;
  title?: string;
  text?: string;
  hash?: string;
  score?: number;
  reasons?: string[];
  selected?: ReutersSelectedArticle | null;
  alternates?: ReutersAlternate[];
  candidates?: ReutersScoredCandidate[];
};

export async function fetchReutersMedia(params: {
  cfg: OpenClawConfig;
  indicator: string;
  releaseDate: string;
  releaseTimeMs?: number;
  maxChars: number;
}): Promise<ReutersMediaFetchResult> {
  const releaseTimeMs =
    typeof params.releaseTimeMs === "number" && Number.isFinite(params.releaseTimeMs)
      ? params.releaseTimeMs
      : toEpochMsUtc(params.releaseDate, Date.now());
  const query = `US ${params.indicator} ${params.releaseDate}`;
  const result = await fetchReutersForCpi({
    cfg: params.cfg,
    releaseTimeMs,
    query,
    maxCandidates: DEFAULT_MAX_CANDIDATES,
    maxChars: params.maxChars,
  });

  if (result.mode === "degraded" || !result.selected) {
    return {
      source: "reuters",
      mode: "degraded",
      reason: result.reason,
      query: result.query,
      searchUrl: result.searchUrl,
      releaseTimeMs: result.releaseTimeMs,
      releaseTimeIso: result.releaseTimeIso,
      fetchedAtMs: result.fetchedAtMs,
      fetchedAtIso: result.fetchedAtIso,
      selected: null,
      alternates: result.alternates,
      candidates: result.candidates,
    };
  }

  return {
    source: "reuters",
    mode: "ok",
    query: result.query,
    searchUrl: result.searchUrl,
    releaseTimeMs: result.releaseTimeMs,
    releaseTimeIso: result.releaseTimeIso,
    articleTimeMs: result.selected.publishedTimeMs,
    articleTimeIso: result.selected.publishedTimeIso,
    fetchedAtMs: result.fetchedAtMs,
    fetchedAtIso: result.fetchedAtIso,
    articleUrl: result.selected.url,
    title: result.selected.title,
    text: result.selected.bodyFull,
    hash: result.selected.bodyHash,
    score: result.selected.score,
    reasons: result.selected.reasons,
    selected: result.selected,
    alternates: result.alternates,
    candidates: result.candidates,
  };
}
