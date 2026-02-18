export const RELEASE_ENGINE_STORE_VERSION = 1 as const;

export type ReleaseState =
  | "new"
  | "fetched_official"
  | "fetched_media"
  | "preprocessed"
  | "analyzed"
  | "published"
  | "failed_terminal";

export type ReleaseEventRow = {
  id: string;
  eventKey: string;
  discoveredAt: string;
  updatedAt: string;
  source: "tradingeconomics";
  calendarId?: number;
  date?: string;
  country?: string;
  event?: string;
  category?: string;
  actual?: string | number;
  consensus?: string | number;
  previous?: string | number;
  actualNumber?: number;
  consensusNumber?: number;
  previousNumber?: number;
  importance?: number;
  currency?: string;
  unit?: string;
  reference?: string;
  url?: string;
  raw?: Record<string, unknown>;
};

export type ReleaseStatusRow = {
  eventId: string;
  state: ReleaseState;
  retryCount: number;
  nextAttemptAt?: string;
  currentRunId?: string;
  lastError?: string;
  updatedAt: string;
  publishedAt?: string;
};

export type AnalysisRunStatus = "running" | "published" | "failed";

export type AnalysisRunRow = {
  runId: string;
  eventId: string;
  status: AnalysisRunStatus;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  reportPath?: string;
  reportHash?: string;
  publishedChannel?: string;
  error?: string;
};

export type ReleaseEngineStore = {
  version: typeof RELEASE_ENGINE_STORE_VERSION;
  updatedAt: string;
  release_events: ReleaseEventRow[];
  release_status: ReleaseStatusRow[];
  analysis_runs: AnalysisRunRow[];
};
