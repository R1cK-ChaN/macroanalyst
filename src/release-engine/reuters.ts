import { createHash } from "node:crypto";
import type { OpenClawConfig } from "../config/config.js";
import { createWebFetchTool } from "../agents/tools/web-fetch.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";

const REUTERS_ORIGIN = "https://www.reuters.com";
const REUTERS_SEARCH_PATH = "/site-search/";

function normalizeReutersUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw, REUTERS_ORIGIN);
    if (parsed.origin !== REUTERS_ORIGIN) {
      return null;
    }
    if (
      parsed.pathname.includes("/video/") ||
      parsed.pathname.includes("/pictures/") ||
      parsed.pathname.includes("/live/")
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

function scoreReutersPath(pathname: string): number {
  if (pathname.includes("/world/us/")) {
    return 5;
  }
  if (pathname.includes("/business/")) {
    return 4;
  }
  if (pathname.includes("/markets/")) {
    return 3;
  }
  if (pathname.includes("/world/")) {
    return 2;
  }
  return 1;
}

function extractReutersCandidates(html: string): string[] {
  const raw: string[] = [];
  const hrefRe = /href="([^"]+)"/g;
  for (const match of html.matchAll(hrefRe)) {
    const href = match[1] ?? "";
    if (!href || href.startsWith("#")) {
      continue;
    }
    if (
      !href.startsWith("/world/") &&
      !href.startsWith("/business/") &&
      !href.startsWith("/markets/") &&
      !href.startsWith("https://www.reuters.com/")
    ) {
      continue;
    }
    raw.push(href);
  }

  const deduped = new Map<string, number>();
  for (const item of raw) {
    const normalized = normalizeReutersUrl(item);
    if (!normalized) {
      continue;
    }
    let score = 0;
    try {
      score = scoreReutersPath(new URL(normalized).pathname);
    } catch {
      score = 0;
    }
    const prev = deduped.get(normalized);
    if (prev === undefined || score > prev) {
      deduped.set(normalized, score);
    }
  }

  return Array.from(deduped.entries())
    .toSorted((a, b) => b[1] - a[1])
    .map(([url]) => url);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function resolveText(details: unknown): string {
  const record = asRecord(details);
  if (!record) {
    return "";
  }
  const text = record.text;
  return typeof text === "string" ? text.trim() : "";
}

function resolveTitle(details: unknown): string | undefined {
  const record = asRecord(details);
  if (!record) {
    return undefined;
  }
  const title = record.title;
  return typeof title === "string" && title.trim() ? title.trim() : undefined;
}

export type ReutersMediaFetchResult = {
  source: "reuters";
  fetchedAt: string;
  searchUrl: string;
  articleUrl?: string;
  title?: string;
  text?: string;
  hash?: string;
  skipped?: boolean;
  reason?: string;
};

export async function fetchReutersMedia(params: {
  cfg: OpenClawConfig;
  indicator: string;
  releaseDate: string;
  maxChars: number;
}): Promise<ReutersMediaFetchResult> {
  const query = `U.S. ${params.indicator} ${params.releaseDate}`;
  const searchUrl = new URL(REUTERS_SEARCH_PATH, REUTERS_ORIGIN);
  searchUrl.searchParams.set("query", query);

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

  try {
    if (!response.ok) {
      return {
        source: "reuters",
        fetchedAt: new Date().toISOString(),
        searchUrl: searchUrl.toString(),
        skipped: true,
        reason: `reuters_search_http_${response.status}`,
      };
    }
    const html = (await response.text()).slice(0, 1_000_000);
    const candidates = extractReutersCandidates(html);
    if (candidates.length === 0) {
      return {
        source: "reuters",
        fetchedAt: new Date().toISOString(),
        searchUrl: searchUrl.toString(),
        skipped: true,
        reason: "reuters_article_not_found",
      };
    }

    const webFetch = createWebFetchTool({ config: params.cfg });
    if (!webFetch) {
      return {
        source: "reuters",
        fetchedAt: new Date().toISOString(),
        searchUrl: searchUrl.toString(),
        skipped: true,
        reason: "web_fetch_disabled",
      };
    }

    for (const candidate of candidates.slice(0, 5)) {
      const fetched = await webFetch.execute(`release-engine-reuters-${Date.now()}`, {
        url: candidate,
        extractMode: "text",
        maxChars: params.maxChars,
      });
      const text = resolveText(fetched.details);
      if (!text) {
        continue;
      }
      const hash = createHash("sha256").update(text).digest("hex");
      return {
        source: "reuters",
        fetchedAt: new Date().toISOString(),
        searchUrl: searchUrl.toString(),
        articleUrl: candidate,
        title: resolveTitle(fetched.details),
        text,
        hash,
      };
    }

    return {
      source: "reuters",
      fetchedAt: new Date().toISOString(),
      searchUrl: searchUrl.toString(),
      skipped: true,
      reason: "reuters_article_fetch_empty",
    };
  } finally {
    await release();
  }
}
