import {
  type Monitor,
  selectNotificationSchema,
} from "@openstatus/db/src/schema";
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, test } from "@std/testing/bdd";
import { assertSpyCalls, stub, type Stub } from "@std/testing/mock";

import { sendAlert, sendDegraded, sendRecovery, sendTest } from "./index";

describe("OpsGenie Notifications", () => {
  let fetchMock: Stub<typeof globalThis>;

  beforeEach(() => {
    fetchMock = stub(globalThis, "fetch", () =>
      Promise.resolve(new Response(null, { status: 202 })),
    );
  });

  afterEach(() => {
    fetchMock.restore();
  });

  const createMockMonitor = (): Monitor => ({
    id: 1,
    name: "API Health Check",
    url: "https://api.example.com/health",
    jobType: "http",
    periodicity: "5m",
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
    active: true,
    public: true,
    regions: ["iad"],
    description: "",
    headers: [],
    body: "",
    workspaceId: 1,
    timeout: 45000,
    degradedAfter: null,
    assertions: null,
    method: "GET",
    deletedAt: null,
    externalName: null,
    otelEndpoint: null,
    otelHeaders: [],
    retry: 3,
    followRedirects: false,
    grpcService: null,
    grpcTls: null,
  });

  const createMockNotification = (region: "eu" | "us" = "us") => ({
    id: 1,
    name: "OpsGenie Notification",
    provider: "opsgenie",
    workspaceId: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    data: JSON.stringify({
      opsgenie: {
        apiKey: "test-api-key-123",
        region,
      },
    }),
  });

  test("Send Alert with US region", async () => {
    const monitor = createMockMonitor();
    const notification = selectNotificationSchema.parse(
      createMockNotification("us"),
    );

    await sendAlert({
      monitor,
      notification,
      statusCode: 500,
      message: "Something went wrong",
      cronTimestamp: Date.now(),
    });

    assertSpyCalls(fetchMock, 1);
    const callArgs = fetchMock.calls[0].args;
    expect(callArgs[0]).toBe("https://api.opsgenie.com/v2/alerts");
    expect(callArgs[1].method).toBe("POST");
    expect(callArgs[1].headers["Content-Type"]).toBe("application/json");
    expect(callArgs[1].headers.Authorization).toBe("GenieKey test-api-key-123");

    const body = JSON.parse(callArgs[1].body);
    expect(body.message).toBe("API Health Check is down");
    expect(body.alias).toBe("1");
    expect(body.details.severity).toBe("down");
    expect(body.details.status).toBe(500);
    expect(body.details.message).toBe("Something went wrong");
  });

  test("Send Alert with EU region", async () => {
    const monitor = createMockMonitor();
    const notification = selectNotificationSchema.parse(
      createMockNotification("eu"),
    );
    await sendAlert({
      monitor,
      notification,
      statusCode: 500,
      message: "Error",
      cronTimestamp: Date.now(),
    });

    assertSpyCalls(fetchMock, 1);
    const callArgs = fetchMock.calls[0].args;
    expect(callArgs[0]).toBe("https://api.eu.opsgenie.com/v2/alerts");
  });

  test("Send Degraded", async () => {
    const monitor = createMockMonitor();
    const notification = selectNotificationSchema.parse(
      createMockNotification(),
    );
    await sendDegraded({
      monitor,
      notification,
      statusCode: 503,
      message: "Service degraded",
      cronTimestamp: Date.now(),
    });

    assertSpyCalls(fetchMock, 1);
    const callArgs = fetchMock.calls[0].args;
    const body = JSON.parse(callArgs[1].body);
    expect(body.details.severity).toBe("degraded");
    expect(body.message).toBe("API Health Check is degraded");
  });

  for (const [region, origin] of [
    ["us", "https://api.opsgenie.com"],
    ["eu", "https://api.eu.opsgenie.com"],
  ] as const) {
    test(`sendRecovery closes the monitor alias in ${region}`, async () => {
      await sendRecovery({
        monitor: createMockMonitor(),
        notification: selectNotificationSchema.parse(
          createMockNotification(region),
        ),
        cronTimestamp: 1_780_000_000_000,
      });

      assertSpyCalls(fetchMock, 1);
      const [url, init] = fetchMock.calls[0].args;
      const request = new Request(url, init);
      expect(request.url).toBe(
        `${origin}/v2/alerts/1/close?identifierType=alias`,
      );
      expect(request.method).toBe("POST");
      expect(request.headers.get("Authorization")).toBe(
        "GenieKey test-api-key-123",
      );
      expect(await request.json()).toEqual({ source: "OpenStatus" });
    });
  }

  for (const [name, send] of [
    ["sendAlert", sendAlert],
    ["sendRecovery", sendRecovery],
    ["sendDegraded", sendDegraded],
  ] as const) {
    test(`${name} rejects an HTTP failure instead of acknowledging delivery`, async () => {
      fetchMock.restore();
      fetchMock = stub(globalThis, "fetch", () =>
        Promise.resolve(new Response(null, { status: 503 })),
      );

      await expect(
        send({
          monitor: createMockMonitor(),
          notification: selectNotificationSchema.parse(
            createMockNotification(),
          ),
          message: "Service status changed",
          cronTimestamp: 1_780_000_000_000,
        }),
      ).rejects.toThrow();

      assertSpyCalls(fetchMock, 1);
    });

    test(`${name} propagates a network failure instead of acknowledging delivery`, async () => {
      const error = new Error("Network error");
      fetchMock.restore();
      fetchMock = stub(globalThis, "fetch", () => Promise.reject(error));

      await expect(
        send({
          monitor: createMockMonitor(),
          notification: selectNotificationSchema.parse(
            createMockNotification(),
          ),
          message: "Service status changed",
          cronTimestamp: 1_780_000_000_000,
        }),
      ).rejects.toBe(error);

      assertSpyCalls(fetchMock, 1);
    });
  }

  test("Send Test returns false on error", async () => {
    fetchMock.restore();
    fetchMock = stub(globalThis, "fetch", () =>
      Promise.reject(new Error("Network error")),
    );

    const result = await sendTest({
      apiKey: "test-api-key",
      region: "us",
    });

    expect(result).toBe(false);
    assertSpyCalls(fetchMock, 1);
  });
});
