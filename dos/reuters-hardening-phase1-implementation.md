# Reuters Hardening Implementation (Phase-1 CPI)

Updated: 2026-02-18

## Goal

Implement a deterministic Reuters media pipeline for US CPI release analysis that:

- scores multiple Reuters candidates instead of single-link fetch
- uses UTC epoch milliseconds for time comparisons
- supports degraded mode without blocking publish
- stores debug artifacts for reproducibility and postmortem

## Code Location

- Core logic: `src/release-engine/reuters.ts`
- Runner integration and snapshot outputs: `src/release-engine/runner.ts`

## Implemented Flow (Checklist Mapping)

## 0) Unified Time Format (`epoch_ms` in UTC)

Implemented fields:

- `releaseTimeMs` + `releaseTimeIso`
- `articleTimeMs` + `articleTimeIso`
- `fetchedAtMs` + `fetchedAtIso`

Runtime source handling:

- `releaseTimeMs` is derived from Trading Economics event timestamp in runner (`resolveReleaseTimeMs`).
- Reuters layer receives `releaseTimeMs` directly and keeps comparisons in ms.

## 1) Candidate URL List (5 to 20)

`fetchReutersForCpi`:

- Reuters site-search query: `US <indicator> <releaseDate>`
- Extracts and normalizes Reuters URLs from search HTML
- Enforces minimum 5 candidates (`MIN_REQUIRED_CANDIDATES`)
- Returns degraded mode if below threshold

## 2) Lightweight Metadata Fetch per Candidate

For each candidate URL, metadata fetch extracts:

- `title`
- `publishedTimeRaw`
- `publishedTimeMs`
- `bodyPreview` (first ~500 chars from paragraphs)

Drop rule:

- missing title or unparseable `publishedTimeMs` => candidate discarded

Performance:

- candidate metadata fetch uses batched concurrency (`LIGHT_META_BATCH_SIZE=4`)

## 3) Candidate Scoring

Implemented scoring components:

- Time window score (`deltaHours`):
  - `<=2h` => +3
  - `<=6h` => +1
  - `>6h` => drop
- Title keyword score:
  - US keyword + CPI keyword => +3
  - CPI keyword only => +1
  - missing both => drop
- Body preview feature score:
  - numeric + expectation + CPI features
  - 3/3 => +2
  - 2/3 => +1
- URL path preference:
  - `/world/us`, `/markets/us`, `/business` => +1
  - `/markets/asia`, `/markets/europe`, `/markets/global` => -1

Each candidate records:

- `score`
- `reasons[]`
- `dropped` and optional `dropReason`

## 4) Top-1 Selection with Threshold

- Survivors are sorted by score
- `best.score >= 6` required
- else degraded mode (`reuters_best_score_lt_6`)

## 5) Full Fetch Only for Selected Candidate

Only best candidate gets full `web_fetch`.

Validation:

- full body length must be `> 800`
- full body must contain CPI/inflation keywords

On success:

- selected article includes full text and `bodyHash`

## 6) Degraded Mode

Trigger conditions include:

- insufficient candidates
- no scored survivors
- score threshold failure
- full-text validation failure
- web_fetch unavailable

Behavior:

- `media_raw.json` stores `{ mode: "degraded", reason, selected: null, ... }`
- pipeline continues to preprocess/analyze/publish
- final report metadata includes `media_confidence=low`

## 7) Debug Artifacts

Per run snapshot now writes:

- `reuters_candidates.json` (candidate metadata + scoring + reasons)
- `reuters_selection.json` (selected/alternates + timestamps + reason)
- `analysis_metadata.json` (`media_confidence`, `media_mode`, `media_reason`)

## Runner Integration Changes

`fetchMediaArtifact` now:

- passes TE release timestamp into Reuters fetch
- writes `media_raw.json`
- writes Reuters debug files
- updates manifest with media mode/confidence and key timestamps

`preprocessEvidence` now:

- reads media text from `media_raw.selected.bodyFull` (with legacy fallback)
- handles degraded mode naturally via empty/low-confidence media path

`publishReport` now:

- includes `meta: media_confidence=<high|low>` in outbound message header
- stores confidence in `publish_result.json`

## Acceptance Verification (Replay)

Suggested replay checks for 3 historical CPI events:

1. `reuters_selection.json` chooses CPI主稿（不是泛市场综述）
2. `reuters_candidates.json` contains clear drop/score reasons
3. Any Reuters failure still publishes with degraded mode (official-only path)

next step can try dingding group as info source, see whether the agent can parse from dingding group stablily or not.
