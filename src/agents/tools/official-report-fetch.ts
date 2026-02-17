import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import type { AnyAgentTool } from "./common.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import { stringEnum } from "../schema/typebox.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";
import {
  CacheEntry,
  DEFAULT_CACHE_TTL_MINUTES,
  DEFAULT_TIMEOUT_SECONDS,
  normalizeCacheKey,
  readCache,
  readResponseText,
  resolveCacheTtlMs,
  resolveTimeoutSeconds,
  withTimeout,
  writeCache,
} from "./web-shared.js";

const PROVIDERS = ["tradingeconomics", "web"] as const;
const DEFAULT_PROVIDER: (typeof PROVIDERS)[number] = "tradingeconomics";

const DEFAULT_TRADING_ECONOMICS_BASE_URL = "https://api.tradingeconomics.com";
const DEFAULT_INDICATORS_WEB_URL = "https://tradingeconomics.com/analytics/indicators.aspx";
const DEFAULT_DAYS_BACK = 14;
const DEFAULT_MAX_REPORTS = 10;
const MAX_REPORTS_CAP = 50;
const MAX_REPORT_CHARS_CAP = 25_000;
const IMPORTANCE_LEVELS = [1, 2, 3] as const;

const REPORT_CACHE = new Map<string, CacheEntry<Record<string, unknown>>>();

const OfficialReportFetchSchema = Type.Object({
  provider: Type.Optional(
    stringEnum(PROVIDERS, {
      description: 'Data provider ("tradingeconomics" API or "web" page scraping mode).',
      default: DEFAULT_PROVIDER,
    }),
  ),
  country: Type.Optional(
    Type.String({
      description: 'Country filter (default from config, fallback: "united states").',
    }),
  ),
  indicator: Type.Optional(
    Type.String({
      description: "Indicator/event filter (for example: CPI, Non Farm Payrolls, GDP Growth).",
    }),
  ),
  startDate: Type.Optional(
    Type.String({
      description: "Start date in YYYY-MM-DD format. Defaults to endDate - 14 days (UTC).",
    }),
  ),
  endDate: Type.Optional(
    Type.String({
      description: "End date in YYYY-MM-DD format. Defaults to today (UTC).",
    }),
  ),
  importance: Type.Optional(
    Type.Number({
      description: "Trading Economics importance level (1=low, 2=medium, 3=high).",
      minimum: 1,
      maximum: 3,
    }),
  ),
  maxReports: Type.Optional(
    Type.Number({
      description: "Maximum report rows to return (1-50).",
      minimum: 1,
      maximum: MAX_REPORTS_CAP,
    }),
  ),
  includeReportBody: Type.Optional(
    Type.Boolean({
      description: "Fetch and include plain-text report excerpts from official report URLs.",
      default: false,
    }),
  ),
  maxReportChars: Type.Optional(
    Type.Number({
      description:
        "Maximum characters for each fetched report excerpt (default: 4000, cap: 25000).",
      minimum: 200,
      maximum: MAX_REPORT_CHARS_CAP,
    }),
  ),
});

type OfficialReportFetchConfig = NonNullable<OpenClawConfig["tools"]>["web"] extends infer Web
  ? Web extends { officialReportFetch?: infer ReportFetch }
    ? ReportFetch
    : undefined
  : undefined;

type TradingEconomicsCalendarItem = {
  Date?: string;
  Country?: string;
  Category?: string;
  Event?: string;
  Actual?: string | number | null;
  Previous?: string | number | null;
  Forecast?: string | number | null;
  Importance?: number | string;
  Source?: string;
  Reference?: string;
  URL?: string;
};

type WebIndicatorRow = {
  title: string;
  source?: string;
  frequency?: string;
  fromYear?: string;
  untilYear?: string;
  tradingEconomicsUrl?: string;
};

function resolveConfig(cfg?: OpenClawConfig): OfficialReportFetchConfig {
  const officialReportFetch = cfg?.tools?.web?.officialReportFetch;
  if (!officialReportFetch || typeof officialReportFetch !== "object") {
    return undefined;
  }
  return officialReportFetch as OfficialReportFetchConfig;
}

function resolveEnabled(params: {
  config?: OfficialReportFetchConfig;
  sandboxed?: boolean;
}): boolean {
  if (typeof params.config?.enabled === "boolean") {
    return params.config.enabled;
  }
  return true;
}

function resolveTradingEconomicsApiKey(config?: OfficialReportFetchConfig): string | undefined {
  const fromConfig =
    config && "apiKey" in config && typeof config.apiKey === "string"
      ? normalizeSecretInput(config.apiKey)
      : "";
  const fromEnv = normalizeSecretInput(process.env.TRADING_ECONOMICS_API_KEY);
  return fromConfig || fromEnv || undefined;
}

function resolveBaseUrl(config?: OfficialReportFetchConfig): string {
  const fromConfig =
    config && "baseUrl" in config && typeof config.baseUrl === "string"
      ? config.baseUrl.trim()
      : "";
  return fromConfig || DEFAULT_TRADING_ECONOMICS_BASE_URL;
}

function resolveWebIndicatorsUrl(config?: OfficialReportFetchConfig): string {
  const fromConfig =
    config && "webIndicatorsUrl" in config && typeof config.webIndicatorsUrl === "string"
      ? config.webIndicatorsUrl.trim()
      : "";
  return fromConfig || DEFAULT_INDICATORS_WEB_URL;
}

function missingKeyPayload() {
  return {
    error: "missing_trading_economics_api_key",
    message: `official_report_fetch needs a Trading Economics API key. Set TRADING_ECONOMICS_API_KEY, or configure tools.web.officialReportFetch.apiKey (for example via \`${formatCliCommand("openclaw configure --section web")}\`).`,
    docs: "https://docs.tradingeconomics.com/get_started/",
  };
}

function formatUtcDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${date.getUTCDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return false;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function addUtcDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map((part) => Number.parseInt(part, 10));
  const out = new Date(Date.UTC(year, month - 1, day + days));
  return formatUtcDate(out);
}

function resolveDateRange(params: {
  startDate?: string;
  endDate?: string;
  daysBack: number;
}): { startDate: string; endDate: string } | { error: Record<string, unknown> } {
  const today = formatUtcDate(new Date());
  const endDate = params.endDate?.trim() || today;
  if (!isValidIsoDate(endDate)) {
    return {
      error: {
        error: "invalid_end_date",
        message: "endDate must be in YYYY-MM-DD format.",
      },
    };
  }

  const defaultStartDate = addUtcDays(endDate, -Math.max(0, Math.floor(params.daysBack)));
  const startDate = params.startDate?.trim() || defaultStartDate;
  if (!isValidIsoDate(startDate)) {
    return {
      error: {
        error: "invalid_start_date",
        message: "startDate must be in YYYY-MM-DD format.",
      },
    };
  }

  if (startDate > endDate) {
    return {
      error: {
        error: "invalid_date_range",
        message: "startDate must be before or equal to endDate.",
      },
    };
  }

  return { startDate, endDate };
}

function resolveImportance(value: unknown): (typeof IMPORTANCE_LEVELS)[number] | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const normalized = Math.trunc(value);
  if (!IMPORTANCE_LEVELS.includes(normalized as (typeof IMPORTANCE_LEVELS)[number])) {
    return undefined;
  }
  return normalized as (typeof IMPORTANCE_LEVELS)[number];
}

function parseNumericValue(raw: string | number | null | undefined): number | undefined {
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? raw : undefined;
  }
  if (typeof raw !== "string") {
    return undefined;
  }
  const match = raw.trim().match(/-?\d+(?:\.\d+)?/);
  if (!match) {
    return undefined;
  }
  const parsed = Number.parseFloat(match[0]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function resolveProvider(
  value: unknown,
  config?: OfficialReportFetchConfig,
): (typeof PROVIDERS)[number] {
  const fromArgs = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (fromArgs === "tradingeconomics" || fromArgs === "web") {
    return fromArgs;
  }
  const fromConfig =
    config && "provider" in config && typeof config.provider === "string"
      ? config.provider.trim().toLowerCase()
      : "";
  if (fromConfig === "tradingeconomics" || fromConfig === "web") {
    return fromConfig;
  }
  return DEFAULT_PROVIDER;
}

function resolveReportUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function inferOfficialSource(params: {
  source?: string;
  indicator?: string;
  event?: string;
  category?: string;
  country?: string;
}) {
  const source = params.source?.trim();
  const country = params.country?.trim().toLowerCase() || "";
  const haystack = [params.indicator, params.event, params.category]
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase();

  if (source) {
    const normalizedSource = source.toLowerCase();
    if (normalizedSource.includes("bureau of labor statistics")) {
      return {
        publisher: "U.S. Bureau of Labor Statistics",
        officialHome: "https://www.bls.gov/news.release/",
        official: true,
      };
    }
    if (normalizedSource.includes("bureau of economic analysis")) {
      return {
        publisher: "U.S. Bureau of Economic Analysis",
        officialHome: "https://www.bea.gov/news",
        official: true,
      };
    }
    if (normalizedSource.includes("census bureau")) {
      return {
        publisher: "U.S. Census Bureau",
        officialHome: "https://www.census.gov/economic-indicators/",
        official: true,
      };
    }
    if (normalizedSource.includes("federal reserve")) {
      return {
        publisher: "Federal Reserve",
        officialHome: "https://www.federalreserve.gov/newsevents.htm",
        official: true,
      };
    }
  }

  if (country.includes("united states") || country.includes("us")) {
    if (/(cpi|inflation|nonfarm|payroll|unemployment|employment)/.test(haystack)) {
      return {
        publisher: "U.S. Bureau of Labor Statistics",
        officialHome: "https://www.bls.gov/news.release/",
        official: true,
      };
    }
    if (/(gdp|pce|personal income|consumer spending)/.test(haystack)) {
      return {
        publisher: "U.S. Bureau of Economic Analysis",
        officialHome: "https://www.bea.gov/news",
        official: true,
      };
    }
    if (/(retail sales|durable goods|housing starts|new home sales)/.test(haystack)) {
      return {
        publisher: "U.S. Census Bureau",
        officialHome: "https://www.census.gov/economic-indicators/",
        official: true,
      };
    }
    if (/(interest rate|fomc|federal funds)/.test(haystack)) {
      return {
        publisher: "Federal Reserve",
        officialHome: "https://www.federalreserve.gov/newsevents.htm",
        official: true,
      };
    }
  }

  return {
    publisher: source || "Unknown",
    officialHome: undefined,
    official: false,
  };
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripHtml(value: string): string {
  return normalizeWhitespace(
    value
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">"),
  );
}

function makeCacheKey(prefix: string, params: Record<string, unknown>): string {
  return normalizeCacheKey(`${prefix}:${JSON.stringify(params)}`);
}

function slugifyCountry(country: string): string {
  return country
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function resolveAbsoluteUrl(input: string | undefined, base: string): string | undefined {
  const trimmed = input?.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return new URL(trimmed, base).toString();
  } catch {
    return undefined;
  }
}

function parseIndicatorsRowsFromHtml(html: string): WebIndicatorRow[] {
  const rows: WebIndicatorRow[] = [];
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
  const hrefRegex = /href\s*=\s*["']([^"']+)["']/i;
  const base = "https://tradingeconomics.com";

  for (const rowMatch of html.matchAll(rowRegex)) {
    const rowHtml = rowMatch[1] || "";
    const cells = Array.from(rowHtml.matchAll(cellRegex)).map((match) => match[1] || "");
    if (cells.length < 2) {
      continue;
    }

    const title = stripHtml(cells[0]);
    const source = stripHtml(cells[1]) || undefined;
    const frequency = stripHtml(cells[2] || "") || undefined;
    const fromYear = stripHtml(cells[3] || "") || undefined;
    const untilYear = stripHtml(cells[4] || "") || undefined;
    const href = cells[0].match(hrefRegex)?.[1];
    const tradingEconomicsUrl = resolveAbsoluteUrl(href, base);
    if (!title || !tradingEconomicsUrl) {
      continue;
    }
    rows.push({ title, source, frequency, fromYear, untilYear, tradingEconomicsUrl });
  }

  if (rows.length > 0) {
    return rows;
  }

  const links: WebIndicatorRow[] = [];
  const anchorRegex = /<a[^>]+href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorRegex)) {
    const href = match[1];
    const title = stripHtml(match[2] || "");
    const tradingEconomicsUrl = resolveAbsoluteUrl(href, base);
    if (!title || !tradingEconomicsUrl) {
      continue;
    }
    links.push({ title, tradingEconomicsUrl });
  }
  return links;
}

async function fetchReportExcerpt(params: {
  url: string;
  timeoutSeconds: number;
  maxChars: number;
}): Promise<{
  excerpt?: string;
  contentType?: string;
  fetchError?: string;
}> {
  try {
    const res = await fetch(params.url, {
      method: "GET",
      headers: { Accept: "text/html, text/plain, application/pdf;q=0.8, */*;q=0.5" },
      signal: withTimeout(undefined, params.timeoutSeconds * 1000),
    });
    if (!res.ok) {
      return { fetchError: `report_fetch_http_${res.status}` };
    }
    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    if (contentType.includes("application/pdf")) {
      return { contentType, fetchError: "report_fetch_pdf_not_parsed" };
    }

    const textResult = await readResponseText(res, { maxBytes: params.maxChars * 4 });
    const raw = textResult.text || "";
    const excerptSource =
      contentType.includes("html") || raw.includes("<html")
        ? stripHtml(raw)
        : normalizeWhitespace(raw);
    return {
      contentType,
      excerpt: excerptSource.slice(0, params.maxChars) || undefined,
    };
  } catch (error) {
    return {
      fetchError: `report_fetch_failed:${error instanceof Error ? error.message : "unknown_error"}`,
    };
  }
}

async function runWebOfficialFetch(params: {
  webIndicatorsUrl: string;
  country: string;
  indicator?: string;
  maxReports: number;
  includeReportBody: boolean;
  maxReportChars: number;
  timeoutSeconds: number;
  cacheTtlMs: number;
}) {
  const cacheKey = makeCacheKey("official_report_fetch:web", params);
  const cached = readCache(REPORT_CACHE, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }

  const start = Date.now();
  const res = await fetch(params.webIndicatorsUrl, {
    method: "GET",
    headers: { Accept: "text/html, text/plain, */*" },
    signal: withTimeout(undefined, params.timeoutSeconds * 1000),
  });
  if (!res.ok) {
    const detailResult = await readResponseText(res, { maxBytes: 64_000 });
    const detail = detailResult.text;
    throw new Error(`Indicators web page error (${res.status}): ${detail || res.statusText}`);
  }
  const page = await readResponseText(res, { maxBytes: 2_000_000 });
  const rows = parseIndicatorsRowsFromHtml(page.text);

  const indicatorFilter = params.indicator?.trim().toLowerCase() || "";
  const countryPrefix = `${params.country.trim().toLowerCase()} `;
  const countrySlug = slugifyCountry(params.country);
  const filtered = rows
    .filter((row) => {
      const title = row.title.trim().toLowerCase();
      if (!title.startsWith(countryPrefix)) {
        return false;
      }
      if (indicatorFilter && !title.includes(indicatorFilter)) {
        return false;
      }
      const teUrl = row.tradingEconomicsUrl?.toLowerCase() || "";
      if (teUrl && !teUrl.includes(`/${countrySlug}/`)) {
        return false;
      }
      return true;
    })
    .slice(0, params.maxReports);

  const reports = await Promise.all(
    filtered.map(async (row) => {
      const officialSource = inferOfficialSource({
        source: row.source,
        indicator: params.indicator,
        event: row.title,
        category: row.title,
        country: params.country,
      });
      const reportUrl = officialSource.officialHome;
      const reportBody =
        params.includeReportBody && reportUrl
          ? await fetchReportExcerpt({
              url: reportUrl,
              timeoutSeconds: params.timeoutSeconds,
              maxChars: params.maxReportChars,
            })
          : undefined;
      return {
        releaseDate: undefined,
        country: params.country,
        category: row.title,
        event: row.title,
        actual: undefined,
        consensus: undefined,
        previous: undefined,
        actualNumber: undefined,
        consensusNumber: undefined,
        previousNumber: undefined,
        importance: undefined,
        frequency: row.frequency,
        coverage: {
          from: row.fromYear,
          until: row.untilYear,
        },
        source: {
          provider: "web",
          sourceField: row.source,
          tradingEconomicsUrl: row.tradingEconomicsUrl,
          referenceUrl: undefined,
        },
        officialReport: {
          publisher: officialSource.publisher,
          official: officialSource.official,
          reportUrl,
          ...(reportBody ? reportBody : {}),
        },
      };
    }),
  );

  const payload = {
    provider: "web",
    action: "official_reports",
    query: {
      webIndicatorsUrl: params.webIndicatorsUrl,
      country: params.country,
      indicator: params.indicator || undefined,
      maxReports: params.maxReports,
      includeReportBody: params.includeReportBody,
      maxReportChars: params.maxReportChars,
    },
    count: reports.length,
    tookMs: Date.now() - start,
    capabilities: {
      officialLinkHints: true,
      directOfficialReference: false,
      reportBodyFetch: params.includeReportBody,
      consensus: false,
      actual: false,
      previous: false,
    },
    reports,
    note: "Web provider scrapes Trading Economics indicators page as a discovery source, then maps indicators to official publisher homes.",
  } as const;

  writeCache(REPORT_CACHE, cacheKey, payload, params.cacheTtlMs);
  return payload;
}

async function runTradingEconomicsOfficialFetch(params: {
  apiKey: string;
  baseUrl: string;
  country: string;
  indicator?: string;
  startDate: string;
  endDate: string;
  importance?: (typeof IMPORTANCE_LEVELS)[number];
  maxReports: number;
  includeReportBody: boolean;
  maxReportChars: number;
  timeoutSeconds: number;
  cacheTtlMs: number;
}) {
  const cacheKey = makeCacheKey("official_report_fetch:te", params);
  const cached = readCache(REPORT_CACHE, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }

  const start = Date.now();
  const trimmedBase = params.baseUrl.trim().replace(/\/$/, "");
  const countryPath = encodeURIComponent(params.country);
  const url = new URL(
    `${trimmedBase}/calendar/country/${countryPath}/${params.startDate}/${params.endDate}`,
  );
  url.searchParams.set("c", params.apiKey);
  url.searchParams.set("f", "json");
  if (params.importance !== undefined) {
    url.searchParams.set("importance", String(params.importance));
  }

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: withTimeout(undefined, params.timeoutSeconds * 1000),
  });
  if (!res.ok) {
    const detailResult = await readResponseText(res, { maxBytes: 64_000 });
    const detail = detailResult.text;
    throw new Error(`Trading Economics API error (${res.status}): ${detail || res.statusText}`);
  }

  const data = (await res.json()) as TradingEconomicsCalendarItem[] | Record<string, unknown>;
  const items = Array.isArray(data) ? data : [];
  const filter = params.indicator?.trim().toLowerCase() || "";

  const filtered = items
    .filter((item) => {
      if (!filter) {
        return true;
      }
      const haystack = [item.Event, item.Category].join(" ").toLowerCase();
      return haystack.includes(filter);
    })
    .toSorted((a, b) => (a.Date ?? "").localeCompare(b.Date ?? ""))
    .slice(0, params.maxReports);

  const reports = await Promise.all(
    filtered.map(async (item) => {
      const referenceUrl = resolveReportUrl(item.Reference);
      const officialSource = inferOfficialSource({
        source: item.Source,
        indicator: params.indicator,
        event: item.Event,
        category: item.Category,
        country: item.Country,
      });
      const reportUrl = referenceUrl || officialSource.officialHome;
      const reportBody =
        params.includeReportBody && reportUrl
          ? await fetchReportExcerpt({
              url: reportUrl,
              timeoutSeconds: params.timeoutSeconds,
              maxChars: params.maxReportChars,
            })
          : undefined;

      return {
        releaseDate: item.Date,
        country: item.Country,
        category: item.Category,
        event: item.Event,
        actual: item.Actual ?? undefined,
        consensus: item.Forecast ?? undefined,
        previous: item.Previous ?? undefined,
        actualNumber: parseNumericValue(item.Actual),
        consensusNumber: parseNumericValue(item.Forecast),
        previousNumber: parseNumericValue(item.Previous),
        importance: typeof item.Importance === "number" ? Math.trunc(item.Importance) : undefined,
        source: {
          provider: "tradingeconomics",
          sourceField: item.Source,
          tradingEconomicsUrl: item.URL,
          referenceUrl: item.Reference,
        },
        officialReport: {
          publisher: officialSource.publisher,
          official: officialSource.official,
          reportUrl,
          ...(reportBody ? reportBody : {}),
        },
      };
    }),
  );

  const payload = {
    provider: "tradingeconomics",
    action: "official_reports",
    query: {
      country: params.country,
      indicator: params.indicator || undefined,
      startDate: params.startDate,
      endDate: params.endDate,
      importance: params.importance,
      maxReports: params.maxReports,
      includeReportBody: params.includeReportBody,
      maxReportChars: params.maxReportChars,
    },
    count: reports.length,
    tookMs: Date.now() - start,
    capabilities: {
      officialLinkHints: true,
      directOfficialReference: true,
      reportBodyFetch: params.includeReportBody,
      consensus: true,
      actual: true,
      previous: true,
    },
    reports,
    note: "Trading Economics metadata is used to discover releases and official source links; use official report URLs as primary references.",
  } as const;

  writeCache(REPORT_CACHE, cacheKey, payload, params.cacheTtlMs);
  return payload;
}

export function createOfficialReportFetchTool(options?: {
  config?: OpenClawConfig;
  sandboxed?: boolean;
}): AnyAgentTool | null {
  const config = resolveConfig(options?.config);
  if (!resolveEnabled({ config, sandboxed: options?.sandboxed })) {
    return null;
  }

  return {
    label: "Official Report Fetch",
    name: "official_report_fetch",
    description:
      "Find recently released economic indicators and resolve likely official publisher report links, with optional report excerpt fetch.",
    parameters: OfficialReportFetchSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const provider = resolveProvider(readStringParam(params, "provider"), config);

      const daysBackDefault =
        typeof config?.defaultDaysBack === "number" && Number.isFinite(config.defaultDaysBack)
          ? Math.max(1, Math.floor(config.defaultDaysBack))
          : DEFAULT_DAYS_BACK;

      const dateRange = resolveDateRange({
        startDate: readStringParam(params, "startDate"),
        endDate: readStringParam(params, "endDate"),
        daysBack: daysBackDefault,
      });
      if ("error" in dateRange) {
        return jsonResult(dateRange.error);
      }

      const country =
        readStringParam(params, "country")?.trim() ||
        (typeof config?.defaultCountry === "string" ? config.defaultCountry.trim() : "") ||
        "united states";

      const maxReportsDefault =
        typeof config?.maxReports === "number" && Number.isFinite(config.maxReports)
          ? Math.max(1, Math.floor(config.maxReports))
          : DEFAULT_MAX_REPORTS;
      const maxReports = Math.min(
        MAX_REPORTS_CAP,
        Math.max(
          1,
          Math.floor(readNumberParam(params, "maxReports", { integer: true }) ?? maxReportsDefault),
        ),
      );

      const timeoutSeconds = resolveTimeoutSeconds(config?.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS);
      const cacheTtlMs = resolveCacheTtlMs(config?.cacheTtlMinutes, DEFAULT_CACHE_TTL_MINUTES);
      const includeReportBody = Boolean(params.includeReportBody);
      const maxReportChars = Math.min(
        MAX_REPORT_CHARS_CAP,
        Math.max(
          200,
          Math.floor(
            readNumberParam(params, "maxReportChars", { integer: true }) ??
              (typeof config?.maxReportChars === "number" && Number.isFinite(config.maxReportChars)
                ? config.maxReportChars
                : 4000),
          ),
        ),
      );

      const rawImportance = readNumberParam(params, "importance", { integer: true });
      const importance = resolveImportance(rawImportance);
      if (rawImportance !== undefined && importance === undefined) {
        return jsonResult({
          error: "invalid_importance",
          message: "importance must be 1, 2, or 3.",
        });
      }

      if (provider === "web") {
        const result = await runWebOfficialFetch({
          webIndicatorsUrl: resolveWebIndicatorsUrl(config),
          country,
          indicator: readStringParam(params, "indicator"),
          maxReports,
          includeReportBody,
          maxReportChars,
          timeoutSeconds,
          cacheTtlMs,
        });
        return jsonResult(result);
      }

      const apiKey = resolveTradingEconomicsApiKey(config);
      if (!apiKey) {
        return jsonResult(missingKeyPayload());
      }

      const result = await runTradingEconomicsOfficialFetch({
        apiKey,
        baseUrl: resolveBaseUrl(config),
        country,
        indicator: readStringParam(params, "indicator"),
        startDate: dateRange.startDate,
        endDate: dateRange.endDate,
        importance,
        maxReports,
        includeReportBody,
        maxReportChars,
        timeoutSeconds,
        cacheTtlMs,
      });
      return jsonResult(result);
    },
  };
}

export const __testing = {
  parseNumericValue,
  resolveDateRange,
  resolveImportance,
  inferOfficialSource,
  resolveReportUrl,
  resolveProvider,
  parseIndicatorsRowsFromHtml,
};
