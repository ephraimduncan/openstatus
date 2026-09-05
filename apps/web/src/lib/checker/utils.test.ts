import { expect } from "@std/expect";
import { afterEach, test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { checkRegion } from "./utils";

const originalSelfHost = process.env.SELF_HOST;
const originalCronSecret = process.env.CRON_SECRET;

afterEach(() => {
  if (originalSelfHost === undefined) delete process.env.SELF_HOST;
  else process.env.SELF_HOST = originalSelfHost;
  if (originalCronSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalCronSecret;
});

test("self-hosted previews never forward credentials or monitor configuration", async () => {
  process.env.SELF_HOST = "true";
  process.env.CRON_SECRET = "private-cron-secret";
  using fetchStub = stub(globalThis, "fetch", () =>
    Promise.resolve(Response.json({ state: "error", message: "blocked" })),
  );

  const result = await checkRegion({
    url: "https://example.com/private",
    region: "ams",
    method: "POST",
    headers: [{ key: "Authorization", value: "Bearer private-token" }],
    body: "private-monitor-body",
  });

  expect(result.state).toBe("error");
  expect(fetchStub.calls).toHaveLength(0);
});

test("cloud previews still send authenticated checks and return the checker result", async () => {
  process.env.SELF_HOST = "false";
  process.env.CRON_SECRET = "cloud-cron-secret";
  using fetchStub = stub(globalThis, "fetch", () =>
    Promise.resolve(
      Response.json({
        state: "success",
        type: "http",
        status: 200,
        latency: 10,
        timestamp: 123,
        headers: {},
        body: "ok",
        timing: {
          dnsStart: 0,
          dnsDone: 1,
          connectStart: 1,
          connectDone: 2,
          tlsHandshakeStart: 2,
          tlsHandshakeDone: 3,
          firstByteStart: 3,
          firstByteDone: 8,
          transferStart: 8,
          transferDone: 10,
        },
      }),
    ),
  );

  const result = await checkRegion({
    url: "https://example.com",
    region: "ams",
  });

  expect(result).toMatchObject({
    state: "success",
    region: "ams",
    status: 200,
  });
  expect(fetchStub.calls).toHaveLength(1);
  const request = fetchStub.calls[0];
  expect(request?.args[0]).toBe("https://checker.openstatus.dev/ping/ams");
  expect(new Headers(request?.args[1]?.headers).get("authorization")).toBe(
    "Basic cloud-cron-secret",
  );
});
