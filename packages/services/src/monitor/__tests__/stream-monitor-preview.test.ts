import { expect } from "@std/expect";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  test,
} from "@std/testing/bdd";

import {
  createWorkspaceFixture,
  makeUserCtx,
  withTestTransaction,
} from "../../../test/helpers";
import { NotFoundError, PreconditionFailedError } from "../../errors";
import { createMonitor } from "../create";
import { streamMonitorPreview } from "../stream-monitor-preview";

const originalFetch = globalThis.fetch;
const originalCronSecret = process.env.CRON_SECRET;
const originalSelfHost = process.env.SELF_HOST;
let checkRequests = 0;

describe("streamMonitorPreview", () => {
  beforeAll(() => {
    process.env.CRON_SECRET = "test-cron-secret";
    // Stub the Go-checker fetch to a fast in-memory response so the test
    // doesn't hit the real network. Each call returns a minimal success
    // payload that the service generator parses into a CheckResult.
    globalThis.fetch = (async () => {
      checkRequests++;
      return new Response(
        JSON.stringify({
          state: "success",
          status: 200,
          latency: 100,
          timestamp: Date.now(),
          timing: {
            dnsStart: 0,
            dnsDone: 10,
            connectStart: 10,
            connectDone: 20,
            tlsHandshakeStart: 20,
            tlsHandshakeDone: 40,
            firstByteStart: 40,
            firstByteDone: 90,
            transferStart: 90,
            transferDone: 100,
          },
          headers: { "x-test": "1" },
          body: "ok",
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
  });

  beforeEach(() => {
    process.env.SELF_HOST = "false";
    checkRequests = 0;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    if (originalCronSecret === undefined) {
      delete process.env.CRON_SECRET;
    } else {
      process.env.CRON_SECRET = originalCronSecret;
    }
    if (originalSelfHost === undefined) {
      delete process.env.SELF_HOST;
    } else {
      process.env.SELF_HOST = originalSelfHost;
    }
  });

  test("throws NotFoundError when monitor belongs to a different workspace", async () => {
    await withTestTransaction(async (tx) => {
      const ws = (await createWorkspaceFixture("team")).workspace;
      const ctx = { ...makeUserCtx(ws), db: tx };

      // Use a monitor id that does not exist for this workspace.
      const generator = streamMonitorPreview({
        ctx,
        input: { monitorId: 999_999_999 },
      });

      await expect(
        (async () => {
          for await (const _ of generator) {
            // drain
          }
        })(),
      ).rejects.toThrow(NotFoundError);
    });
  });

  for (const selfHost of ["true", "1"]) {
    test(`blocks hosted checks when SELF_HOST=${selfHost}`, async () => {
      await withTestTransaction(async (tx) => {
        const { workspace, userId } = await createWorkspaceFixture("team");
        const ctx = { ...makeUserCtx(workspace, { userId }), db: tx };
        const created = await createMonitor({
          ctx,
          input: {
            name: "self-hosted-preview",
            jobType: "http",
            url: "https://example.com/private",
            method: "POST",
            headers: [{ key: "Authorization", value: "Bearer private-token" }],
            body: "private-monitor-body",
            assertions: [],
            active: true,
          },
        });

        process.env.SELF_HOST = selfHost;
        checkRequests = 0;
        const generator = streamMonitorPreview({
          ctx,
          input: { monitorId: created.id },
        });

        await expect(generator.next()).rejects.toThrow(PreconditionFailedError);
        expect(checkRequests).toBe(0);
      });
    });
  }

  test("yields one result per region for an owned monitor", async () => {
    await withTestTransaction(async (tx) => {
      const ws = (await createWorkspaceFixture("team")).workspace;
      const ctx = { ...makeUserCtx(ws), db: tx };
      const created = await createMonitor({
        ctx,
        input: {
          name: "preview-test",
          jobType: "http",
          url: "https://example.com",
          method: "GET",
          headers: [],
          assertions: [],
          active: true,
        },
      });

      const results: { region: string }[] = [];
      for await (const result of streamMonitorPreview({
        ctx,
        input: { monitorId: created.id },
      })) {
        results.push({ region: result.region });
      }

      expect(results.some((result) => result.region === "ams")).toBe(true);
      expect(checkRequests).toBe(results.length);
    });
  });
});
