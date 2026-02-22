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
make an group chat info aggregate agent 

一句话结论：“脏入口 + 内部干净”就是把不稳定、不可控的 IM 采集层彻底隔离，只把“文件 + 标准化元数据”送进一个可验证、可重放、可扩展的 RAG 内核。

你现在做的不是脚本，是数据供应链。
供应链第一原则：污染不准进核心。

下面我按从小学版 → 专业系统版拆开讲。

⸻

一、小学生版本

群聊像一个乱糟糟的集市。
你派一个人专门去捡研报。

捡回来以后：
	•	洗干净
	•	贴标签
	•	编号
	•	放进图书馆

图书馆永远整洁。
集市爱怎么乱就怎么乱。

这就叫“脏入口 + 干净内部”。

⸻

二、整体架构图（工程级）

               ┌────────────────────┐
               │   Windows VM       │
               │  (脏入口层)        │
               │ ─ IM客户端         │
               │ ─ RPA采集          │
               │ ─ 文件下载         │
               └────────┬───────────┘
                        │
                        │  只传递:
                        │  file + metadata.json
                        ↓
          ┌──────────────────────────┐
          │  Ingestion Gateway       │
          │  (Linux 干净边界层)      │
          │ ─ 文件校验               │
          │ ─ 去重                   │
          │ ─ 标准化                 │
          └────────┬─────────────────┘
                   │
                   ↓
     ┌──────────────────────────────┐
     │   Processing Pipeline        │
     │ ─ PDF解析                    │
     │ ─ 元数据抽取                 │
     │ ─ Chunk切分                  │
     │ ─ Embedding                  │
     └────────┬─────────────────────┘
              │
              ↓
     ┌──────────────────────────────┐
     │  Storage Layer               │
     │ ─ 原始文件存储               │
     │ ─ 结构化数据库               │
     │ ─ 向量数据库                 │
     └────────┬─────────────────────┘
              │
              ↓
     ┌──────────────────────────────┐
     │  RAG Agent / 汇总系统        │
     └──────────────────────────────┘


⸻

三、脏入口层设计（Windows VM）

目标：

只做三件事：
	1.	进入群文件
	2.	下载新文件
	3.	生成 metadata.json

绝对不要在这层：
	•	解析 PDF
	•	分类
	•	做 embedding
	•	写数据库

它只是“搬运工”。

⸻

文件输出格式（标准化）

下载完成后，生成：

/export/
   2026-02-22_xxx券商_半导体深度.pdf
   2026-02-22_xxx券商_半导体深度.json

json 内容：

{
  "source": "dingtalk_group_A",
  "download_time": "2026-02-22T15:32:00",
  "original_filename": "...",
  "hash": "md5",
  "collector_version": "1.0.3"
}

注意：

入口层不允许有业务逻辑。

⸻

四、干净边界层（Linux Ingestion Gateway）

这是最关键的一层。

职责：

1️⃣ 校验 hash
2️⃣ 判断是否重复
3️⃣ 验证文件完整性
4️⃣ 统一命名规范
5️⃣ 写入 ingestion_log

数据库示例：

| file_id | hash | source | status | ingest_time |

如果文件坏了：
	•	记录 error
	•	不让进入后续流程

这层相当于“海关”。

⸻

五、处理流水线（纯函数化设计）

每一步都应该：
	•	输入固定
	•	输出固定
	•	可重复运行

Step 1：PDF → text

raw_pdf → raw_text

Step 2：抽取元数据

提取：
	•	券商
	•	行业
	•	股票代码
	•	报告类型
	•	日期

输出：

metadata_enriched.json


⸻

Step 3：Chunk 切分

规则：
	•	800–1200 tokens
	•	重叠 100 tokens

生成：

chunk_id
chunk_text
file_id


⸻

Step 4：Embedding

chunk_text → vector

写入向量数据库。

⸻

六、存储层设计

三层分离：

1️⃣ Raw Layer

原始 PDF 永久保留。

2️⃣ Structured Layer

Postgres:

| file_id | broker | industry | ticker | date |

3️⃣ Vector Layer

向量数据库：

| chunk_id | file_id | vector |

不要混。

⸻

七、RAG 层（你的 Agent 服务）

RAG 只访问：
	•	Structured DB
	•	Vector DB

永远不直接读 IM。

这是“干净核心”的核心。

⸻

八、为什么这种架构长期稳定？

因为你把：
	•	不可控 UI
	•	IM 风险
	•	客户端升级

全部限制在“最外层”。

就算：
	•	IM 崩溃
	•	采集停 3 天

内部系统不会坏。

⸻

九、故障恢复策略

1️⃣ VM 每日自动重启
2️⃣ 采集层有 heartbeat
3️⃣ Linux 侧 ingestion 有失败重试
4️⃣ 所有文件 hash 去重

你可以随时重跑 pipeline。

⸻

十、进阶优化（你这种人会做的）
	•	给每个 file 分配 UUID
	•	所有步骤幂等
	•	所有任务异步队列化
	•	加 metrics（处理耗时）

做成一个真正的 data platform。

⸻

十一、核心原则总结

脏入口层特点：
	•	不稳定
	•	UI依赖
	•	不可信

干净内部层特点：
	•	API驱动
	•	可测试
	•	可回放
	•	可扩展

边界必须清晰。

⸻

你现在想做的不是“自动下载群文件”。
你是在搭一个私有研究数据基础设施。

做对架构，
三年后你会感谢现在的自己。

如果你愿意，我可以下一步帮你拆：
	•	目录结构设计
	•	服务拆分
	•	Docker 编排
	•	数据库 schema 设计

把它做成 production-ready 版本。

