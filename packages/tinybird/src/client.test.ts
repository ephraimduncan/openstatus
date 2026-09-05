import { expect } from "@std/expect";
import { describe, test } from "@std/testing/bdd";

import { noopFlagSchema, OSTinybird } from "./client";

describe("noopFlagSchema", () => {
  test("treats the string 'false' as disabled, not as a truthy string", () => {
    expect(noopFlagSchema.parse("false")).toBe(false);
    expect(noopFlagSchema.parse("0")).toBe(false);
    expect(noopFlagSchema.parse("")).toBe(false);
  });

  test("enables on the documented truthy spellings", () => {
    expect(noopFlagSchema.parse("true")).toBe(true);
    expect(noopFlagSchema.parse("1")).toBe(true);
  });

  test("passes booleans through for schemas that already coerced", () => {
    expect(noopFlagSchema.parse(true)).toBe(true);
    expect(noopFlagSchema.parse(false)).toBe(false);
  });

  test("defaults to disabled when unset or unrecognised", () => {
    expect(noopFlagSchema.parse(undefined)).toBe(false);
    expect(noopFlagSchema.parse("nope")).toBe(false);
  });
});

describe("OSTinybird", () => {
  test("no-ops under NODE_ENV=test even when the call site asks for a real client", async () => {
    const tb = new OSTinybird({
      token: "a-token",
      // Unroutable on purpose: a real client would reject instead of resolving.
      baseUrl: "http://127.0.0.1:1",
      noop: false,
    });

    expect(await tb.homeStats({})).toEqual({ meta: [], data: [] });
  });

  test("sends region and date filters on every HTTP latency endpoint", async () => {
    const requests: URL[] = [];
    const server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      (request) => {
        requests.push(new URL(request.url));
        return Response.json({ meta: [], data: [] });
      },
    );
    try {
      const nodeEnv = process.env.NODE_ENV;
      let tb: OSTinybird;
      try {
        process.env.NODE_ENV = "development";
        tb = new OSTinybird({
          token: "local-test",
          baseUrl: `http://127.0.0.1:${server.addr.port}`,
        });
      } finally {
        if (nodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = nodeEnv;
      }
      const filters = {
        regions: ["ams", "42"],
        fromDate: "2026-01-01T00:00:00Z",
        toDate: "2026-01-02T00:00:00Z",
      };
      const endpoints = [
        ["1d", tb.httpMetricsLatency1d],
        ["7d", tb.httpMetricsLatency7d],
        ["30d", tb.httpMetricsLatency30d],
        ["90d", tb.httpMetricsLatency90d],
      ] as const;
      for (const [period, query] of endpoints) {
        await query({ monitorId: "123", ...filters });
        const request = requests.pop();
        expect(request?.pathname).toBe(
          `/v0/pipes/endpoint__http_metrics_latency_${period}__v1.json`,
        );
        expect(Object.fromEntries(request?.searchParams ?? [])).toEqual({
          monitorId: "123",
          regions: "ams,42",
          fromDate: "2026-01-01T00:00:00Z",
          toDate: "2026-01-02T00:00:00Z",
        });
      }

      await tb.httpMetricsLatency1dMulti({
        monitorIds: ["123", "456"],
        ...filters,
      });
      const request = requests.pop();
      expect(request?.pathname).toBe(
        "/v0/pipes/endpoint__http_metrics_latency_1d_multi__v1.json",
      );
      expect(Object.fromEntries(request?.searchParams ?? [])).toEqual({
        monitorIds: "123,456",
        regions: "ams,42",
        fromDate: "2026-01-01T00:00:00Z",
        toDate: "2026-01-02T00:00:00Z",
      });
    } finally {
      await server.shutdown();
    }
  });
});
