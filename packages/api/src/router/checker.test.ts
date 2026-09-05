import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import {
  testDns,
  testGrpc,
  testHttp,
  testIcmp,
  testTcp,
  triggerChecker,
} from "./checker";

const originalFetch = globalThis.fetch;
const originalSelfHost = process.env.SELF_HOST;

beforeEach(() => {
  process.env.SELF_HOST = "false";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalSelfHost === undefined) delete process.env.SELF_HOST;
  else process.env.SELF_HOST = originalSelfHost;
});

/** Stub the checker with one canned JSON body. */
function stubChecker(body: unknown) {
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )) as typeof globalThis.fetch;
}

/**
 * The shape GRPCHandlerRegion returns for a completed RPC. `state` is absent —
 * the handler never sends it — so grpcOutput prefaults it to "success".
 */
function completedResponse(
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return {
    jobType: "grpc",
    region: "ams",
    timestamp: 1_700_000_000_000,
    timing: {
      dnsStart: 1,
      dnsDone: 2,
      connectStart: 2,
      connectDone: 3,
      tlsHandshakeStart: 3,
      tlsHandshakeDone: 4,
      firstByteStart: 4,
      firstByteDone: 5,
      transferStart: 5,
      transferDone: 6,
    },
    latency: 5,
    completed: true,
    ...overrides,
  };
}

describe("testGrpc", () => {
  test("accepts a SERVING target", async () => {
    // `error` is omitempty in Go, so a healthy check omits it entirely.
    stubChecker(completedResponse({ servingStatus: "SERVING" }));

    const result = await testGrpc({
      url: "api.example.com:443",
      tls: "tls",
      region: "ams",
    });
    expect(result.state).toBe("success");
  });

  test("rejects a completed check that answered NOT_SERVING", async () => {
    stubChecker(
      completedResponse({
        servingStatus: "NOT_SERVING",
        error: 1,
        errorMessage: "service reports NOT_SERVING",
      }),
    );

    await expect(
      testGrpc({ url: "api.example.com:443", tls: "tls", region: "ams" }),
    ).rejects.toThrow("service reports NOT_SERVING");
  });

  test("rejects a server with no health service", async () => {
    stubChecker(
      completedResponse({
        error: 1,
        errorMessage: "server does not implement grpc.health.v1.Health",
      }),
    );

    await expect(
      testGrpc({ url: "api.example.com:443", tls: "tls", region: "ams" }),
    ).rejects.toThrow("does not implement");
  });

  test("falls back to the serving status when no message is sent", async () => {
    stubChecker(
      completedResponse({ servingStatus: "SERVICE_UNKNOWN", error: 1 }),
    );

    await expect(
      testGrpc({ url: "api.example.com:443", tls: "tls", region: "ams" }),
    ).rejects.toThrow("SERVICE_UNKNOWN");
  });

  test("still rejects a transport failure", async () => {
    // The only shape that carries `state` explicitly.
    stubChecker({ message: "uri not reachable" });

    await expect(
      testGrpc({ url: "api.example.com:443", tls: "tls", region: "ams" }),
    ).rejects.toThrow("uri not reachable");
  });
});

test("self-hosted checks never send credentials or monitor data to hosted checkers", async () => {
  process.env.SELF_HOST = "true";
  using fetchStub = stub(globalThis, "fetch", () =>
    Promise.resolve(Response.json({ state: "error", message: "blocked" })),
  );
  const monitor: Parameters<typeof triggerChecker>[0] = {
    id: 1,
    workspaceId: 1,
    jobType: "http",
    name: "private-monitor",
    externalName: null,
    description: "",
    url: "https://example.com/private",
    method: "POST",
    headers: [{ key: "Authorization", value: "Bearer private-token" }],
    body: "private-monitor-body",
    assertions: null,
    periodicity: "1m",
    status: "active",
    active: true,
    public: false,
    regions: ["ams"],
    timeout: 1000,
    degradedAfter: null,
    retry: 0,
    followRedirects: false,
    grpcService: null,
    grpcTls: "tls",
    otelEndpoint: null,
    otelHeaders: [],
    createdAt: null,
    updatedAt: null,
    deletedAt: null,
  };
  const checks = [
    () =>
      testHttp({
        url: monitor.url,
        method: "POST",
        region: "ams",
        headers: monitor.headers,
        body: monitor.body,
        assertions: [],
      }),
    () => testTcp({ url: "example.com:443", region: "ams" }),
    () => testDns({ url: "example.com", region: "ams", assertions: [] }),
    () => testIcmp({ url: "example.com", region: "ams" }),
    () => testGrpc({ url: "example.com:443", region: "ams", tls: "tls" }),
    () => triggerChecker(monitor),
  ];

  for (const check of checks) {
    await expect(check()).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  }
  expect(fetchStub.calls).toHaveLength(0);
});
