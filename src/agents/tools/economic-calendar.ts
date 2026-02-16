import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import type { AnyAgentTool } from "./common.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import { stringEnum } from "../schema/typebox.js";
import { jsonResult, readNumberParam, readStringArrayParam, readStringParam } from "./common.js";
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

const PROVIDERS = ["fred", "bls", "tradingeconomics"] as const;
const DEFAULT_PROVIDER: (typeof PROVIDERS)[number] = "fred";

const ACTIONS = ["calendar", "series"] as const;
const DEFAULT_ACTION: (typeof ACTIONS)[number] = "calendar";

const DEFAULT_TRADING_ECONOMICS_BASE_URL = "https://api.tradingeconomics.com";
const DEFAULT_FRED_BASE_URL = "https://api.stlouisfed.org/fred";
const DEFAULT_BLS_BASE_URL = "https://api.bls.gov/publicAPI/v2";

const DEFAULT_DAYS_AHEAD = 7;
const DEFAULT_MAX_EVENTS = 50;
const MAX_EVENTS_CAP = 200;
const IMPORTANCE_LEVELS = [1, 2, 3] as const;

const CALENDAR_CACHE = new Map<string, CacheEntry<Record<string, unknown>>>();

const EconomicCalendarSchema = Type.Object({
  provider: Type.Optional(
    stringEnum(PROVIDERS, {
      description: 'Data provider ("fred", "bls", or "tradingeconomics"). Default: "fred".',
      default: DEFAULT_PROVIDER,
    }),
  ),
  action: Type.Optional(
    stringEnum(ACTIONS, {
      description:
        'Action mode: "calendar" for release schedule, "series" for numeric time series.',
      default: DEFAULT_ACTION,
    }),
  ),
  country: Type.Optional(
    Type.String({
      description:
        "Country filter for Trading Economics only. Use one country or comma-separated list.",
    }),
  ),
  startDate: Type.Optional(
    Type.String({
      description: "Start date in YYYY-MM-DD format. Defaults to today (UTC).",
    }),
  ),
  endDate: Type.Optional(
    Type.String({
      description: "End date in YYYY-MM-DD format. Defaults to startDate + 7 days (UTC).",
    }),
  ),
  importance: Type.Optional(
    Type.Number({
      description: "Trading Economics importance level (1=low, 2=medium, 3=high).",
      minimum: 1,
      maximum: 3,
    }),
  ),
  event: Type.Optional(
    Type.String({
      description: "Optional case-insensitive event/release name filter.",
    }),
  ),
  maxEvents: Type.Optional(
    Type.Number({
      description: "Maximum rows to return (1-200).",
      minimum: 1,
      maximum: MAX_EVENTS_CAP,
    }),
  ),
  seriesIds: Type.Optional(
    Type.Array(
      Type.String({
        description:
          "Series IDs for action=series. FRED examples: CPIAUCSL, UNRATE. BLS example: CUUR0000SA0.",
      }),
      {
        minItems: 1,
        maxItems: 50,
      },
    ),
  ),
});

type EconomicCalendarConfig = NonNullable<OpenClawConfig["tools"]>["web"] extends infer Web
  ? Web extends { economicCalendar?: infer Calendar }
    ? Calendar
    : undefined
  : undefined;

type TradingEconomicsCalendarItem = {
  CalendarId?: string | number;
  Date?: string;
  Country?: string;
  Category?: string;
  Event?: string;
  Actual?: string | number | null;
  Previous?: string | number | null;
  Forecast?: string | number | null;
  TEForecast?: string | number | null;
  Importance?: number | string;
  Currency?: string;
  Unit?: string;
  Source?: string;
  Reference?: string;
  URL?: string;
  LastUpdate?: string;
};

type FredReleaseDate = {
  release_id?: number;
  release_name?: string;
  date?: string;
};

type FredReleasesDatesResponse = {
  release_dates?: FredReleaseDate[];
};

type FredObservation = {
  date?: string;
  value?: string;
};

type FredSeriesObservationsResponse = {
  observations?: FredObservation[];
};

type BlsSeriesDatum = {
  year?: string;
  period?: string;
  periodName?: string;
  value?: string;
  footnotes?: Array<{ code?: string; text?: string }>;
};

type BlsSeries = {
  seriesID?: string;
  data?: BlsSeriesDatum[];
};

type BlsResponse = {
  status?: string;
  message?: string[];
  Results?: {
    series?: BlsSeries[];
  };
};

function resolveCalendarConfig(cfg?: OpenClawConfig): EconomicCalendarConfig {
  const economicCalendar = cfg?.tools?.web?.economicCalendar;
  if (!economicCalendar || typeof economicCalendar !== "object") {
    return undefined;
  }
  return economicCalendar as EconomicCalendarConfig;
}

function resolveCalendarEnabled(params: {
  calendar?: EconomicCalendarConfig;
  sandboxed?: boolean;
}): boolean {
  if (typeof params.calendar?.enabled === "boolean") {
    return params.calendar.enabled;
  }
  return true;
}

function resolveBaseUrl(
  provider: (typeof PROVIDERS)[number],
  calendar?: EconomicCalendarConfig,
): string {
  const fromConfig =
    calendar && "baseUrl" in calendar && typeof calendar.baseUrl === "string"
      ? calendar.baseUrl.trim()
      : "";
  if (fromConfig) {
    return fromConfig;
  }
  if (provider === "bls") {
    return DEFAULT_BLS_BASE_URL;
  }
  if (provider === "fred") {
    return DEFAULT_FRED_BASE_URL;
  }
  return DEFAULT_TRADING_ECONOMICS_BASE_URL;
}

function resolveProvider(
  value: unknown,
  calendar?: EconomicCalendarConfig,
): (typeof PROVIDERS)[number] {
  const fromArgs = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (fromArgs === "fred" || fromArgs === "bls" || fromArgs === "tradingeconomics") {
    return fromArgs;
  }
  const fromConfig =
    calendar && "provider" in calendar && typeof calendar.provider === "string"
      ? calendar.provider.trim().toLowerCase()
      : "";
  if (fromConfig === "fred" || fromConfig === "bls" || fromConfig === "tradingeconomics") {
    return fromConfig;
  }
  return DEFAULT_PROVIDER;
}

function resolveAction(value: unknown): (typeof ACTIONS)[number] {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === "series") {
    return "series";
  }
  return "calendar";
}

function resolveTradingEconomicsApiKey(calendar?: EconomicCalendarConfig): string | undefined {
  const fromConfig =
    calendar && "apiKey" in calendar && typeof calendar.apiKey === "string"
      ? normalizeSecretInput(calendar.apiKey)
      : "";
  const fromEnv = normalizeSecretInput(process.env.TRADING_ECONOMICS_API_KEY);
  return fromConfig || fromEnv || undefined;
}

function resolveFredApiKey(calendar?: EconomicCalendarConfig): string | undefined {
  const fromConfig =
    calendar && "fredApiKey" in calendar && typeof calendar.fredApiKey === "string"
      ? normalizeSecretInput(calendar.fredApiKey)
      : "";
  const fromEnv = normalizeSecretInput(process.env.FRED_API_KEY);
  return fromConfig || fromEnv || undefined;
}

function resolveBlsApiKey(calendar?: EconomicCalendarConfig): string | undefined {
  const fromConfig =
    calendar && "blsApiKey" in calendar && typeof calendar.blsApiKey === "string"
      ? normalizeSecretInput(calendar.blsApiKey)
      : "";
  const fromEnv = normalizeSecretInput(
    process.env.BLS_API_KEY || process.env.BLS_PUBLIC_DATA_API_KEY,
  );
  return fromConfig || fromEnv || undefined;
}

function missingKeyPayload(provider: (typeof PROVIDERS)[number]) {
  if (provider === "tradingeconomics") {
    return {
      error: "missing_trading_economics_api_key",
      message: `economic_calendar (tradingeconomics) needs an API key. Set TRADING_ECONOMICS_API_KEY, or configure tools.web.economicCalendar.apiKey (for example via \`${formatCliCommand("openclaw configure --section web")}\`).`,
      docs: "https://docs.tradingeconomics.com/get_started/",
    };
  }
  if (provider === "fred") {
    return {
      error: "missing_fred_api_key",
      message:
        "economic_calendar (fred) needs a free FRED API key. Set FRED_API_KEY or tools.web.economicCalendar.fredApiKey.",
      docs: "https://fred.stlouisfed.org/docs/api/fred/api_key.html",
    };
  }
  return {
    error: "missing_bls_api_key",
    message:
      "economic_calendar (bls) can run without a key for light usage, but for reliability set BLS_API_KEY or tools.web.economicCalendar.blsApiKey.",
    docs: "https://www.bls.gov/developers/",
  };
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

function formatUtcDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const d = `${date.getUTCDate()}`.padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addUtcDays(start: string, days: number): string {
  const [year, month, day] = start.split("-").map((part) => Number.parseInt(part, 10));
  const date = new Date(Date.UTC(year, month - 1, day + Math.max(0, Math.floor(days))));
  return formatUtcDate(date);
}

function resolveDateRange(params: {
  startDate?: string;
  endDate?: string;
  daysAhead: number;
}): { startDate: string; endDate: string } | { error: Record<string, unknown> } {
  const today = formatUtcDate(new Date());
  const startDate = params.startDate?.trim() || today;
  if (!isValidIsoDate(startDate)) {
    return {
      error: {
        error: "invalid_start_date",
        message: "startDate must be in YYYY-MM-DD format.",
      },
    };
  }

  const defaultEndDate = addUtcDays(startDate, params.daysAhead);
  const endDate = params.endDate?.trim() || defaultEndDate;
  if (!isValidIsoDate(endDate)) {
    return {
      error: {
        error: "invalid_end_date",
        message: "endDate must be in YYYY-MM-DD format.",
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

function resolveCountries(value: string | undefined, fallbackCountry?: string): string[] {
  const source = value?.trim() || fallbackCountry?.trim() || "all";
  const countries = source
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return countries.length > 0 ? countries : ["all"];
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

function normalizeImportance(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.trunc(raw);
  }
  if (typeof raw === "string") {
    const parsed = Number.parseInt(raw.trim(), 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function normalizeTradingEconomicsEvent(item: TradingEconomicsCalendarItem) {
  return {
    calendarId: item.CalendarId,
    date: item.Date,
    country: item.Country,
    category: item.Category,
    event: item.Event,
    actual: item.Actual ?? undefined,
    consensus: item.Forecast ?? undefined,
    previous: item.Previous ?? undefined,
    teForecast: item.TEForecast ?? undefined,
    actualNumber: parseNumericValue(item.Actual),
    consensusNumber: parseNumericValue(item.Forecast),
    previousNumber: parseNumericValue(item.Previous),
    importance: normalizeImportance(item.Importance),
    currency: item.Currency,
    unit: item.Unit,
    source: item.Source,
    reference: item.Reference,
    url: item.URL,
    lastUpdate: item.LastUpdate,
  };
}

function makeCacheKey(prefix: string, params: Record<string, unknown>): string {
  return normalizeCacheKey(`${prefix}:${JSON.stringify(params)}`);
}

async function runTradingEconomicsCalendar(params: {
  apiKey: string;
  baseUrl: string;
  countries: string[];
  startDate: string;
  endDate: string;
  importance?: (typeof IMPORTANCE_LEVELS)[number];
  eventFilter?: string;
  maxEvents: number;
  timeoutSeconds: number;
  cacheTtlMs: number;
}) {
  const cacheKey = makeCacheKey("economic_calendar:te", params);
  const cached = readCache(CALENDAR_CACHE, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }

  const countriesPath = params.countries.map((country) => encodeURIComponent(country)).join(",");
  const trimmedBase = params.baseUrl.trim().replace(/\/$/, "");
  const url = new URL(
    `${trimmedBase}/calendar/country/${countriesPath}/${params.startDate}/${params.endDate}`,
  );
  url.searchParams.set("c", params.apiKey);
  url.searchParams.set("f", "json");
  if (params.importance !== undefined) {
    url.searchParams.set("importance", String(params.importance));
  }

  const start = Date.now();
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
  const eventFilter = params.eventFilter?.trim().toLowerCase() || "";

  const events = items
    .map(normalizeTradingEconomicsEvent)
    .filter((item) => !eventFilter || item.event?.toLowerCase().includes(eventFilter))
    .toSorted((a, b) => (a.date ?? "").localeCompare(b.date ?? ""))
    .slice(0, params.maxEvents);

  const payload = {
    provider: "tradingeconomics",
    action: "calendar",
    query: {
      countries: params.countries,
      startDate: params.startDate,
      endDate: params.endDate,
      importance: params.importance,
      event: params.eventFilter || undefined,
      maxEvents: params.maxEvents,
    },
    count: events.length,
    tookMs: Date.now() - start,
    capabilities: {
      actual: true,
      consensus: true,
      previous: true,
      official: false,
    },
    events,
  } as const;

  writeCache(CALENDAR_CACHE, cacheKey, payload, params.cacheTtlMs);
  return payload;
}

async function runFredCalendar(params: {
  apiKey: string;
  baseUrl: string;
  startDate: string;
  endDate: string;
  eventFilter?: string;
  maxEvents: number;
  timeoutSeconds: number;
  cacheTtlMs: number;
}) {
  const cacheKey = makeCacheKey("economic_calendar:fred:calendar", params);
  const cached = readCache(CALENDAR_CACHE, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }

  const trimmedBase = params.baseUrl.trim().replace(/\/$/, "");
  const url = new URL(`${trimmedBase}/releases/dates`);
  url.searchParams.set("api_key", params.apiKey);
  url.searchParams.set("file_type", "json");
  url.searchParams.set("limit", "1000");
  url.searchParams.set("sort_order", "asc");

  const start = Date.now();
  const res = await fetch(url.toString(), {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: withTimeout(undefined, params.timeoutSeconds * 1000),
  });
  if (!res.ok) {
    const detailResult = await readResponseText(res, { maxBytes: 64_000 });
    const detail = detailResult.text;
    throw new Error(`FRED API error (${res.status}): ${detail || res.statusText}`);
  }

  const data = (await res.json()) as FredReleasesDatesResponse;
  const allDates = Array.isArray(data.release_dates) ? data.release_dates : [];
  const eventFilter = params.eventFilter?.trim().toLowerCase() || "";

  const events = allDates
    .filter((entry) => {
      const date = entry.date?.trim() || "";
      if (!date || date < params.startDate || date > params.endDate) {
        return false;
      }
      if (!eventFilter) {
        return true;
      }
      const name = entry.release_name?.toLowerCase() || "";
      return name.includes(eventFilter);
    })
    .slice(0, params.maxEvents)
    .map((entry) => ({
      calendarId: entry.release_id,
      date: entry.date,
      event: entry.release_name,
      source: "FRED",
      actual: undefined,
      consensus: undefined,
      previous: undefined,
      actualNumber: undefined,
      consensusNumber: undefined,
      previousNumber: undefined,
      note: "FRED release calendar provides schedule metadata; consensus is not provided.",
    }));

  const payload = {
    provider: "fred",
    action: "calendar",
    query: {
      startDate: params.startDate,
      endDate: params.endDate,
      event: params.eventFilter || undefined,
      maxEvents: params.maxEvents,
    },
    count: events.length,
    tookMs: Date.now() - start,
    capabilities: {
      actual: false,
      consensus: false,
      previous: false,
      official: true,
    },
    events,
  } as const;

  writeCache(CALENDAR_CACHE, cacheKey, payload, params.cacheTtlMs);
  return payload;
}

async function runFredSeries(params: {
  apiKey: string;
  baseUrl: string;
  seriesIds: string[];
  startDate: string;
  endDate: string;
  maxEvents: number;
  timeoutSeconds: number;
  cacheTtlMs: number;
}) {
  const cacheKey = makeCacheKey("economic_calendar:fred:series", params);
  const cached = readCache(CALENDAR_CACHE, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }

  const trimmedBase = params.baseUrl.trim().replace(/\/$/, "");
  const start = Date.now();

  const seriesResults = await Promise.all(
    params.seriesIds.slice(0, params.maxEvents).map(async (seriesId) => {
      const url = new URL(`${trimmedBase}/series/observations`);
      url.searchParams.set("api_key", params.apiKey);
      url.searchParams.set("file_type", "json");
      url.searchParams.set("series_id", seriesId);
      url.searchParams.set("observation_start", params.startDate);
      url.searchParams.set("observation_end", params.endDate);
      url.searchParams.set("sort_order", "asc");

      const res = await fetch(url.toString(), {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: withTimeout(undefined, params.timeoutSeconds * 1000),
      });
      if (!res.ok) {
        const detailResult = await readResponseText(res, { maxBytes: 64_000 });
        const detail = detailResult.text;
        throw new Error(
          `FRED series API error (${res.status}) for ${seriesId}: ${detail || res.statusText}`,
        );
      }

      const data = (await res.json()) as FredSeriesObservationsResponse;
      const observations = Array.isArray(data.observations) ? data.observations : [];
      const last = observations.length > 0 ? observations[observations.length - 1] : undefined;
      const valueText = last?.value;
      const numeric = valueText === "." ? undefined : parseNumericValue(valueText);
      return {
        seriesId,
        lastDate: last?.date,
        actual: valueText === "." ? undefined : valueText,
        actualNumber: numeric,
        consensus: undefined,
        consensusNumber: undefined,
        previous:
          observations.length > 1 ? observations[observations.length - 2]?.value : undefined,
        previousNumber:
          observations.length > 1
            ? parseNumericValue(observations[observations.length - 2]?.value)
            : undefined,
        source: "FRED",
      };
    }),
  );

  const payload = {
    provider: "fred",
    action: "series",
    query: {
      seriesIds: params.seriesIds,
      startDate: params.startDate,
      endDate: params.endDate,
    },
    count: seriesResults.length,
    tookMs: Date.now() - start,
    capabilities: {
      actual: true,
      consensus: false,
      previous: true,
      official: true,
    },
    series: seriesResults,
    note: "FRED does not provide market consensus forecasts in this endpoint.",
  } as const;

  writeCache(CALENDAR_CACHE, cacheKey, payload, params.cacheTtlMs);
  return payload;
}

function formatBlsDate(datum: BlsSeriesDatum | undefined): string | undefined {
  if (!datum?.year || !datum?.period) {
    return undefined;
  }
  const period = datum.period.trim();
  if (/^M\d{2}$/.test(period)) {
    return `${datum.year}-${period.slice(1)}-01`;
  }
  return `${datum.year}-${period}`;
}

async function runBlsSeries(params: {
  apiKey?: string;
  baseUrl: string;
  seriesIds: string[];
  startDate: string;
  endDate: string;
  timeoutSeconds: number;
  cacheTtlMs: number;
}) {
  const cacheKey = makeCacheKey("economic_calendar:bls:series", params);
  const cached = readCache(CALENDAR_CACHE, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }

  const startYear = params.startDate.slice(0, 4);
  const endYear = params.endDate.slice(0, 4);
  const body: Record<string, unknown> = {
    seriesid: params.seriesIds,
    startyear: startYear,
    endyear: endYear,
  };
  if (params.apiKey) {
    body.registrationkey = params.apiKey;
  }

  const trimmedBase = params.baseUrl.trim().replace(/\/$/, "");
  const endpoint = `${trimmedBase}/timeseries/data/`;
  const start = Date.now();

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
    signal: withTimeout(undefined, params.timeoutSeconds * 1000),
  });
  if (!res.ok) {
    const detailResult = await readResponseText(res, { maxBytes: 64_000 });
    const detail = detailResult.text;
    throw new Error(`BLS API error (${res.status}): ${detail || res.statusText}`);
  }

  const data = (await res.json()) as BlsResponse;
  const results = Array.isArray(data.Results?.series) ? data.Results.series : [];
  const series = results.map((entry) => {
    const points = Array.isArray(entry.data) ? entry.data : [];
    const first = points[0];
    const second = points[1];
    const actual = first?.value;
    const previous = second?.value;
    return {
      seriesId: entry.seriesID,
      lastDate: formatBlsDate(first),
      periodName: first?.periodName,
      actual,
      actualNumber: parseNumericValue(actual),
      consensus: undefined,
      consensusNumber: undefined,
      previous,
      previousNumber: parseNumericValue(previous),
      source: "BLS",
    };
  });

  const payload = {
    provider: "bls",
    action: "series",
    query: {
      seriesIds: params.seriesIds,
      startDate: params.startDate,
      endDate: params.endDate,
    },
    count: series.length,
    tookMs: Date.now() - start,
    capabilities: {
      actual: true,
      consensus: false,
      previous: true,
      official: true,
    },
    series,
    note: "BLS API provides official values but not market consensus forecasts.",
    apiStatus: data.status,
    apiMessages: data.message,
  } as const;

  writeCache(CALENDAR_CACHE, cacheKey, payload, params.cacheTtlMs);
  return payload;
}

export function createEconomicCalendarTool(options?: {
  config?: OpenClawConfig;
  sandboxed?: boolean;
}): AnyAgentTool | null {
  const calendar = resolveCalendarConfig(options?.config);
  if (!resolveCalendarEnabled({ calendar, sandboxed: options?.sandboxed })) {
    return null;
  }

  return {
    label: "Economic Calendar",
    name: "economic_calendar",
    description:
      "Fetch official economic calendar/time-series data using FRED or BLS (free), with optional Trading Economics support.",
    parameters: EconomicCalendarSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const provider = resolveProvider(params.provider, calendar);
      const action = resolveAction(params.action);

      const startDate = readStringParam(params, "startDate");
      const endDate = readStringParam(params, "endDate");
      const dateRange = resolveDateRange({
        startDate,
        endDate,
        daysAhead:
          typeof calendar?.defaultDaysAhead === "number" &&
          Number.isFinite(calendar.defaultDaysAhead)
            ? Math.max(0, Math.floor(calendar.defaultDaysAhead))
            : DEFAULT_DAYS_AHEAD,
      });
      if ("error" in dateRange) {
        return jsonResult(dateRange.error);
      }

      const maxEventsDefault =
        typeof calendar?.maxEvents === "number" && Number.isFinite(calendar.maxEvents)
          ? Math.max(1, Math.floor(calendar.maxEvents))
          : DEFAULT_MAX_EVENTS;
      const maxEvents = Math.min(
        MAX_EVENTS_CAP,
        Math.max(
          1,
          Math.floor(readNumberParam(params, "maxEvents", { integer: true }) ?? maxEventsDefault),
        ),
      );

      const timeoutSeconds = resolveTimeoutSeconds(
        calendar?.timeoutSeconds,
        DEFAULT_TIMEOUT_SECONDS,
      );
      const cacheTtlMs = resolveCacheTtlMs(calendar?.cacheTtlMinutes, DEFAULT_CACHE_TTL_MINUTES);

      if (provider === "tradingeconomics") {
        const apiKey = resolveTradingEconomicsApiKey(calendar);
        if (!apiKey) {
          return jsonResult(missingKeyPayload(provider));
        }

        const rawImportance = readNumberParam(params, "importance", { integer: true });
        const importance = resolveImportance(rawImportance);
        if (rawImportance !== undefined && importance === undefined) {
          return jsonResult({
            error: "invalid_importance",
            message: "importance must be 1, 2, or 3.",
          });
        }

        const countries = resolveCountries(
          readStringParam(params, "country"),
          typeof calendar?.defaultCountry === "string" ? calendar.defaultCountry : undefined,
        );
        const result = await runTradingEconomicsCalendar({
          apiKey,
          baseUrl: resolveBaseUrl(provider, calendar),
          countries,
          startDate: dateRange.startDate,
          endDate: dateRange.endDate,
          importance,
          eventFilter: readStringParam(params, "event"),
          maxEvents,
          timeoutSeconds,
          cacheTtlMs,
        });
        return jsonResult(result);
      }

      if (provider === "fred") {
        const apiKey = resolveFredApiKey(calendar);
        if (!apiKey) {
          return jsonResult(missingKeyPayload(provider));
        }
        if (action === "calendar") {
          const result = await runFredCalendar({
            apiKey,
            baseUrl: resolveBaseUrl(provider, calendar),
            startDate: dateRange.startDate,
            endDate: dateRange.endDate,
            eventFilter: readStringParam(params, "event"),
            maxEvents,
            timeoutSeconds,
            cacheTtlMs,
          });
          return jsonResult(result);
        }

        const seriesIds = readStringArrayParam(params, "seriesIds", {
          required: true,
          label: "seriesIds",
        });
        const result = await runFredSeries({
          apiKey,
          baseUrl: resolveBaseUrl(provider, calendar),
          seriesIds,
          startDate: dateRange.startDate,
          endDate: dateRange.endDate,
          maxEvents,
          timeoutSeconds,
          cacheTtlMs,
        });
        return jsonResult(result);
      }

      // BLS
      if (action === "calendar") {
        return jsonResult({
          error: "unsupported_action",
          message:
            'BLS official API is supported for action="series". For calendar schedule use provider="fred" with action="calendar".',
        });
      }
      const seriesIds = readStringArrayParam(params, "seriesIds", {
        required: true,
        label: "seriesIds",
      });
      const result = await runBlsSeries({
        apiKey: resolveBlsApiKey(calendar),
        baseUrl: resolveBaseUrl(provider, calendar),
        seriesIds,
        startDate: dateRange.startDate,
        endDate: dateRange.endDate,
        timeoutSeconds,
        cacheTtlMs,
      });
      return jsonResult(result);
    },
  };
}

export const __testing = {
  parseNumericValue,
  resolveCountries,
  resolveDateRange,
  resolveImportance,
  normalizeTradingEconomicsEvent,
  resolveProvider,
  resolveAction,
} as const;
