import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { CliDeps } from "../cli/deps.js";
import type { OpenClawConfig } from "../config/config.js";
import type { AnalysisRunRow, ReleaseEventRow, ReleaseState, ReleaseStatusRow } from "./types.js";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { createEconomicCalendarTool } from "../agents/tools/economic-calendar.js";
import { createOfficialReportFetchTool } from "../agents/tools/official-report-fetch.js";
import { createWebFetchTool } from "../agents/tools/web-fetch.js";
import { createOutboundSendDeps } from "../cli/outbound-send-deps.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { readJsonFile, writeJsonAtomic } from "../infra/json-files.js";
import { deliverOutboundPayloads } from "../infra/outbound/deliver.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runOneShotJsonPrompt, runOneShotTextPrompt } from "./llm.js";
import { fetchReutersMedia } from "./reuters.js";
import {
  readReleaseEngineStore,
  resolveReleaseEngineDir,
  resolveReleaseEngineStorePath,
  updateReleaseEngineStore,
} from "./store.js";

const log = createSubsystemLogger("release-engine");

const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 60 * 60_000;
const DEFAULT_POLL_MS = 60_000;
const DEFAULT_MAX_RETRIES = 8;
const DEFAULT_HISTORY_DAYS = 220;

type RunnerConfig = {
  enabled: boolean;
  pollMs: number;
  maxRetries: number;
  country: string;
  indicator: string;
  agentId: string;
  telegramTarget?: string;
  telegramAccountId?: string;
  preprocessModelRef?: string;
  analysisModelRef?: string;
  historyDays: number;
};

type MacroReleaseRunnerState = {
  cfg: OpenClawConfig;
  deps: CliDeps;
  timer: NodeJS.Timeout | null;
  running: boolean;
  stopped: boolean;
  runtime: RunnerConfig;
  storePath: string;
};

export type MacroReleaseRunner = {
  stop: () => void;
  updateConfig: (cfg: OpenClawConfig) => void;
};

function parseIntegerEnv(
  value: string | undefined,
  fallback: number,
  bounds: { min: number; max: number },
): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(bounds.max, Math.max(bounds.min, parsed));
}

function toDateOnly(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : undefined;
}

function addUtcDays(dateIso: string, days: number): string {
  const [year, month, day] = dateIso.split("-").map((part) => Number.parseInt(part, 10));
  const out = new Date(Date.UTC(year, month - 1, day + days));
  const y = out.getUTCFullYear();
  const m = `${out.getUTCMonth() + 1}`.padStart(2, "0");
  const d = `${out.getUTCDate()}`.padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function nowDateIso(nowMs = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(asRecord).filter((entry): entry is Record<string, unknown> => entry !== null);
}

function readStringField(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumberField(row: Record<string, unknown>, key: string): number | undefined {
  const value = row[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

function hashString(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function hashObject(input: unknown): string {
  return hashString(JSON.stringify(input));
}

function computeBackoffDelayMs(nextRetryCount: number): number {
  const exp = Math.max(0, nextRetryCount - 1);
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** exp);
}

function isLikelyUsCpiEvent(eventName?: string, category?: string): boolean {
  const text = [eventName, category].filter(Boolean).join(" ").toLowerCase();
  if (!text) {
    return false;
  }
  return (
    text.includes("consumer price index") ||
    text.includes("cpi") ||
    text.includes("inflation rate yoy") ||
    text.includes("inflation rate mom") ||
    text.includes("core inflation rate")
  );
}

function truncateForPrompt(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}\n...(truncated)`;
}

function formatScalar(value: unknown): string {
  if (value === null || value === undefined) {
    return "n/a";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "n/a";
  }
}

function resolveRunnerConfig(cfg: OpenClawConfig): RunnerConfig {
  const agentId =
    process.env.OPENCLAW_RELEASE_ENGINE_AGENT_ID?.trim() || resolveDefaultAgentId(cfg);
  return {
    enabled: isTruthyEnvValue(process.env.OPENCLAW_RELEASE_ENGINE_ENABLED),
    pollMs: parseIntegerEnv(process.env.OPENCLAW_RELEASE_ENGINE_POLL_MS, DEFAULT_POLL_MS, {
      min: 10_000,
      max: 5 * 60_000,
    }),
    maxRetries: parseIntegerEnv(
      process.env.OPENCLAW_RELEASE_ENGINE_MAX_RETRIES,
      DEFAULT_MAX_RETRIES,
      {
        min: 1,
        max: 32,
      },
    ),
    country: process.env.OPENCLAW_RELEASE_ENGINE_COUNTRY?.trim() || "united states",
    indicator: process.env.OPENCLAW_RELEASE_ENGINE_INDICATOR?.trim() || "CPI",
    agentId,
    telegramTarget: process.env.OPENCLAW_RELEASE_ENGINE_TELEGRAM_TARGET?.trim() || undefined,
    telegramAccountId: process.env.OPENCLAW_RELEASE_ENGINE_TELEGRAM_ACCOUNT_ID?.trim() || undefined,
    preprocessModelRef: process.env.OPENCLAW_RELEASE_ENGINE_PREPROCESS_MODEL?.trim() || undefined,
    analysisModelRef: process.env.OPENCLAW_RELEASE_ENGINE_ANALYSIS_MODEL?.trim() || undefined,
    historyDays: parseIntegerEnv(
      process.env.OPENCLAW_RELEASE_ENGINE_HISTORY_DAYS,
      DEFAULT_HISTORY_DAYS,
      {
        min: 30,
        max: 730,
      },
    ),
  };
}

function stateIsTerminal(state: ReleaseState): boolean {
  return state === "published" || state === "failed_terminal";
}

function isDue(status: ReleaseStatusRow, nowIso: string): boolean {
  if (!status.nextAttemptAt) {
    return true;
  }
  return status.nextAttemptAt <= nowIso;
}

function resolveRunDir(baseDir: string, eventId: string, runId: string): string {
  return path.join(baseDir, "snapshots", eventId, runId);
}

async function writeRunJson(runDir: string, fileName: string, payload: unknown): Promise<string> {
  const outPath = path.join(runDir, fileName);
  await fs.mkdir(runDir, { recursive: true });
  await writeJsonAtomic(outPath, payload);
  return outPath;
}

async function writeRunText(runDir: string, fileName: string, content: string): Promise<string> {
  const outPath = path.join(runDir, fileName);
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(outPath, content, "utf8");
  return outPath;
}

async function readRunJson(
  runDir: string,
  fileName: string,
): Promise<Record<string, unknown> | null> {
  const value = await readJsonFile<unknown>(path.join(runDir, fileName));
  return asRecord(value);
}

async function updateRunManifest(runDir: string, patch: Record<string, unknown>): Promise<void> {
  const manifestPath = path.join(runDir, "manifest.json");
  const current = (await readJsonFile<unknown>(manifestPath)) ?? {};
  const currentRecord = asRecord(current) ?? {};
  const next = {
    ...currentRecord,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(manifestPath, next);
}

function createEventId(eventKey: string): string {
  return hashString(eventKey).slice(0, 16);
}

function resolveEventKey(item: Record<string, unknown>): string {
  const date = toDateOnly(readStringField(item, "date")) || "unknown-date";
  const country = readStringField(item, "country")?.toLowerCase() || "unknown-country";
  const event = readStringField(item, "event")?.toLowerCase() || "unknown-event";
  const calendarId = String(readNumberField(item, "calendarId") ?? "");
  return `${date}|${country}|${event}|${calendarId}`;
}

function normalizeEventRow(item: Record<string, unknown>, nowIso: string): ReleaseEventRow {
  const eventKey = resolveEventKey(item);
  const id = createEventId(eventKey);
  return {
    id,
    eventKey,
    discoveredAt: nowIso,
    updatedAt: nowIso,
    source: "tradingeconomics",
    calendarId: readNumberField(item, "calendarId"),
    date: readStringField(item, "date"),
    country: readStringField(item, "country"),
    event: readStringField(item, "event"),
    category: readStringField(item, "category"),
    actual: item.actual as string | number | undefined,
    consensus: item.consensus as string | number | undefined,
    previous: item.previous as string | number | undefined,
    actualNumber: readNumberField(item, "actualNumber"),
    consensusNumber: readNumberField(item, "consensusNumber"),
    previousNumber: readNumberField(item, "previousNumber"),
    importance: readNumberField(item, "importance"),
    currency: readStringField(item, "currency"),
    unit: readStringField(item, "unit"),
    reference: readStringField(item, "reference"),
    url: readStringField(item, "url"),
    raw: item,
  };
}

function buildOfficialFallbackCards(params: {
  event: ReleaseEventRow;
  officialText?: string;
}): Record<string, unknown> {
  const surprise =
    typeof params.event.actualNumber === "number" &&
    typeof params.event.consensusNumber === "number"
      ? params.event.actualNumber - params.event.consensusNumber
      : undefined;
  return {
    headline_numbers: {
      actual: params.event.actual ?? params.event.actualNumber,
      consensus: params.event.consensus ?? params.event.consensusNumber,
      previous: params.event.previous ?? params.event.previousNumber,
      surprise,
    },
    breakdown: {},
    notable_phrases: params.officialText
      ? truncateForPrompt(params.officialText, 400)
          .split(".")
          .map((entry) => entry.trim())
          .filter(Boolean)
          .slice(0, 3)
      : [],
    risks_or_caveats: params.officialText ? [] : ["official_text_unavailable"],
  };
}

function buildMediaFallbackCards(mediaText?: string): Record<string, unknown> {
  const claims = (mediaText ?? "")
    .split(".")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((entry) => ({ claim: entry }));
  return { claims };
}

function buildFallbackAnalysis(params: {
  event: ReleaseEventRow;
  officialCards: Record<string, unknown>;
  mediaCards: Record<string, unknown>;
  history: Record<string, unknown>[];
}): string {
  const headlineNumbers = asRecord(params.officialCards.headline_numbers) ?? {};
  const actual =
    headlineNumbers.actual ?? params.event.actual ?? params.event.actualNumber ?? "n/a";
  const consensus =
    headlineNumbers.consensus ?? params.event.consensus ?? params.event.consensusNumber ?? "n/a";
  const previous =
    headlineNumbers.previous ?? params.event.previous ?? params.event.previousNumber ?? "n/a";
  const historySummary = params.history
    .slice(0, 6)
    .map(
      (entry) =>
        `${readStringField(entry, "date") ?? "unknown"}: ${readStringField(entry, "event") ?? ""}`,
    )
    .join("; ");
  return [
    "## 1) Headline Surprise",
    `US CPI release: actual ${formatScalar(actual)}, consensus ${formatScalar(consensus)}, previous ${formatScalar(previous)}.`,
    "",
    "## 2) Component Signal",
    "Official evidence cards indicate the headline print and decomposition signals should drive near-term inflation interpretation.",
    "",
    "## 3) Revision and Trend",
    `Recent release memory (up to 6 prints): ${historySummary || "not available"}.`,
    "",
    "## 4) Rates and Policy",
    "If inflation surprise is positive versus consensus, rate-cut pricing may reprice later; downside surprises support earlier easing expectations.",
    "",
    "## 5) FX and Risk Assets",
    "A hotter print is generally USD-supportive and can pressure duration-sensitive risk assets; a cooler print can invert that mix.",
    "",
    "## 6) Risks and Watch Items",
    "Watch shelter/services stickiness, base effects, and any revisions that alter the inferred disinflation path.",
    "",
  ].join("\n");
}

async function ensureRunRecord(params: {
  storePath: string;
  status: ReleaseStatusRow;
  nowIso: string;
}): Promise<string> {
  if (params.status.currentRunId) {
    return params.status.currentRunId;
  }
  const runId = `run-${Date.now()}-${randomUUID().slice(0, 8)}`;
  await updateReleaseEngineStore({
    storePath: params.storePath,
    nowIso: params.nowIso,
    update: (store) => {
      const status = store.release_status.find((entry) => entry.eventId === params.status.eventId);
      if (!status) {
        return;
      }
      status.currentRunId = runId;
      status.updatedAt = params.nowIso;
      store.analysis_runs.push({
        runId,
        eventId: status.eventId,
        status: "running",
        startedAt: params.nowIso,
        updatedAt: params.nowIso,
      });
    },
  });
  return runId;
}

async function updateRunState(params: {
  storePath: string;
  runId: string;
  nowIso: string;
  status?: AnalysisRunRow["status"];
  reportPath?: string;
  reportHash?: string;
  publishedChannel?: string;
  error?: string;
  ended?: boolean;
}): Promise<void> {
  await updateReleaseEngineStore({
    storePath: params.storePath,
    nowIso: params.nowIso,
    update: (store) => {
      const run = store.analysis_runs.find((entry) => entry.runId === params.runId);
      if (!run) {
        return;
      }
      run.updatedAt = params.nowIso;
      if (params.status) {
        run.status = params.status;
      }
      if (params.reportPath) {
        run.reportPath = params.reportPath;
      }
      if (params.reportHash) {
        run.reportHash = params.reportHash;
      }
      if (params.publishedChannel) {
        run.publishedChannel = params.publishedChannel;
      }
      if (params.error) {
        run.error = params.error;
      }
      if (params.ended) {
        run.endedAt = params.nowIso;
      }
    },
  });
}

async function scheduleRetry(params: {
  state: MacroReleaseRunnerState;
  status: ReleaseStatusRow;
  error: unknown;
  step: string;
  nowIso: string;
}): Promise<void> {
  const message = params.error instanceof Error ? params.error.message : String(params.error);
  const nextRetryCount = params.status.retryCount + 1;
  if (nextRetryCount > params.state.runtime.maxRetries) {
    await updateReleaseEngineStore({
      storePath: params.state.storePath,
      nowIso: params.nowIso,
      update: (store) => {
        const status = store.release_status.find(
          (entry) => entry.eventId === params.status.eventId,
        );
        if (!status) {
          return;
        }
        status.state = "failed_terminal";
        status.retryCount = nextRetryCount;
        status.nextAttemptAt = undefined;
        status.lastError = `${params.step}: ${message}`;
        status.updatedAt = params.nowIso;
      },
    });
    if (params.status.currentRunId) {
      await updateRunState({
        storePath: params.state.storePath,
        runId: params.status.currentRunId,
        nowIso: params.nowIso,
        status: "failed",
        error: `${params.step}: ${message}`,
        ended: true,
      });
    }
    log.error(`event ${params.status.eventId} failed terminally at ${params.step}: ${message}`);
    return;
  }

  const delayMs = computeBackoffDelayMs(nextRetryCount);
  const nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
  await updateReleaseEngineStore({
    storePath: params.state.storePath,
    nowIso: params.nowIso,
    update: (store) => {
      const status = store.release_status.find((entry) => entry.eventId === params.status.eventId);
      if (!status) {
        return;
      }
      status.retryCount = nextRetryCount;
      status.nextAttemptAt = nextAttemptAt;
      status.lastError = `${params.step}: ${message}`;
      status.updatedAt = params.nowIso;
    },
  });
  log.warn(
    `event ${params.status.eventId} step=${params.step} retry=${nextRetryCount}/${params.state.runtime.maxRetries} next=${nextAttemptAt} error=${message}`,
  );
}

async function markStateAdvanced(params: {
  storePath: string;
  eventId: string;
  state: ReleaseState;
  nowIso: string;
}): Promise<void> {
  await updateReleaseEngineStore({
    storePath: params.storePath,
    nowIso: params.nowIso,
    update: (store) => {
      const status = store.release_status.find((entry) => entry.eventId === params.eventId);
      if (!status) {
        return;
      }
      status.state = params.state;
      status.retryCount = 0;
      status.nextAttemptAt = undefined;
      status.lastError = undefined;
      status.updatedAt = params.nowIso;
      if (params.state === "published") {
        status.publishedAt = params.nowIso;
      }
    },
  });
}

async function discoverEvents(state: MacroReleaseRunnerState): Promise<number> {
  const tool = createEconomicCalendarTool({ config: state.cfg });
  if (!tool) {
    throw new Error("economic_calendar tool is disabled");
  }
  const today = nowDateIso();
  const startDate = addUtcDays(today, -1);
  const endDate = addUtcDays(today, 1);
  const result = await tool.execute(`release-discover-${Date.now()}`, {
    provider: "tradingeconomics",
    action: "calendar",
    country: state.runtime.country,
    startDate,
    endDate,
    importance: 3,
    maxEvents: 200,
  });
  const payload = asRecord(result.details);
  if (!payload) {
    throw new Error("invalid economic_calendar response");
  }
  if (typeof payload.error === "string") {
    throw new Error(typeof payload.message === "string" ? payload.message : payload.error);
  }
  const events = asRecordArray(payload.events).filter((entry) => {
    const country = (readStringField(entry, "country") ?? "").toLowerCase();
    if (!country.includes("united states")) {
      return false;
    }
    return isLikelyUsCpiEvent(readStringField(entry, "event"), readStringField(entry, "category"));
  });
  if (events.length === 0) {
    return 0;
  }
  const nowIso = new Date().toISOString();
  let discovered = 0;
  await updateReleaseEngineStore({
    storePath: state.storePath,
    nowIso,
    update: (store) => {
      for (const raw of events) {
        const normalized = normalizeEventRow(raw, nowIso);
        const existing = store.release_events.find((entry) => entry.id === normalized.id);
        if (existing) {
          Object.assign(existing, normalized, {
            discoveredAt: existing.discoveredAt,
            updatedAt: nowIso,
          });
        } else {
          store.release_events.push(normalized);
          store.release_status.push({
            eventId: normalized.id,
            state: "new",
            retryCount: 0,
            updatedAt: nowIso,
          });
          discovered += 1;
        }
      }
    },
  });
  return discovered;
}

async function fetchOfficialArtifact(params: {
  state: MacroReleaseRunnerState;
  event: ReleaseEventRow;
  runDir: string;
}): Promise<void> {
  const tool = createOfficialReportFetchTool({ config: params.state.cfg });
  if (!tool) {
    throw new Error("official_report_fetch tool is disabled");
  }
  const eventDate = toDateOnly(params.event.date) ?? nowDateIso();
  const startDate = addUtcDays(eventDate, -2);
  const endDate = addUtcDays(eventDate, 1);

  const response = await tool.execute(`release-official-${Date.now()}`, {
    provider: "tradingeconomics",
    country: params.state.runtime.country,
    indicator: params.state.runtime.indicator,
    startDate,
    endDate,
    importance: 3,
    maxReports: 20,
    includeReportBody: true,
    maxReportChars: 16_000,
  });
  const payload = asRecord(response.details);
  if (!payload) {
    throw new Error("invalid official_report_fetch response");
  }
  if (typeof payload.error === "string") {
    throw new Error(typeof payload.message === "string" ? payload.message : payload.error);
  }

  const reports = asRecordArray(payload.reports);
  if (reports.length === 0) {
    throw new Error("official_report_fetch returned no reports");
  }
  const selected =
    reports.find((report) => {
      const date = toDateOnly(readStringField(report, "releaseDate"));
      const event = readStringField(report, "event");
      if (
        date &&
        event &&
        date === eventDate &&
        isLikelyUsCpiEvent(event, readStringField(report, "category"))
      ) {
        return true;
      }
      return false;
    }) ?? reports[0];

  let officialText = "";
  const officialReport = asRecord(selected.officialReport);
  const excerpt = officialReport ? readStringField(officialReport, "excerpt") : undefined;
  if (excerpt) {
    officialText = excerpt;
  }
  if (!officialText) {
    const reportUrl = officialReport ? readStringField(officialReport, "reportUrl") : undefined;
    if (reportUrl) {
      const webFetch = createWebFetchTool({ config: params.state.cfg });
      if (webFetch) {
        const fetched = await webFetch.execute(`release-official-web-${Date.now()}`, {
          url: reportUrl,
          extractMode: "text",
          maxChars: 16_000,
        });
        const fetchedDetails = asRecord(fetched.details);
        if (fetchedDetails) {
          officialText = typeof fetchedDetails.text === "string" ? fetchedDetails.text.trim() : "";
        }
      }
    }
  }

  const artifact = {
    provider: "tradingeconomics",
    fetchedAt: new Date().toISOString(),
    query: {
      country: params.state.runtime.country,
      indicator: params.state.runtime.indicator,
      startDate,
      endDate,
      importance: 3,
    },
    selectedReport: selected,
    reportText: officialText || undefined,
    reportTextHash: officialText ? hashString(officialText) : undefined,
    reportHash: hashObject(selected),
  };
  await writeRunJson(params.runDir, "event_card.json", params.event);
  await writeRunJson(params.runDir, "official_artifact.json", artifact);
  await updateRunManifest(params.runDir, {
    step: "fetched_official",
    officialArtifactHash: artifact.reportHash,
  });
}

async function fetchMediaArtifact(params: {
  state: MacroReleaseRunnerState;
  event: ReleaseEventRow;
  runDir: string;
}): Promise<void> {
  const eventDate = toDateOnly(params.event.date) ?? nowDateIso();
  const mediaRaw = await fetchReutersMedia({
    cfg: params.state.cfg,
    indicator: params.state.runtime.indicator,
    releaseDate: eventDate,
    maxChars: 14_000,
  });
  await writeRunJson(params.runDir, "media_raw.json", mediaRaw);
  await updateRunManifest(params.runDir, {
    step: "fetched_media",
    mediaSkipped: Boolean(mediaRaw.skipped),
    mediaArticleUrl: mediaRaw.articleUrl,
  });
}

async function preprocessEvidence(params: {
  state: MacroReleaseRunnerState;
  event: ReleaseEventRow;
  runDir: string;
}): Promise<void> {
  const officialArtifact = await readRunJson(params.runDir, "official_artifact.json");
  if (!officialArtifact) {
    throw new Error("official_artifact missing");
  }
  const mediaRaw = (await readRunJson(params.runDir, "media_raw.json")) ?? {};
  const officialText = readStringField(officialArtifact, "reportText") ?? "";
  const mediaText = readStringField(mediaRaw, "text") ?? "";

  const officialPrompt = [
    "You extract macro release evidence cards.",
    "Return JSON only with schema:",
    '{"headline_numbers":{...},"breakdown":{...},"notable_phrases":[...],"risks_or_caveats":[...]}',
    "Focus on US CPI release facts from the official source text.",
    "",
    `Event card:\n${JSON.stringify(params.event, null, 2)}`,
    "",
    `Official source text:\n${truncateForPrompt(officialText, 12_000)}`,
  ].join("\n");

  const mediaPrompt = [
    "You extract market narrative claim cards.",
    'Return JSON only with schema: {"claims":[{"claim":"...","reason":"...","quote":"..."}]}',
    "Use only the provided Reuters text and avoid adding external assumptions.",
    "",
    `Reuters text:\n${truncateForPrompt(mediaText, 10_000)}`,
  ].join("\n");

  let officialCards: Record<string, unknown>;
  try {
    const parsed = await runOneShotJsonPrompt({
      cfg: params.state.cfg,
      agentId: params.state.runtime.agentId,
      prompt: officialPrompt,
      modelRef: params.state.runtime.preprocessModelRef,
      timeoutMs: 90_000,
      runLabel: "release-preprocess-official",
    });
    officialCards =
      asRecord(parsed) ?? buildOfficialFallbackCards({ event: params.event, officialText });
  } catch {
    officialCards = buildOfficialFallbackCards({ event: params.event, officialText });
  }

  let mediaCards: Record<string, unknown>;
  if (!mediaText) {
    mediaCards = { claims: [] };
  } else {
    try {
      const parsed = await runOneShotJsonPrompt({
        cfg: params.state.cfg,
        agentId: params.state.runtime.agentId,
        prompt: mediaPrompt,
        modelRef: params.state.runtime.preprocessModelRef,
        timeoutMs: 90_000,
        runLabel: "release-preprocess-media",
      });
      mediaCards = asRecord(parsed) ?? buildMediaFallbackCards(mediaText);
    } catch {
      mediaCards = buildMediaFallbackCards(mediaText);
    }
  }

  await writeRunJson(params.runDir, "official_evidence_cards.json", officialCards);
  await writeRunJson(params.runDir, "media_claim_cards.json", mediaCards);
  await updateRunManifest(params.runDir, {
    step: "preprocessed",
  });
}

async function fetchHistoricalSeries(params: {
  state: MacroReleaseRunnerState;
  eventDate: string;
}): Promise<Record<string, unknown>[]> {
  const tool = createEconomicCalendarTool({ config: params.state.cfg });
  if (!tool) {
    return [];
  }
  const response = await tool.execute(`release-history-${Date.now()}`, {
    provider: "tradingeconomics",
    action: "calendar",
    country: params.state.runtime.country,
    startDate: addUtcDays(params.eventDate, -params.state.runtime.historyDays),
    endDate: params.eventDate,
    importance: 3,
    maxEvents: 300,
  });
  const payload = asRecord(response.details);
  if (!payload || typeof payload.error === "string") {
    return [];
  }
  return asRecordArray(payload.events)
    .filter((entry) => {
      const date = toDateOnly(readStringField(entry, "date"));
      const event = readStringField(entry, "event");
      if (!date || !event || date >= params.eventDate) {
        return false;
      }
      return isLikelyUsCpiEvent(event, readStringField(entry, "category"));
    })
    .toSorted((a, b) =>
      (readStringField(b, "date") ?? "").localeCompare(readStringField(a, "date") ?? ""),
    )
    .slice(0, 6);
}

async function generateAnalysis(params: {
  state: MacroReleaseRunnerState;
  event: ReleaseEventRow;
  runDir: string;
}): Promise<string> {
  const officialCards = (await readRunJson(params.runDir, "official_evidence_cards.json")) ?? {};
  const mediaCards = (await readRunJson(params.runDir, "media_claim_cards.json")) ?? {};
  const eventDate = toDateOnly(params.event.date) ?? nowDateIso();
  const history = await fetchHistoricalSeries({
    state: params.state,
    eventDate,
  });
  await writeRunJson(params.runDir, "historical_snapshot.json", {
    fetchedAt: new Date().toISOString(),
    eventDate,
    items: history,
  });

  const analysisPrompt = [
    "You are a sell-side macro analyst.",
    "Generate a structured 6-section post-release report for US CPI.",
    "Use only the provided evidence cards, release event card, and 6-period history snapshot.",
    "Do not use external assumptions.",
    "Required sections:",
    "## 1) Headline Surprise",
    "## 2) Details and Decomposition",
    "## 3) Revision and Trend/Regime",
    "## 4) Rates/Policy Implication",
    "## 5) FX and Risk Assets",
    "## 6) Risks and Next Watch Items",
    "",
    `Event card:\n${JSON.stringify(params.event, null, 2)}`,
    "",
    `Official evidence cards:\n${JSON.stringify(officialCards, null, 2)}`,
    "",
    `Media claim cards:\n${JSON.stringify(mediaCards, null, 2)}`,
    "",
    `Historical snapshot (latest 6 prior releases):\n${JSON.stringify(history, null, 2)}`,
  ].join("\n");

  let report = "";
  try {
    report = await runOneShotTextPrompt({
      cfg: params.state.cfg,
      agentId: params.state.runtime.agentId,
      prompt: analysisPrompt,
      modelRef: params.state.runtime.analysisModelRef,
      timeoutMs: 120_000,
      runLabel: "release-analysis",
    });
  } catch {
    report = "";
  }
  if (!report.trim()) {
    report = buildFallbackAnalysis({
      event: params.event,
      officialCards,
      mediaCards,
      history,
    });
  }
  return report.trim();
}

async function publishReport(params: {
  state: MacroReleaseRunnerState;
  event: ReleaseEventRow;
  runDir: string;
  reportText: string;
}): Promise<Record<string, unknown>> {
  const eventDate = toDateOnly(params.event.date) ?? nowDateIso();
  const headline = `US CPI Auto Report (${eventDate})`;
  const composed = `${headline}\n\n${params.reportText}`;

  if (!params.state.runtime.telegramTarget) {
    return {
      skipped: true,
      reason: "telegram_target_not_configured",
    };
  }

  const results = await deliverOutboundPayloads({
    cfg: params.state.cfg,
    channel: "telegram",
    to: params.state.runtime.telegramTarget,
    accountId: params.state.runtime.telegramAccountId,
    payloads: [{ text: composed }],
    deps: createOutboundSendDeps(params.state.deps),
    bestEffort: false,
    agentId: params.state.runtime.agentId,
  });
  if (results.length === 0) {
    throw new Error("telegram delivery returned no results");
  }
  return {
    skipped: false,
    channel: "telegram",
    to: params.state.runtime.telegramTarget,
    accountId: params.state.runtime.telegramAccountId,
    results,
  };
}

async function processSingleEvent(params: {
  state: MacroReleaseRunnerState;
  status: ReleaseStatusRow;
  event: ReleaseEventRow;
}): Promise<void> {
  const nowIso = new Date().toISOString();
  const runId = await ensureRunRecord({
    storePath: params.state.storePath,
    status: params.status,
    nowIso,
  });
  const runDir = resolveRunDir(resolveReleaseEngineDir(), params.event.id, runId);

  try {
    switch (params.status.state) {
      case "new":
        await fetchOfficialArtifact({
          state: params.state,
          event: params.event,
          runDir,
        });
        await markStateAdvanced({
          storePath: params.state.storePath,
          eventId: params.event.id,
          state: "fetched_official",
          nowIso,
        });
        return;
      case "fetched_official":
        await fetchMediaArtifact({
          state: params.state,
          event: params.event,
          runDir,
        });
        await markStateAdvanced({
          storePath: params.state.storePath,
          eventId: params.event.id,
          state: "fetched_media",
          nowIso,
        });
        return;
      case "fetched_media":
        await preprocessEvidence({
          state: params.state,
          event: params.event,
          runDir,
        });
        await markStateAdvanced({
          storePath: params.state.storePath,
          eventId: params.event.id,
          state: "preprocessed",
          nowIso,
        });
        return;
      case "preprocessed": {
        const report = await generateAnalysis({
          state: params.state,
          event: params.event,
          runDir,
        });
        const reportPath = await writeRunText(runDir, "analysis_report.md", report);
        const reportHash = hashString(report);
        await updateRunState({
          storePath: params.state.storePath,
          runId,
          nowIso,
          reportPath,
          reportHash,
        });
        await updateRunManifest(runDir, {
          step: "analyzed",
          reportPath,
          reportHash,
        });
        await markStateAdvanced({
          storePath: params.state.storePath,
          eventId: params.event.id,
          state: "analyzed",
          nowIso,
        });
        return;
      }
      case "analyzed": {
        const reportPath = path.join(runDir, "analysis_report.md");
        const reportText = (await fs.readFile(reportPath, "utf8")).trim();
        const publishResult = await publishReport({
          state: params.state,
          event: params.event,
          runDir,
          reportText,
        });
        await writeRunJson(runDir, "publish_result.json", publishResult);
        await updateRunManifest(runDir, {
          step: "published",
          publishResult,
        });
        await markStateAdvanced({
          storePath: params.state.storePath,
          eventId: params.event.id,
          state: "published",
          nowIso,
        });
        await updateRunState({
          storePath: params.state.storePath,
          runId,
          nowIso,
          status: "published",
          publishedChannel:
            typeof publishResult.channel === "string" ? publishResult.channel : "none",
          ended: true,
        });
        return;
      }
      default:
        return;
    }
  } catch (error) {
    await scheduleRetry({
      state: params.state,
      status: params.status,
      error,
      step: params.status.state,
      nowIso,
    });
  }
}

async function processDueEvents(state: MacroReleaseRunnerState): Promise<void> {
  const nowIso = new Date().toISOString();
  const store = await readReleaseEngineStore(state.storePath);
  const due = store.release_status
    .filter((status) => !stateIsTerminal(status.state) && isDue(status, nowIso))
    .toSorted((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  for (const status of due) {
    const fresh = await readReleaseEngineStore(state.storePath);
    const latestStatus = fresh.release_status.find((entry) => entry.eventId === status.eventId);
    const event = fresh.release_events.find((entry) => entry.id === status.eventId);
    if (
      !latestStatus ||
      !event ||
      stateIsTerminal(latestStatus.state) ||
      !isDue(latestStatus, nowIso)
    ) {
      continue;
    }
    await processSingleEvent({
      state,
      status: latestStatus,
      event,
    });
  }
}

async function tick(state: MacroReleaseRunnerState): Promise<void> {
  if (state.stopped || state.running || !state.runtime.enabled) {
    return;
  }
  state.running = true;
  try {
    const discovered = await discoverEvents(state);
    if (discovered > 0) {
      log.info(`discovered ${discovered} new CPI release event(s)`);
    }
    await processDueEvents(state);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`tick failed: ${message}`);
  } finally {
    state.running = false;
  }
}

function scheduleNext(state: MacroReleaseRunnerState): void {
  if (state.stopped || !state.runtime.enabled) {
    return;
  }
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  state.timer = setTimeout(() => {
    state.timer = null;
    void tick(state).finally(() => {
      scheduleNext(state);
    });
  }, state.runtime.pollMs);
  state.timer.unref?.();
}

export function startMacroReleaseRunner(opts: {
  cfg: OpenClawConfig;
  deps: CliDeps;
  abortSignal?: AbortSignal;
}): MacroReleaseRunner {
  const state: MacroReleaseRunnerState = {
    cfg: opts.cfg,
    deps: opts.deps,
    timer: null,
    running: false,
    stopped: false,
    runtime: resolveRunnerConfig(opts.cfg),
    storePath: resolveReleaseEngineStorePath(),
  };

  const stop = () => {
    if (state.stopped) {
      return;
    }
    state.stopped = true;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  };

  const updateConfig = (cfg: OpenClawConfig) => {
    state.cfg = cfg;
    const prevEnabled = state.runtime.enabled;
    state.runtime = resolveRunnerConfig(cfg);
    if (!prevEnabled && state.runtime.enabled && !state.stopped) {
      void tick(state).finally(() => scheduleNext(state));
      return;
    }
    if (prevEnabled && !state.runtime.enabled) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      return;
    }
    if (state.runtime.enabled && !state.stopped) {
      scheduleNext(state);
    }
  };

  opts.abortSignal?.addEventListener("abort", stop, { once: true });

  if (!state.runtime.enabled) {
    log.info("disabled (set OPENCLAW_RELEASE_ENGINE_ENABLED=1 to enable)");
    return { stop, updateConfig };
  }

  log.info(
    `started pollMs=${state.runtime.pollMs} indicator=${state.runtime.indicator} country=${state.runtime.country}`,
  );
  void tick(state).finally(() => scheduleNext(state));
  return { stop, updateConfig };
}
