# CPI MVP Product Flow Implementation

Updated: 2026-02-18

## 1. Goal and Scope

This document explains the implemented **Phase 1 CPI autonomous analyst flow**:

- Focus: **US CPI only**
- Trigger source: **Trading Economics calendar**
- Core outputs: structured artifacts + 6-section report + Telegram publish
- Runtime: always-on runner integrated into gateway lifecycle

Out of scope in this implementation:

- Multi-country generalized routing
- Full provider abstraction layer for every stage
- Vintage backtest engine
- Free-browse agent behavior

## 2. Where the Implementation Lives

### New module

- `src/release-engine/types.ts`
- `src/release-engine/store.ts`
- `src/release-engine/llm.ts`
- `src/release-engine/reuters.ts`
- `src/release-engine/runner.ts`
- `src/release-engine/index.ts`

### Gateway integration

- Start runner on gateway boot: `src/gateway/server.impl.ts`
- Stop runner on gateway shutdown: `src/gateway/server-close.ts`
- Refresh runner config on hot reload: `src/gateway/server-reload-handlers.ts`

## 3. Runtime Lifecycle

The runner is started with gateway startup and follows this behavior:

1. Reads runtime config from environment variables.
2. If disabled, it exits without scheduling work.
3. If enabled, it immediately runs one tick, then schedules periodic ticks with `setTimeout`.
4. On config reload, it re-resolves runtime knobs and re-arms scheduling.
5. On gateway shutdown, it stops and clears timers.

## 4. Data Model and Persistence

Store path:

- `~/.openclaw/release-engine/phase1-us-cpi/state.json`

Store sections:

- `release_events`: event master rows (deduped by computed event key/id)
- `release_status`: state machine rows per event
- `analysis_runs`: per-run execution/version metadata

Implementation details:

- Atomic store writes via `writeJsonAtomic`
- In-process async lock to serialize updates
- Event identity is deterministic (`eventKey` + hash-derived `id`)

## 5. State Machine

Implemented states:

- `new`
- `fetched_official`
- `fetched_media`
- `preprocessed`
- `analyzed`
- `published`
- `failed_terminal`

Transition chain:

- `new -> fetched_official -> fetched_media -> preprocessed -> analyzed -> published`

Retry behavior:

- Exponential backoff, base `30s`, max `1h`
- Retry count tracked in `release_status.retryCount`
- Default max retries: `8` (env-overridable)
- Exceeded retries => `failed_terminal`

## 6. End-to-End CPI Flow (What Actually Runs)

## 6.1 Discover events

Uses `economic_calendar` tool:

- `provider=tradingeconomics`
- `action=calendar`
- `country=united states`
- `importance=3`
- date window around today (`today-1` to `today+1`)

Then filters for CPI-like events (`CPI`, `Consumer Price Index`, inflation variants).

## 6.2 Fetch official artifact

Uses `official_report_fetch`:

- `provider=tradingeconomics`
- `includeReportBody=true`

If report text is missing, uses `web_fetch` on `reportUrl` as fallback.

Writes:

- `event_card.json`
- `official_artifact.json`

## 6.3 Fetch media (fixed one source)

Source is fixed to Reuters path in this MVP:

1. Reuters site search for CPI + release date
2. Select best Reuters article URL candidate
3. Pull text with `web_fetch`

Writes:

- `media_raw.json`

If Reuters is unavailable, media step records skip reason and continues with degraded mode later.

## 6.4 Preprocess (small-model layer)

Generates structured cards:

- `official_evidence_cards.json`
- `media_claim_cards.json`

Model interface:

- One-shot JSON prompts via `runEmbeddedPiAgent` wrapper in `src/release-engine/llm.ts`
- Strict JSON extraction from model output
- Deterministic fallback card builders if model JSON is invalid

## 6.5 Analyze (large-model layer)

Builds final sell-side style report from:

- Event card
- Official evidence cards
- Media claim cards
- Historical snapshot (latest 6 prior CPI-like releases from Trading Economics calendar)

Writes:

- `historical_snapshot.json`
- `analysis_report.md`

Fallback:

- If model output fails/empty, a deterministic 6-section fallback report is generated.

## 6.6 Publish

Current publish sink:

- Telegram via `deliverOutboundPayloads`

If Telegram target is not configured:

- Publish is marked skipped with reason, but state still advances to `published` for workflow completion.

Writes:

- `publish_result.json`

## 7. Snapshot/Reproducibility

Per run snapshot directory:

- `~/.openclaw/release-engine/phase1-us-cpi/snapshots/<eventId>/<runId>/`

Files produced:

- `manifest.json`
- `event_card.json`
- `official_artifact.json`
- `media_raw.json`
- `official_evidence_cards.json`
- `media_claim_cards.json`
- `historical_snapshot.json`
- `analysis_report.md`
- `publish_result.json`

This provides replay/audit inputs for each generated report.

## 8. Environment Controls

Enable switch:

- `OPENCLAW_RELEASE_ENGINE_ENABLED=1`

Required data key:

- `TRADING_ECONOMICS_API_KEY`

Publish target:

- `OPENCLAW_RELEASE_ENGINE_TELEGRAM_TARGET`
- optional: `OPENCLAW_RELEASE_ENGINE_TELEGRAM_ACCOUNT_ID`

Tuning:

- `OPENCLAW_RELEASE_ENGINE_POLL_MS`
- `OPENCLAW_RELEASE_ENGINE_MAX_RETRIES`
- `OPENCLAW_RELEASE_ENGINE_COUNTRY`
- `OPENCLAW_RELEASE_ENGINE_INDICATOR`
- `OPENCLAW_RELEASE_ENGINE_HISTORY_DAYS`
- `OPENCLAW_RELEASE_ENGINE_AGENT_ID`
- `OPENCLAW_RELEASE_ENGINE_PREPROCESS_MODEL`
- `OPENCLAW_RELEASE_ENGINE_ANALYSIS_MODEL`

## 9. Operational Notes

- Runner logs under subsystem: `release-engine`
- Disabled-by-default until env switch is set
- Designed as CPI-first deterministic loop, not a generalized autonomous browser agent
- Uses whitelisted internal tools (`economic_calendar`, `official_report_fetch`, `web_fetch`) and outbound delivery stack

## 10. Current Gaps vs Final Product Vision

Still to build in next steps:

- Replay CLI command for historical date simulation
- Notion sink as secondary publisher
- Indicator expansion (`NFP`, `GDP`) with mapping layer
- More robust Reuters parsing hardening and source confidence scoring
- Better explicit "official-only degraded publish" tags in final report metadata
