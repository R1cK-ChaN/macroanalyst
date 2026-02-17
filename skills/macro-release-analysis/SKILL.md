---
name: macro-release-analysis
description: Run a macro release workflow end-to-end: gather the latest release context from Trading Economics, fetch original official reports, collect related Bloomberg/Reuters analysis via browser automation, and synthesize a deep macro report.
---

# Macro release analysis

Use this skill when the task is to analyze a macro data release with both:

- official source data/report pages
- market narrative from Bloomberg/Reuters-class media

## Research prompt library

- Reusable macro report-generation prompt templates live in `research/`.
- Weekly brief template: `research/weekly-brief/SYSTEM_PROMPT.zh-CN.md`.
- Weekly brief runs should load that file as the system prompt and provide precise indicator data as user input.
- Weekly key-data comment template: `research/weekly-key-data-comment/SYSTEM_PROMPT.zh-CN.md`.
- Weekly key-data comment runs should use only the already-provided data/news in input, with no extra data assumptions.

## Tool policy prerequisites

- Allow `group:web` (`web_fetch`, `economic_calendar`, `official_report_fetch`)
- Allow `browser`
- Allow session tools (`sessions_send`/`sessions_spawn`) if handoff to a dedicated macro analyst agent is required

## Workflow

1. Build the release candidate list

- Use `web_fetch` to read Trading Economics calendar/discovery pages for the latest relevant events.
- Optionally use `economic_calendar` and `official_report_fetch` for structured rows, dates, and source hints.

2. Fetch official source report

- Resolve the official publisher URL from `official_report_fetch` hints (or direct source mapping).
- Use `web_fetch` to extract the original report text/metadata from the government/statistical agency site.
- Capture at minimum: release time/date, headline value, prior value, and (if available) consensus/forecast.

3. Fetch Bloomberg/Reuters analysis

- Use `browser` (not `web_fetch`) for Bloomberg/Reuters article retrieval, because login/paywall and dynamic rendering are common.
- Prefer host browser profile with manual authenticated session already active.
- Navigate/search for release-specific articles (indicator + country + release date), then open and capture key analytical takeaways.

4. Synthesize deep macro report

- Combine official report facts and media analysis into one structured output.
- Include:
  - what released (facts, numbers, surprise vs expectation)
  - what Bloomberg/Reuters emphasize
  - macro interpretation (growth/inflation/labor/policy path)
  - risk scenarios and watch items for next releases

## Operational notes

- Do not request user credentials in chat; user logs in manually in browser profile.
- If anti-bot/CAPTCHA/MFA blocks automation, pause and request manual takeover for that step.
- Keep citations/links for both official source and media article URLs in the final report package.
