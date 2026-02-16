import { afterEach, describe, expect, it, vi } from "vitest";
import { withEnv } from "../../test-utils/env.js";
import { createEconomicCalendarTool, __testing } from "./economic-calendar.js";

const { parseNumericValue, resolveDateRange, resolveImportance, resolveProvider, resolveAction } =
  __testing;

describe("economic_calendar helpers", () => {
  it("parses numeric values from decorated strings", () => {
    expect(parseNumericValue("2.7%")).toBe(2.7);
    expect(parseNumericValue("USD 123.4B")).toBe(123.4);
    expect(parseNumericValue("n/a")).toBeUndefined();
  });

  it("validates date range order and format", () => {
    expect(
      resolveDateRange({ startDate: "2026-02-01", endDate: "2026-02-10", daysAhead: 7 }),
    ).toEqual({
      startDate: "2026-02-01",
      endDate: "2026-02-10",
    });
    expect(
      resolveDateRange({ startDate: "2026-02-40", endDate: "2026-02-10", daysAhead: 7 }),
    ).toMatchObject({
      error: {
        error: "invalid_start_date",
      },
    });
  });

  it("validates importance to 1..3", () => {
    expect(resolveImportance(1)).toBe(1);
    expect(resolveImportance(3)).toBe(3);
    expect(resolveImportance(0)).toBeUndefined();
    expect(resolveImportance(5)).toBeUndefined();
  });

  it("defaults provider/action and parses valid overrides", () => {
    expect(resolveProvider(undefined, undefined)).toBe("fred");
    expect(resolveProvider("bls", undefined)).toBe("bls");
    expect(resolveAction(undefined)).toBe("calendar");
    expect(resolveAction("series")).toBe("series");
  });
});

describe("economic_calendar tool", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    // @ts-expect-error restoring fetch in tests
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns a missing key error when no api key is configured", async () => {
    await withEnv({ TRADING_ECONOMICS_API_KEY: undefined }, async () => {
      const tool = createEconomicCalendarTool({});
      if (!tool) {
        throw new Error("economic_calendar tool missing");
      }

      const result = await tool.execute("call1", {
        provider: "tradingeconomics",
        startDate: "2026-02-01",
        endDate: "2026-02-02",
      });
      expect(result.details).toMatchObject({
        error: "missing_trading_economics_api_key",
      });
    });
  });

  it("fetches calendar events and exposes actual + consensus values", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            CalendarId: "123",
            Date: "2026-02-03T13:30:00",
            Country: "United States",
            Category: "GDP Growth Rate",
            Event: "GDP Growth Rate QoQ",
            Actual: "2.5%",
            Forecast: "2.7%",
            Previous: "2.3%",
            Importance: 3,
            Unit: "%",
            Source: "Bureau of Economic Analysis",
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

    const tool = createEconomicCalendarTool({
      config: {
        tools: {
          web: {
            economicCalendar: {
              apiKey: "te-key",
              cacheTtlMinutes: 0,
            },
          },
        },
      },
    });
    if (!tool) {
      throw new Error("economic_calendar tool missing");
    }

    const result = await tool.execute("call2", {
      provider: "tradingeconomics",
      country: "united states",
      startDate: "2026-02-01",
      endDate: "2026-02-10",
      importance: 3,
      maxEvents: 5,
    });

    const calledUrl = String(fetchSpy.mock.calls[0]?.[0] ?? "");
    expect(calledUrl).toContain("/calendar/country/united%20states/2026-02-01/2026-02-10");
    expect(calledUrl).toContain("c=te-key");
    expect(calledUrl).toContain("importance=3");

    expect(result.details).toMatchObject({
      count: 1,
      events: [
        {
          event: "GDP Growth Rate QoQ",
          actual: "2.5%",
          consensus: "2.7%",
          actualNumber: 2.5,
          consensusNumber: 2.7,
        },
      ],
    });
  });
});
