import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { createAsyncLock, readJsonFile, writeJsonAtomic } from "../infra/json-files.js";
import {
  RELEASE_ENGINE_STORE_VERSION,
  type AnalysisRunRow,
  type ReleaseEngineStore,
  type ReleaseEventRow,
  type ReleaseStatusRow,
} from "./types.js";

const STORE_FILENAME = "state.json";
const STORE_LOCKS = new Map<string, ReturnType<typeof createAsyncLock>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asEventRows(value: unknown): ReleaseEventRow[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry) => isRecord(entry)) as ReleaseEventRow[];
}

function asStatusRows(value: unknown): ReleaseStatusRow[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry) => isRecord(entry)) as ReleaseStatusRow[];
}

function asRunRows(value: unknown): AnalysisRunRow[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry) => isRecord(entry)) as AnalysisRunRow[];
}

export function resolveReleaseEngineDir(params?: { env?: NodeJS.ProcessEnv }): string {
  return path.join(resolveStateDir(params?.env), "release-engine", "phase1-us-cpi");
}

export function resolveReleaseEngineStorePath(params?: { env?: NodeJS.ProcessEnv }): string {
  return path.join(resolveReleaseEngineDir(params), STORE_FILENAME);
}

export function createEmptyReleaseEngineStore(
  nowIso = new Date().toISOString(),
): ReleaseEngineStore {
  return {
    version: RELEASE_ENGINE_STORE_VERSION,
    updatedAt: nowIso,
    release_events: [],
    release_status: [],
    analysis_runs: [],
  };
}

export function normalizeReleaseEngineStore(
  value: unknown,
  nowIso = new Date().toISOString(),
): ReleaseEngineStore {
  if (!isRecord(value)) {
    return createEmptyReleaseEngineStore(nowIso);
  }
  return {
    version: RELEASE_ENGINE_STORE_VERSION,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : nowIso,
    release_events: asEventRows(value.release_events),
    release_status: asStatusRows(value.release_status),
    analysis_runs: asRunRows(value.analysis_runs),
  };
}

export async function readReleaseEngineStore(storePath: string): Promise<ReleaseEngineStore> {
  const raw = await readJsonFile<unknown>(storePath);
  return normalizeReleaseEngineStore(raw);
}

function resolveStoreLock(storePath: string): ReturnType<typeof createAsyncLock> {
  const existing = STORE_LOCKS.get(storePath);
  if (existing) {
    return existing;
  }
  const created = createAsyncLock();
  STORE_LOCKS.set(storePath, created);
  return created;
}

export async function updateReleaseEngineStore(params: {
  storePath: string;
  update: (store: ReleaseEngineStore) => void | Promise<void>;
  nowIso?: string;
}): Promise<ReleaseEngineStore> {
  const withLock = resolveStoreLock(params.storePath);
  return await withLock(async () => {
    const nowIso = params.nowIso ?? new Date().toISOString();
    const current = await readReleaseEngineStore(params.storePath);
    await params.update(current);
    current.updatedAt = nowIso;
    await writeJsonAtomic(params.storePath, current, { mode: 0o600 });
    return current;
  });
}
