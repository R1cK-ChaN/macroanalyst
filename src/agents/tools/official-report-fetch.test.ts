import { afterEach, describe, expect, it, vi } from "vitest";
import { withEnv } from "../../test-utils/env.js";
import { __testing, createOfficialReportFetchTool } from "./official-report-fetch.js";

const {
  inferOfficialSource,
  parseIndicatorsRowsFromHtml,
  parseNumericValue,
  resolveDateRange,
  resolveImportance,
  resolveProvider,
  resolveReportUrl,
} = __testing;

describe("official_report_fetch helpers", () => {
  it("parses numeric values from decorated strings", () => {
    expect(parseNumericValue("2.9%")).toBe(2.9);
    expect(parseNumericValue("USD 120.4B")).toBe(120.4);
    expect(parseNumericValue("n/a")).toBeUndefined();
  });

  it("validates date ranges and defaults startDate from endDate", () => {
    expect(resolveDateRange({ endDate: "2026-02-16", daysBack: 7 })).toEqual({
      startDate: "2026-02-09",
      endDate: "2026-02-16",
    });
    expect(
      resolveDateRange({ startDate: "2026-02-20", endDate: "2026-02-16", daysBack: 7 }),
    ).toEqual({
      error: {
        error: "invalid_date_range",
        message: "startDate must be before or equal to endDate.",
      },
    });
  });

  it("validates importance and reference urls", () => {
    expect(resolveImportance(1)).toBe(1);
    expect(resolveImportance(3)).toBe(3);
    expect(resolveImportance(5)).toBeUndefined();
    expect(resolveReportUrl("https://www.bls.gov/news.release/cpi.nr0.htm")).toBe(
      "https://www.bls.gov/news.release/cpi.nr0.htm",
    );
    expect(resolveReportUrl("not-a-url")).toBeUndefined();
  });

  it("resolves provider from args and defaults", () => {
    expect(resolveProvider(undefined, undefined)).toBe("tradingeconomics");
    expect(resolveProvider("web", undefined)).toBe("web");
    expect(resolveProvider("tradingeconomics", undefined)).toBe("tradingeconomics");
  });

  it("infers official source hints from metadata", () => {
    expect(
      inferOfficialSource({
        source: "Bureau of Labor Statistics",
        event: "Consumer Price Index",
        country: "United States",
      }),
    ).toMatchObject({
      publisher: "U.S. Bureau of Labor Statistics",
      official: true,
    });
  });

  it("parses indicator table rows from html", () => {
    const rows = parseIndicatorsRowsFromHtml(`
      <table>
        <tr>
          <td><a href="/united-states/inflation-rate">United States Inflation Rate</a></td>
          <td>Bureau of Labor Statistics</td>
          <td>Monthly</td>
          <td>1948</td>
          <td>2026</td>
        </tr>
      </table>
    `);
    expect(rows[0]).toMatchObject({
      title: "United States Inflation Rate",
      source: "Bureau of Labor Statistics",
      frequency: "Monthly",
      fromYear: "1948",
      untilYear: "2026",
      tradingEconomicsUrl: "https://tradingeconomics.com/united-states/inflation-rate",
    });
  });
});

describe("official_report_fetch tool", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    // @ts-expect-error restoring fetch in tests
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns missing key error when api key is not configured", async () => {
    await withEnv({ TRADING_ECONOMICS_API_KEY: undefined }, async () => {
      const tool = createOfficialReportFetchTool({});
      if (!tool) {
        throw new Error("official_report_fetch tool missing");
      }

      const result = await tool.execute("call1", {
        country: "united states",
        indicator: "CPI",
      });
      expect(result.details).toMatchObject({
        error: "missing_trading_economics_api_key",
      });
    });
  });

  it("fetches indicator releases and returns official report link hints", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            Date: "2026-02-12T13:30:00",
            Country: "United States",
            Category: "Inflation Rate",
            Event: "CPI YoY",
            Actual: "2.9%",
            Forecast: "2.8%",
            Previous: "3.0%",
            Importance: 3,
            Source: "Bureau of Labor Statistics",
            Reference: "https://www.bls.gov/news.release/cpi.nr0.htm",
            URL: "https://tradingeconomics.com/united-states/inflation-cpi",
          },
        ]),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    // @ts-expect-error mock fetch for tool call
    global.fetch = fetchSpy;

    const tool = createOfficialReportFetchTool({
      config: {
        tools: {
          web: {
            officialReportFetch: {
              apiKey: "te-key",
              cacheTtlMinutes: 0,
            },
          },
        },
      },
    });
    if (!tool) {
      throw new Error("official_report_fetch tool missing");
    }

    const result = await tool.execute("call2", {
      country: "united states",
      indicator: "CPI",
      startDate: "2026-02-01",
      endDate: "2026-02-16",
      maxReports: 3,
    });

    const calledUrl = String(fetchSpy.mock.calls[0]?.[0] ?? "");
    expect(calledUrl).toContain("/calendar/country/united%20states/2026-02-01/2026-02-16");
    expect(calledUrl).toContain("c=te-key");

    expect(result.details).toMatchObject({
      count: 1,
      reports: [
        {
          event: "CPI YoY",
          actualNumber: 2.9,
          consensusNumber: 2.8,
          officialReport: {
            publisher: "U.S. Bureau of Labor Statistics",
            official: true,
            reportUrl: "https://www.bls.gov/news.release/cpi.nr0.htm",
          },
        },
      ],
    });
  });

  it("supports provider=web without Trading Economics API key", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(
        `
          <html><body>
            <table>
              <tr>
                <td><a href="/united-states/inflation-rate">United States Inflation Rate</a></td>
                <td>Bureau of Labor Statistics</td>
                <td>Monthly</td>
                <td>1948</td>
                <td>2026</td>
              </tr>
              <tr>
                <td><a href="/japan/inflation-rate">Japan Inflation Rate</a></td>
                <td>Statistics Bureau of Japan</td>
                <td>Monthly</td>
                <td>1958</td>
                <td>2026</td>
              </tr>
            </table>
          </body></html>
        `,
        {
          status: 200,
          headers: { "content-type": "text/html" },
        },
      ),
    );
    // @ts-expect-error mock fetch for tool call
    global.fetch = fetchSpy;

    await withEnv({ TRADING_ECONOMICS_API_KEY: undefined }, async () => {
      const tool = createOfficialReportFetchTool({
        config: {
          tools: {
            web: {
              officialReportFetch: {
                cacheTtlMinutes: 0,
              },
            },
          },
        },
      });
      if (!tool) {
        throw new Error("official_report_fetch tool missing");
      }

      const result = await tool.execute("call3", {
        provider: "web",
        country: "united states",
        indicator: "inflation",
        maxReports: 2,
      });

      expect(fetchSpy).toHaveBeenCalledOnce();
      const calledUrl = String(fetchSpy.mock.calls[0]?.[0] ?? "");
      expect(calledUrl).toContain("tradingeconomics.com/analytics/indicators.aspx");
      expect(result.details).toMatchObject({
        provider: "web",
        count: 1,
        reports: [
          {
            event: "United States Inflation Rate",
            source: {
              provider: "web",
              sourceField: "Bureau of Labor Statistics",
            },
            officialReport: {
              publisher: "U.S. Bureau of Labor Statistics",
              official: true,
              reportUrl: "https://www.bls.gov/news.release/",
            },
          },
        ],
      });
    });
  });
});
