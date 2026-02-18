import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { type EmbeddedPiRunResult, runEmbeddedPiAgent } from "../agents/pi-embedded.js";

type ModelRef = {
  provider: string;
  model: string;
};

function parseModelRef(value: string | undefined): ModelRef | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash >= trimmed.length - 1) {
    return undefined;
  }
  const provider = trimmed.slice(0, slash).trim();
  const model = trimmed.slice(slash + 1).trim();
  if (!provider || !model) {
    return undefined;
  }
  return { provider, model };
}

function pickRunText(result: EmbeddedPiRunResult): string {
  const candidates = (result.payloads ?? [])
    .map((entry) => (typeof entry.text === "string" ? entry.text.trim() : ""))
    .filter(Boolean);
  if (candidates.length === 0) {
    return "";
  }
  return candidates[candidates.length - 1] ?? "";
}

function extractJsonSlice(raw: string): string | null {
  const openBrace = raw.indexOf("{");
  const openBracket = raw.indexOf("[");
  const start =
    openBrace >= 0 && openBracket >= 0
      ? Math.min(openBrace, openBracket)
      : openBrace >= 0
        ? openBrace
        : openBracket;
  if (start < 0) {
    return null;
  }
  const first = raw[start];
  const closer = first === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let i = start; i < raw.length; i += 1) {
    const char = raw[i];
    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === first) {
      depth += 1;
      continue;
    }
    if (char === closer) {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }
  return null;
}

export async function runOneShotTextPrompt(params: {
  cfg: OpenClawConfig;
  agentId: string;
  prompt: string;
  modelRef?: string;
  timeoutMs: number;
  runLabel: string;
}): Promise<string> {
  const agentDir = resolveAgentDir(params.cfg, params.agentId);
  const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
  const runId = `${params.runLabel}-${randomUUID()}`;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-release-llm-"));
  const sessionFile = path.join(tempDir, "session.jsonl");
  const model = parseModelRef(params.modelRef);
  try {
    const result = await runEmbeddedPiAgent({
      sessionId: `release-engine-${runId}`,
      sessionKey: "release-engine",
      agentId: params.agentId,
      sessionFile,
      workspaceDir,
      agentDir,
      config: params.cfg,
      prompt: params.prompt,
      timeoutMs: params.timeoutMs,
      runId,
      provider: model?.provider,
      model: model?.model,
    });
    return pickRunText(result);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function runOneShotJsonPrompt(params: {
  cfg: OpenClawConfig;
  agentId: string;
  prompt: string;
  modelRef?: string;
  timeoutMs: number;
  runLabel: string;
}): Promise<unknown> {
  const text = await runOneShotTextPrompt(params);
  const sliced = extractJsonSlice(text);
  if (!sliced) {
    throw new Error("model did not return JSON");
  }
  return JSON.parse(sliced) as unknown;
}
