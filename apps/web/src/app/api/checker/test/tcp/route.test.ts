import { expect } from "@std/expect";
import { test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { POST } from "./route";

test("self-hosted TCP previews reject without contacting the hosted checker", async () => {
  const originalSelfHost = process.env.SELF_HOST;
  process.env.SELF_HOST = "true";
  using fetchStub = stub(globalThis, "fetch", () =>
    Promise.resolve(
      Response.json({
        timestamp: 123,
        timing: { tcpStart: 0, tcpDone: 1 },
        region: "ams",
      }),
    ),
  );

  try {
    const response = await POST(
      new Request("http://localhost/api/checker/test/tcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "example.com:443", region: "ams" }),
      }),
    );

    expect(response.status).toBe(403);
    expect(fetchStub.calls).toHaveLength(0);
  } finally {
    if (originalSelfHost === undefined) delete process.env.SELF_HOST;
    else process.env.SELF_HOST = originalSelfHost;
  }
});
