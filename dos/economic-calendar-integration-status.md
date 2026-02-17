# Economic Calendar Integration Status

Updated: 2026-02-17

## Scope

This note summarizes the current status for:

- `economic_calendar` (FRED/BLS/TradingEconomics)
- `official_report_fetch` (TradingEconomics API + TradingEconomics web discovery mode)

## Current Tool Behavior (`economic_calendar`)

The `economic_calendar` tool supports multiple providers via `provider`:

- `fred` (default)
- `bls`
- `tradingeconomics`

Supported actions:

- `action: "calendar"`
- `action: "series"`

Provider/action support matrix:

- `fred + calendar`: supported (release schedule)
- `fred + series`: supported (time series values)
- `bls + series`: supported (time series values)
- `bls + calendar`: not supported (returns explicit unsupported_action message)
- `tradingeconomics + calendar`: supported

## New Tool: `official_report_fetch`

Purpose:

- Provide structured raw material for macro analyst workflows:
  - discover indicator/release candidates
  - map to likely official publisher report URLs
  - optionally fetch report excerpt text for downstream synthesis

Provider support:

- `provider: "tradingeconomics"`:
  - uses Trading Economics API calendar metadata
  - supports `actual/consensus/previous` fields
  - resolves official report URL hints from `Reference` + source mapping
  - requires API key
- `provider: "web"`:
  - scrapes `https://tradingeconomics.com/analytics/indicators.aspx`
  - does not require Trading Economics API key
  - returns indicator rows + source/frequency coverage + official publisher mapping hints
  - does not include API consensus/actual values (discovery-oriented feed)

## Credentials and Config

Environment variables:

- `FRED_API_KEY`
- `BLS_API_KEY` (or `BLS_PUBLIC_DATA_API_KEY`)
- `TRADING_ECONOMICS_API_KEY`

Tool config path:

- `tools.web.economicCalendar`
- `tools.web.officialReportFetch`

Config keys currently supported:

- `enabled`
- `provider`
- `apiKey` (Trading Economics)
- `fredApiKey`
- `blsApiKey`
- `baseUrl`
- `defaultCountry`
- `defaultDaysAhead`
- `maxEvents`
- `timeoutSeconds`
- `cacheTtlMinutes`

`official_report_fetch` config keys currently supported:

- `enabled`
- `provider` (`tradingeconomics` or `web`)
- `apiKey` (Trading Economics API)
- `baseUrl` (Trading Economics API base URL)
- `webIndicatorsUrl` (web discovery page URL)
- `defaultCountry`
- `defaultDaysBack`
- `maxReports`
- `maxReportChars`
- `timeoutSeconds`
- `cacheTtlMinutes`

## Data Capability Notes

Important differences by provider/data path:

- FRED/BLS provide official release/time-series data but generally do not provide market consensus forecasts.
- Trading Economics provides calendar entries with actual/forecast(previous) style fields, including consensus-like forecast fields.
- `official_report_fetch` in `provider=web` mode provides cheaper web-discovery metadata and official-link hints, not consensus/actual release values.

Returned payload includes capability hints, for example:

- `capabilities.actual`
- `capabilities.consensus`
- `capabilities.previous`
- `capabilities.official`

## Validation Status

### FRED

Status: verified working end-to-end.

Observed successful calls:

- FRED release dates endpoint returned release items.
- FRED `UNRATE` observations endpoint returned recent numeric values.
- In-tool `provider=fred` tests returned expected parsed output.

### BLS

Status: code path implemented; live connectivity may fail depending on environment/network path.

Observed in this environment:

- Repeated transport-level failures to `api.bls.gov` (connection reset/fetch failed).
- This appears to be network/TLS path related, not a schema/logic error in tool parsing.

Action for operator:

- Re-run BLS curl tests from a network that can reliably reach `https://api.bls.gov/publicAPI/v2/timeseries/data/`.

### Trading Economics

Status: supported as optional provider and reference-discovery source.

Notes:

- Requires API key (`TRADING_ECONOMICS_API_KEY` or config `apiKey`).
- Paid plan required by Trading Economics for API access.

### `official_report_fetch` (`provider=web`)

Status: verified live web discovery working end-to-end on 2026-02-17.

Observed successful live run:

- Fetched `https://tradingeconomics.com/analytics/indicators.aspx`.
- Parsed United States indicator rows and returned mapped official publisher hints.
- Returned 5 rows in test run (`maxReports: 5`) with source + coverage metadata.

Observed additional probe:

- `https://tradingeconomics.com/calendar` returned HTTP 200 and includes calendar/event markers.
- Conclusion: web scraping path for “current calendar” rows is feasible as a follow-up parser path.

## Example Calls

FRED release calendar:

```json
{
  "provider": "fred",
  "action": "calendar",
  "startDate": "2026-02-01",
  "endDate": "2026-02-28",
  "maxEvents": 30
}
```

FRED series:

```json
{
  "provider": "fred",
  "action": "series",
  "seriesIds": ["CPIAUCSL", "UNRATE"],
  "startDate": "2025-01-01",
  "endDate": "2026-02-28"
}
```

BLS series:

```json
{
  "provider": "bls",
  "action": "series",
  "seriesIds": ["CUUR0000SA0", "LNS14000000"],
  "startDate": "2025-01-01",
  "endDate": "2026-02-28"
}
```

Trading Economics calendar:

```json
{
  "provider": "tradingeconomics",
  "action": "calendar",
  "country": "united states",
  "startDate": "2026-02-01",
  "endDate": "2026-02-28",
  "importance": 3
}
```

`official_report_fetch` via web discovery:

```json
{
  "provider": "web",
  "country": "united states",
  "indicator": "inflation",
  "maxReports": 5
}
```

`official_report_fetch` via Trading Economics API:

```json
{
  "provider": "tradingeconomics",
  "country": "united states",
  "indicator": "CPI",
  "startDate": "2026-02-01",
  "endDate": "2026-02-17",
  "importance": 3,
  "maxReports": 10
}
```

## Summary

Current baseline is:

- `economic_calendar`: free official providers first (`fred` default, `bls` for series), with optional Trading Economics paid calendar.
- `official_report_fetch`: two-source mode now available:
  - paid structured API mode (`provider=tradingeconomics`)
  - lower-cost web discovery mode (`provider=web`) aligned with manual analyst workflow.
