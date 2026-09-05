import { and, db, eq, inArray } from "@openstatus/db";
import {
  notification,
  notificationTrigger,
  notificationsToMonitors,
} from "@openstatus/db/src/schema";
import {
  createMonitor,
  createNotification,
  createTestWorkspace,
  linkNotificationToMonitor,
} from "@openstatus/db/src/test/factories";
import {
  afterAll,
  afterEach,
  assertSpyCalls,
  beforeAll,
  beforeEach,
  describe,
  expect,
  type Stub,
  stub,
  test,
} from "@openstatus/test-utils";

import { checkerAudit } from "../utils/audit-log";
import { enqueueNotifications, triggerNotifications } from "./alerting";
import { providerToFunction } from "./utils";

// Deno has no module mocking, so we stub the methods on the real singletons
// that alerting.ts reads at call time. Stubbing per-test resolves them to no-op
// to avoid real HTTP / Tinybird calls and gives a fresh call count each test.
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous provider stubs
type AnyStub = Stub<any>;
let stubs: AnyStub[] = [];

const stubSend = (
  provider: "email" | "slack" | "discord",
  verb: "sendAlert" | "sendRecovery" | "sendDegraded",
): AnyStub => {
  const s = stub(providerToFunction[provider], verb, () => Promise.resolve());
  stubs.push(s);
  return s;
};

let mockEmailSendAlert: AnyStub;
let mockEmailSendRecovery: AnyStub;
let mockEmailSendDegraded: AnyStub;
let mockSlackSendAlert: AnyStub;
let mockSlackSendRecovery: AnyStub;
let mockSlackSendDegraded: AnyStub;
let mockDiscordSendAlert: AnyStub;
let mockDiscordSendRecovery: AnyStub;
let mockDiscordSendDegraded: AnyStub;
let auditLog: Stub<
  typeof checkerAudit,
  Parameters<typeof checkerAudit.publishAuditLog>,
  Promise<void>
>;

// Own workspace + monitors: asserting on "how many notifications fired for this
// monitor" only holds if no other suite can attach one.
let workspaceId: number;
let emailMonitorId: number;
let emailNotificationId: number;
let noNotifMonitorId: number;

beforeEach(() => {
  stubs = [];
  auditLog = stub(checkerAudit, "publishAuditLog", () => Promise.resolve());
  stubs.push(auditLog);
  mockEmailSendAlert = stubSend("email", "sendAlert");
  mockEmailSendRecovery = stubSend("email", "sendRecovery");
  mockEmailSendDegraded = stubSend("email", "sendDegraded");
  mockSlackSendAlert = stubSend("slack", "sendAlert");
  mockSlackSendRecovery = stubSend("slack", "sendRecovery");
  mockSlackSendDegraded = stubSend("slack", "sendDegraded");
  mockDiscordSendAlert = stubSend("discord", "sendAlert");
  mockDiscordSendRecovery = stubSend("discord", "sendRecovery");
  mockDiscordSendDegraded = stubSend("discord", "sendDegraded");
});

afterEach(() => {
  for (const s of stubs) s.restore();
  stubs = [];
});

beforeAll(async () => {
  const { workspace } = await createTestWorkspace();
  workspaceId = workspace.id;
  emailMonitorId = (await createMonitor(workspaceId)).id;
  noNotifMonitorId = (await createMonitor(workspaceId)).id;
  emailNotificationId = (
    await createNotification(workspaceId, {
      name: "sample test notification",
      provider: "email",
      data: JSON.stringify({ email: "ping@openstatus.dev" }),
    })
  ).id;
  await linkNotificationToMonitor(emailNotificationId, emailMonitorId);
});

await describe("triggerNotifications", async () => {
  test("should send alert notification and return triggered list", async () => {
    const cronTimestamp = 9000001;

    await db.transaction((tx) =>
      enqueueNotifications(
        {
          monitorId: String(emailMonitorId),
          statusCode: 500,
          message: "Internal Server Error",
          notifType: "alert",
          cronTimestamp,
          incidentId: undefined,
          regions: ["ams"],
          latency: 1500,
        },
        tx,
      ),
    );
    const result = await triggerNotifications({
      monitorId: String(emailMonitorId),
      cronTimestamp,
    });

    assertSpyCalls(mockEmailSendAlert, 1);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      notificationId: emailNotificationId,
      provider: "email",
    });
  });

  test("should send recovery notification and return triggered list", async () => {
    const cronTimestamp = 9000002;

    await db.transaction((tx) =>
      enqueueNotifications(
        {
          monitorId: String(emailMonitorId),
          statusCode: 200,
          notifType: "recovery",
          cronTimestamp,
          regions: ["ams"],
        },
        tx,
      ),
    );
    const result = await triggerNotifications({
      monitorId: String(emailMonitorId),
      cronTimestamp,
    });

    assertSpyCalls(mockEmailSendRecovery, 1);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      notificationId: emailNotificationId,
      provider: "email",
    });
  });

  test("should send degraded notification and return triggered list", async () => {
    const cronTimestamp = 9000003;

    await db.transaction((tx) =>
      enqueueNotifications(
        {
          monitorId: String(emailMonitorId),
          statusCode: 200,
          notifType: "degraded",
          cronTimestamp,
          latency: 5000,
          regions: ["ams"],
        },
        tx,
      ),
    );
    const result = await triggerNotifications({
      monitorId: String(emailMonitorId),
      cronTimestamp,
    });

    assertSpyCalls(mockEmailSendDegraded, 1);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      notificationId: emailNotificationId,
      provider: "email",
    });
  });

  test("should return empty list when monitor has no notifications", async () => {
    const cronTimestamp = 9000004;

    await db.transaction((tx) =>
      enqueueNotifications(
        {
          monitorId: String(noNotifMonitorId),
          statusCode: 500,
          notifType: "alert",
          cronTimestamp,
        },
        tx,
      ),
    );
    const result = await triggerNotifications({
      monitorId: String(noNotifMonitorId),
      cronTimestamp,
    });

    assertSpyCalls(mockEmailSendAlert, 0);
    expect(result).toHaveLength(0);
  });

  test("does not redeliver acknowledged notification intent", async () => {
    const cronTimestamp = 9000005;

    await db.transaction((tx) =>
      enqueueNotifications(
        {
          monitorId: String(emailMonitorId),
          statusCode: 500,
          notifType: "alert",
          cronTimestamp,
        },
        tx,
      ),
    );
    const first = await triggerNotifications({
      monitorId: String(emailMonitorId),
      cronTimestamp,
    });

    expect(first).toHaveLength(1);
    assertSpyCalls(mockEmailSendAlert, 1);

    const second = await triggerNotifications({
      monitorId: String(emailMonitorId),
      cronTimestamp,
    });
    assertSpyCalls(mockEmailSendAlert, 1);
    expect(second).toHaveLength(0);
  });

  test("keeps rejected delivery pending and drains its stored alert before a later recovery", async () => {
    mockEmailSendAlert.restore();
    stubs = stubs.filter((entry) => entry !== mockEmailSendAlert);
    let reject = true;
    mockEmailSendAlert = stub(providerToFunction.email, "sendAlert", () =>
      reject
        ? Promise.reject(new Error("Provider rejected delivery"))
        : Promise.resolve(),
    );
    stubs.push(mockEmailSendAlert);
    const input = {
      monitorId: String(emailMonitorId),
      statusCode: 500,
      message: "Original outage",
      regions: ["Private London"],
      notifType: "alert" as const,
      cronTimestamp: 9000006,
    };

    await db.transaction((tx) => enqueueNotifications(input, tx));
    await expect(triggerNotifications(input)).rejects.toThrow();
    assertSpyCalls(mockEmailSendAlert, 4);
    assertSpyCalls(auditLog, 0);
    const pending = await db
      .select()
      .from(notificationTrigger)
      .where(
        and(
          eq(notificationTrigger.monitorId, emailMonitorId),
          eq(notificationTrigger.cronTimestamp, input.cronTimestamp),
        ),
      )
      .get();
    expect(pending?.status).toBe("pending");
    expect(pending?.leaseToken).toBeNull();

    reject = false;
    const recovery = {
      monitorId: String(emailMonitorId),
      statusCode: 200,
      notifType: "recovery" as const,
      cronTimestamp: 9000007,
      regions: ["Private Paris"],
    };
    await db.transaction((tx) => enqueueNotifications(recovery, tx));
    const delivered = await triggerNotifications(recovery);
    expect(delivered).toEqual([
      { notificationId: emailNotificationId, provider: "email" },
      { notificationId: emailNotificationId, provider: "email" },
    ]);
    assertSpyCalls(mockEmailSendAlert, 5);
    expect(mockEmailSendAlert.calls[4].args[0]).toMatchObject({
      message: "Original outage",
      statusCode: 500,
      regions: ["Private London"],
      cronTimestamp: 9000006,
    });
    assertSpyCalls(mockEmailSendRecovery, 1);
    expect(auditLog.calls.map((call) => call.args[0])).toMatchObject([
      { action: "notification.sent", metadata: { type: "alert" } },
      { action: "notification.sent", metadata: { type: "recovery" } },
    ]);
    expect(await triggerNotifications(recovery)).toEqual([]);
    assertSpyCalls(auditLog, 2);
  });

  test("does not acknowledge or send a concurrent pending delivery twice", async () => {
    mockEmailSendAlert.restore();
    stubs = stubs.filter((entry) => entry !== mockEmailSendAlert);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    mockEmailSendAlert = stub(providerToFunction.email, "sendAlert", () => {
      started.resolve();
      return release.promise;
    });
    stubs.push(mockEmailSendAlert);
    const input = {
      monitorId: String(emailMonitorId),
      notifType: "alert" as const,
      cronTimestamp: 9000008,
    };
    await db.transaction((tx) => enqueueNotifications(input, tx));
    const first = triggerNotifications(input);
    try {
      await started.promise;
      await expect(triggerNotifications(input)).rejects.toThrow();
      assertSpyCalls(mockEmailSendAlert, 1);
      assertSpyCalls(auditLog, 0);
    } finally {
      release.resolve();
      await first;
    }
    expect(await triggerNotifications(input)).toEqual([]);
    assertSpyCalls(mockEmailSendAlert, 1);
    assertSpyCalls(auditLog, 1);
  });

  test("reclaims an expired delivery lease left by an interrupted worker", async () => {
    const input = {
      monitorId: String(emailMonitorId),
      notifType: "degraded" as const,
      cronTimestamp: 9000009,
      regions: ["Private London"],
    };
    await db.transaction((tx) => enqueueNotifications(input, tx));
    await db
      .update(notificationTrigger)
      .set({
        leaseToken: "interrupted-worker",
        leaseExpiresAt: 0,
      })
      .where(
        and(
          eq(notificationTrigger.monitorId, emailMonitorId),
          eq(notificationTrigger.cronTimestamp, input.cronTimestamp),
        ),
      );

    expect(await triggerNotifications(input)).toEqual([
      { notificationId: emailNotificationId, provider: "email" },
    ]);
    assertSpyCalls(mockEmailSendDegraded, 1);
    const sent = await db
      .select()
      .from(notificationTrigger)
      .where(
        and(
          eq(notificationTrigger.monitorId, emailMonitorId),
          eq(notificationTrigger.cronTimestamp, input.cronTimestamp),
        ),
      )
      .get();
    expect(sent?.status).toBe("sent");
    expect(sent?.leaseToken).toBeNull();
    expect(await triggerNotifications(input)).toEqual([]);
    assertSpyCalls(mockEmailSendDegraded, 1);
  });

  test("does not acknowledge or release a lease taken over by another worker", async () => {
    const monitor = await createMonitor(workspaceId);
    await linkNotificationToMonitor(emailNotificationId, monitor.id);
    const input = {
      monitorId: String(monitor.id),
      notifType: "alert" as const,
      cronTimestamp: 9000011,
    };
    const trigger = and(
      eq(notificationTrigger.monitorId, monitor.id),
      eq(notificationTrigger.cronTimestamp, input.cronTimestamp),
    );
    mockEmailSendAlert.restore();
    stubs = stubs.filter((entry) => entry !== mockEmailSendAlert);
    mockEmailSendAlert = stub(
      providerToFunction.email,
      "sendAlert",
      async () => {
        await db
          .update(notificationTrigger)
          .set({
            leaseToken: "new-worker",
            leaseExpiresAt: Date.now() + 300_000,
          })
          .where(trigger);
      },
    );
    stubs.push(mockEmailSendAlert);

    await db.transaction((tx) => enqueueNotifications(input, tx));
    await expect(triggerNotifications(input)).rejects.toThrow();
    const pending = await db
      .select()
      .from(notificationTrigger)
      .where(trigger)
      .get();
    expect(pending?.status).toBe("pending");
    expect(pending?.leaseToken).toBe("new-worker");
    assertSpyCalls(auditLog, 0);
  });

  test("does not create notification intent on a same-status replay", async () => {
    expect(
      await triggerNotifications({
        monitorId: String(emailMonitorId),
        cronTimestamp: 9000010,
      }),
    ).toEqual([]);
    assertSpyCalls(mockEmailSendAlert, 0);
    assertSpyCalls(auditLog, 0);
  });

  test("counts only recent acknowledged SMS deliveries and stops at the quota", async () => {
    const { workspace } = await createTestWorkspace({
      limits: JSON.stringify({ "sms-limit": 1 }),
    });
    const smsMonitor = await createMonitor(workspace.id);
    const otherMonitor = await createMonitor(workspace.id);
    const sms = await createNotification(workspace.id, {
      provider: "sms",
      data: JSON.stringify({ sms: "+12025550123" }),
    });
    await linkNotificationToMonitor(sms.id, smsMonitor.id);
    const smsSend = stub(providerToFunction.sms, "sendAlert", () =>
      Promise.resolve(),
    );
    stubs.push(smsSend);
    const now = Date.now();
    const twoMonthsAgo = new Date(now);
    twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);
    await db.insert(notificationTrigger).values([
      {
        monitorId: smsMonitor.id,
        notificationId: sms.id,
        cronTimestamp: twoMonthsAgo.getTime(),
        status: "sent",
      },
      {
        monitorId: otherMonitor.id,
        notificationId: sms.id,
        cronTimestamp: now,
        status: "pending",
      },
    ]);
    const input = {
      monitorId: String(smsMonitor.id),
      cronTimestamp: now,
      notifType: "alert" as const,
    };
    await db.transaction((tx) => enqueueNotifications(input, tx));
    expect(await triggerNotifications(input)).toEqual([
      { notificationId: sms.id, provider: "sms" },
    ]);
    const next = { ...input, cronTimestamp: now + 1 };
    await db.transaction((tx) => enqueueNotifications(next, tx));
    await expect(triggerNotifications(next)).rejects.toThrow();
    assertSpyCalls(smsSend, 1);
    assertSpyCalls(auditLog, 1);
  });
});

describe("triggerNotifications with multiple providers", () => {
  const testNotificationIds: number[] = [];

  let testMonitorId: number;

  beforeAll(async () => {
    testMonitorId = (await createMonitor(workspaceId)).id;
  });

  afterAll(async () => {
    // Clean up notification triggers
    await db
      .delete(notificationTrigger)
      .where(eq(notificationTrigger.monitorId, testMonitorId))
      .run();

    // Clean up notification-to-monitor links
    await db
      .delete(notificationsToMonitors)
      .where(eq(notificationsToMonitors.monitorId, testMonitorId))
      .run();

    // Clean up test notifications
    if (testNotificationIds.length > 0) {
      await db
        .delete(notification)
        .where(inArray(notification.id, testNotificationIds))
        .run();
    }
  });

  test("should trigger all linked providers and return each in the result", async () => {
    // Create slack notification
    const [slackNotif] = await db
      .insert(notification)
      .values({
        name: "test-slack",
        provider: "slack",
        data: '{"slack":"https://hooks.slack.com/test"}',
        workspaceId,
      })
      .returning();

    // Create discord notification
    const [discordNotif] = await db
      .insert(notification)
      .values({
        name: "test-discord",
        provider: "discord",
        data: '{"discord":"https://discord.com/api/webhooks/test"}',
        workspaceId,
      })
      .returning();

    testNotificationIds.push(slackNotif.id, discordNotif.id);

    // Link both to monitor 3
    await db
      .insert(notificationsToMonitors)
      .values([
        { monitorId: testMonitorId, notificationId: slackNotif.id },
        { monitorId: testMonitorId, notificationId: discordNotif.id },
      ])
      .run();

    const cronTimestamp = 9100001;

    await db.transaction((tx) =>
      enqueueNotifications(
        {
          monitorId: String(testMonitorId),
          statusCode: 500,
          message: "Server Error",
          notifType: "alert",
          cronTimestamp,
          regions: ["ams"],
        },
        tx,
      ),
    );
    const result = await triggerNotifications({
      monitorId: String(testMonitorId),
      cronTimestamp,
    });

    assertSpyCalls(mockSlackSendAlert, 1);
    assertSpyCalls(mockDiscordSendAlert, 1);
    assertSpyCalls(mockEmailSendAlert, 0);

    expect(result).toHaveLength(2);
    expect(result).toContainEqual({
      notificationId: slackNotif.id,
      provider: "slack",
    });
    expect(result).toContainEqual({
      notificationId: discordNotif.id,
      provider: "discord",
    });
  });

  test("should trigger recovery on all linked providers", async () => {
    const cronTimestamp = 9100002;

    await db.transaction((tx) =>
      enqueueNotifications(
        {
          monitorId: String(testMonitorId),
          statusCode: 200,
          notifType: "recovery",
          cronTimestamp,
          regions: ["ams"],
        },
        tx,
      ),
    );
    const result = await triggerNotifications({
      monitorId: String(testMonitorId),
      cronTimestamp,
    });

    assertSpyCalls(mockSlackSendRecovery, 1);
    assertSpyCalls(mockDiscordSendRecovery, 1);

    expect(result).toHaveLength(2);
    const providers = result.map((r) => r.provider).sort();
    expect(providers).toEqual(["discord", "slack"]);
  });
});
