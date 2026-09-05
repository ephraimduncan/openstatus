import { and, db, eq, inArray, sql } from "@openstatus/db";
import {
  incidentTable,
  monitor,
  monitorStatusTable,
  notification,
  notificationTrigger,
  notificationsToMonitors,
  privateLocation,
  privateLocationMonitorStatus,
  privateLocationToMonitors,
} from "@openstatus/db/src/schema";
import { createTestWorkspace } from "@openstatus/db/src/test/factories";
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

import { env } from "../env";
import { checkerAudit } from "../utils/audit-log";
import { enqueueNotifications } from "./alerting";
import { checkerRoute } from "./index";
import { providerToFunction } from "./utils";

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous provider stubs
type AnyStub = Stub<any>;

// Dedicated fixtures, not seed monitor 1: other suites (api/server maintenance
// tests) put seed monitor 1 under active maintenance on the shared CI database,
// which makes updateStatusPrivate suppress notifications and drop the write.
let workspaceId: number;
const TEST_MONITOR_ID = 9101;
const INACTIVE_MONITOR_ID = 9102;
const TEST_NOTIFICATION_ID = 9101;
const TEST_LOCATION_ID = 9001;
const UNATTACHED_LOCATION_ID = 9002;
const PRIVATE_ONLY_MONITOR_ID = 9103;
const PRIVATE_LOCATION_2_ID = 9003;
const PRIVATE_LOCATION_3_ID = 9004;

const cronSecret = env().CRON_SECRET;

type PrivatePayload = {
  monitorId: string;
  privateLocationId: string;
  status: string;
  cronTimestamp: number;
  statusCode?: number;
  latency?: number;
  message?: string;
};

function post(payload: PrivatePayload, authorization = `Basic ${cronSecret}`) {
  return checkerRoute.request("/updateStatusPrivate", {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

function readRow(monitorId: number, privateLocationId: number) {
  return db
    .select()
    .from(privateLocationMonitorStatus)
    .where(
      and(
        eq(privateLocationMonitorStatus.monitorId, monitorId),
        eq(privateLocationMonitorStatus.privateLocationId, privateLocationId),
      ),
    )
    .get();
}

describe("updateStatusPrivate", () => {
  let stubs: AnyStub[] = [];
  let mockEmailSendAlert: AnyStub;
  let mockEmailSendRecovery: AnyStub;
  let mockEmailSendDegraded: AnyStub;

  beforeAll(async () => {
    workspaceId = (await createTestWorkspace()).workspace.id;
    await db
      .insert(monitor)
      .values([
        {
          id: TEST_MONITOR_ID,
          workspaceId,
          active: true,
          url: "https://private-location.test",
          name: "Private Location Test Monitor",
          periodicity: "1m",
          regions: "ams",
        },
        {
          id: INACTIVE_MONITOR_ID,
          workspaceId,
          active: false,
          url: "https://private-location-inactive.test",
          name: "Private Location Inactive Monitor",
          periodicity: "1m",
          regions: "ams",
        },
        {
          id: PRIVATE_ONLY_MONITOR_ID,
          workspaceId,
          active: true,
          url: "https://private-only.test",
          name: "Private-Only Monitor (No Cloud Regions)",
          periodicity: "1m",
          regions: "",
        },
      ])
      .onConflictDoNothing()
      .run();
    await db
      .insert(notification)
      .values({
        id: TEST_NOTIFICATION_ID,
        provider: "email",
        name: "private location test notification",
        data: '{"email":"ping@openstatus.dev"}',
        workspaceId,
      })
      .onConflictDoNothing()
      .run();
    await db
      .insert(notificationsToMonitors)
      .values({
        monitorId: TEST_MONITOR_ID,
        notificationId: TEST_NOTIFICATION_ID,
      })
      .onConflictDoNothing()
      .run();
    await db
      .insert(privateLocation)
      .values({
        id: TEST_LOCATION_ID,
        name: "Test Office",
        token: "test-private-location-token",
        workspaceId,
        createdAt: new Date(),
      })
      .onConflictDoNothing()
      .run();
    await db
      .insert(privateLocationToMonitors)
      .values({
        privateLocationId: TEST_LOCATION_ID,
        monitorId: TEST_MONITOR_ID,
        createdAt: new Date(),
      })
      .onConflictDoNothing()
      .run();

    // Additional private locations for multi-location tests
    await db
      .insert(privateLocation)
      .values([
        {
          id: PRIVATE_LOCATION_2_ID,
          name: "Test Office 2",
          token: "test-private-location-token-2",
          workspaceId,
          createdAt: new Date(),
        },
        {
          id: PRIVATE_LOCATION_3_ID,
          name: "Test Office 3",
          token: "test-private-location-token-3",
          workspaceId,
          createdAt: new Date(),
        },
      ])
      .onConflictDoNothing()
      .run();

    // Link all three locations to private-only monitor
    await db
      .insert(privateLocationToMonitors)
      .values([
        {
          privateLocationId: TEST_LOCATION_ID,
          monitorId: PRIVATE_ONLY_MONITOR_ID,
          createdAt: new Date(),
        },
        {
          privateLocationId: PRIVATE_LOCATION_2_ID,
          monitorId: PRIVATE_ONLY_MONITOR_ID,
          createdAt: new Date(),
        },
        {
          privateLocationId: PRIVATE_LOCATION_3_ID,
          monitorId: PRIVATE_ONLY_MONITOR_ID,
          createdAt: new Date(),
        },
      ])
      .onConflictDoNothing()
      .run();

    // Link first location to private-only monitor for notifications
    await db
      .insert(notificationsToMonitors)
      .values({
        monitorId: PRIVATE_ONLY_MONITOR_ID,
        notificationId: TEST_NOTIFICATION_ID,
      })
      .onConflictDoNothing()
      .run();
  });

  afterAll(async () => {
    await db
      .delete(notificationTrigger)
      .where(
        inArray(notificationTrigger.monitorId, [
          TEST_MONITOR_ID,
          PRIVATE_ONLY_MONITOR_ID,
        ]),
      );
    await db
      .delete(incidentTable)
      .where(eq(incidentTable.workspaceId, workspaceId));
    await db
      .delete(monitorStatusTable)
      .where(
        inArray(monitorStatusTable.monitorId, [
          TEST_MONITOR_ID,
          PRIVATE_ONLY_MONITOR_ID,
        ]),
      );
    await db
      .delete(privateLocationMonitorStatus)
      .where(
        inArray(privateLocationMonitorStatus.monitorId, [
          TEST_MONITOR_ID,
          PRIVATE_ONLY_MONITOR_ID,
        ]),
      );
    await db
      .delete(notificationsToMonitors)
      .where(
        inArray(notificationsToMonitors.monitorId, [
          TEST_MONITOR_ID,
          PRIVATE_ONLY_MONITOR_ID,
        ]),
      );
    await db
      .delete(privateLocationToMonitors)
      .where(
        inArray(privateLocationToMonitors.monitorId, [
          TEST_MONITOR_ID,
          PRIVATE_ONLY_MONITOR_ID,
        ]),
      );
    await db
      .delete(privateLocation)
      .where(eq(privateLocation.workspaceId, workspaceId));
    await db
      .delete(notification)
      .where(eq(notification.workspaceId, workspaceId));
    await db.delete(monitor).where(eq(monitor.workspaceId, workspaceId));
  });

  beforeEach(() => {
    stubs = [];
    stubs.push(
      stub(checkerAudit, "publishAuditLog", () =>
        Promise.resolve({ successful_rows: 1, quarantined_rows: 0 }),
      ) as AnyStub,
    );
    mockEmailSendAlert = stub(providerToFunction.email, "sendAlert", () =>
      Promise.resolve(),
    ) as AnyStub;
    mockEmailSendRecovery = stub(providerToFunction.email, "sendRecovery", () =>
      Promise.resolve(),
    ) as AnyStub;
    mockEmailSendDegraded = stub(providerToFunction.email, "sendDegraded", () =>
      Promise.resolve(),
    ) as AnyStub;
    stubs.push(
      mockEmailSendAlert,
      mockEmailSendRecovery,
      mockEmailSendDegraded,
    );
  });

  afterEach(async () => {
    for (const s of stubs) s.restore();
    stubs = [];
    await db
      .delete(privateLocationMonitorStatus)
      .where(eq(privateLocationMonitorStatus.monitorId, TEST_MONITOR_ID))
      .run();
    await db
      .delete(privateLocationMonitorStatus)
      .where(
        eq(privateLocationMonitorStatus.monitorId, PRIVATE_ONLY_MONITOR_ID),
      )
      .run();
    await db
      .delete(notificationTrigger)
      .where(eq(notificationTrigger.monitorId, TEST_MONITOR_ID))
      .run();
    await db
      .delete(notificationTrigger)
      .where(eq(notificationTrigger.monitorId, PRIVATE_ONLY_MONITOR_ID))
      .run();
    await db
      .delete(incidentTable)
      .where(eq(incidentTable.workspaceId, workspaceId));
    await db
      .delete(monitorStatusTable)
      .where(
        inArray(monitorStatusTable.monitorId, [
          TEST_MONITOR_ID,
          PRIVATE_ONLY_MONITOR_ID,
        ]),
      );
    await db
      .update(monitor)
      .set({ status: "active" })
      .where(eq(monitor.workspaceId, workspaceId));
  });

  test("rejects a wrong CRON_SECRET with 401", async () => {
    const res = await post(
      {
        monitorId: String(TEST_MONITOR_ID),
        privateLocationId: String(TEST_LOCATION_ID),
        status: "error",
        cronTimestamp: 9300001,
      },
      "Basic wrong-secret",
    );
    expect(res.status).toBe(401);
    assertSpyCalls(mockEmailSendAlert, 0);
  });

  test("rejects an invalid payload with 422", async () => {
    const res = await checkerRoute.request("/updateStatusPrivate", {
      method: "POST",
      headers: {
        Authorization: `Basic ${cronSecret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ monitorId: String(TEST_MONITOR_ID) }),
    });
    expect(res.status).toBe(422);
  });

  test("first error report alerts and writes an error row", async () => {
    const res = await post({
      monitorId: String(TEST_MONITOR_ID),
      privateLocationId: String(TEST_LOCATION_ID),
      status: "error",
      cronTimestamp: 9300010,
      statusCode: 500,
      message: "down",
    });
    expect(res.status).toBe(200);
    assertSpyCalls(mockEmailSendAlert, 1);

    const row = await readRow(TEST_MONITOR_ID, TEST_LOCATION_ID);
    expect(row?.status).toBe("error");
    expect(row?.cronTimestamp).toBe(9300010);
  });

  test("unchanged status does not re-notify but advances the timestamp", async () => {
    await post({
      monitorId: String(TEST_MONITOR_ID),
      privateLocationId: String(TEST_LOCATION_ID),
      status: "error",
      cronTimestamp: 9300020,
    });
    assertSpyCalls(mockEmailSendAlert, 1);

    const res = await post({
      monitorId: String(TEST_MONITOR_ID),
      privateLocationId: String(TEST_LOCATION_ID),
      status: "error",
      cronTimestamp: 9300021,
    });
    expect(res.status).toBe(200);
    assertSpyCalls(mockEmailSendAlert, 1);

    const row = await readRow(TEST_MONITOR_ID, TEST_LOCATION_ID);
    expect(row?.cronTimestamp).toBe(9300021);
  });

  test("recovery after error sends a recovery notification", async () => {
    await post({
      monitorId: String(TEST_MONITOR_ID),
      privateLocationId: String(TEST_LOCATION_ID),
      status: "error",
      cronTimestamp: 9300030,
    });
    assertSpyCalls(mockEmailSendAlert, 1);

    const res = await post({
      monitorId: String(TEST_MONITOR_ID),
      privateLocationId: String(TEST_LOCATION_ID),
      status: "active",
      cronTimestamp: 9300031,
    });
    expect(res.status).toBe(200);
    assertSpyCalls(mockEmailSendRecovery, 1);

    const row = await readRow(TEST_MONITOR_ID, TEST_LOCATION_ID);
    expect(row?.status).toBe("active");
  });

  test("degraded report sends a degraded notification", async () => {
    const res = await post({
      monitorId: String(TEST_MONITOR_ID),
      privateLocationId: String(TEST_LOCATION_ID),
      status: "degraded",
      cronTimestamp: 9300040,
      latency: 5000,
    });
    expect(res.status).toBe(200);
    assertSpyCalls(mockEmailSendDegraded, 1);

    const row = await readRow(TEST_MONITOR_ID, TEST_LOCATION_ID);
    expect(row?.status).toBe("degraded");
  });

  test("a stale (older) report is dropped and does not notify", async () => {
    await post({
      monitorId: String(TEST_MONITOR_ID),
      privateLocationId: String(TEST_LOCATION_ID),
      status: "active",
      cronTimestamp: 9300050,
    });

    const res = await post({
      monitorId: String(TEST_MONITOR_ID),
      privateLocationId: String(TEST_LOCATION_ID),
      status: "error",
      cronTimestamp: 9300049,
    });
    expect(res.status).toBe(200);
    assertSpyCalls(mockEmailSendAlert, 0);

    const row = await readRow(TEST_MONITOR_ID, TEST_LOCATION_ID);
    expect(row?.status).toBe("active");
    expect(row?.cronTimestamp).toBe(9300050);
  });

  test("an unattached location is a no-op", async () => {
    const res = await post({
      monitorId: String(TEST_MONITOR_ID),
      privateLocationId: String(UNATTACHED_LOCATION_ID),
      status: "error",
      cronTimestamp: 9300060,
    });
    expect(res.status).toBe(200);
    assertSpyCalls(mockEmailSendAlert, 0);

    const row = await readRow(TEST_MONITOR_ID, UNATTACHED_LOCATION_ID);
    expect(row).toBeUndefined();
  });

  test("an inactive monitor is a no-op", async () => {
    const res = await post({
      monitorId: String(INACTIVE_MONITOR_ID),
      privateLocationId: String(TEST_LOCATION_ID),
      status: "error",
      cronTimestamp: 9300070,
    });
    expect(res.status).toBe(200);
    assertSpyCalls(mockEmailSendAlert, 0);
  });

  test("private-only monitor: updates status when threshold met (2/3 locations agree)", async () => {
    // First location reports error → 1/3 < 50% → should NOT update monitor status
    const res1 = await post({
      monitorId: String(PRIVATE_ONLY_MONITOR_ID),
      privateLocationId: String(TEST_LOCATION_ID),
      status: "error",
      cronTimestamp: 9310010,
      statusCode: 500,
      message: "down",
    });
    expect(res1.status).toBe(200);

    const monitorAfter1 = await db
      .select()
      .from(monitor)
      .where(eq(monitor.id, PRIVATE_ONLY_MONITOR_ID))
      .get();
    expect(monitorAfter1?.status).toBe("active"); // Threshold not met

    // Second location reports error → 2/3 >= 50% → SHOULD update monitor status
    const res2 = await post({
      monitorId: String(PRIVATE_ONLY_MONITOR_ID),
      privateLocationId: String(PRIVATE_LOCATION_2_ID),
      status: "error",
      cronTimestamp: 9310020,
      statusCode: 500,
      message: "down",
    });
    expect(res2.status).toBe(200);

    const monitorAfter2 = await db
      .select()
      .from(monitor)
      .where(eq(monitor.id, PRIVATE_ONLY_MONITOR_ID))
      .get();
    expect(monitorAfter2?.status).toBe("error");
    assertSpyCalls(mockEmailSendAlert, 1);
  });

  test("does not change monitor.status from error when 1/3 locations report degraded (threshold not met)", async () => {
    // First seed the monitor to "error" state via 2/3 locations agreeing
    await post({
      monitorId: String(PRIVATE_ONLY_MONITOR_ID),
      privateLocationId: String(TEST_LOCATION_ID),
      status: "error",
      cronTimestamp: 9320000,
      statusCode: 500,
      message: "down",
    });
    await post({
      monitorId: String(PRIVATE_ONLY_MONITOR_ID),
      privateLocationId: String(PRIVATE_LOCATION_2_ID),
      status: "error",
      cronTimestamp: 9320005,
      statusCode: 500,
      message: "down",
    });

    // Now try degraded with only 1/3 → should NOT change
    const res = await post({
      monitorId: String(PRIVATE_ONLY_MONITOR_ID),
      privateLocationId: String(PRIVATE_LOCATION_3_ID),
      status: "degraded",
      cronTimestamp: 9320010,
      statusCode: 200,
    });
    expect(res.status).toBe(200);

    const monitorAfter = await db
      .select()
      .from(monitor)
      .where(eq(monitor.id, PRIVATE_ONLY_MONITOR_ID))
      .get();
    // Monitor should remain "error" because 1/3 < 50% threshold
    expect(monitorAfter?.status).toBe("error");
  });

  test("does not update monitor.status for monitors with cloud regions", async () => {
    // TEST_MONITOR_ID has regions: "ams" (cloud region)
    const res = await post({
      monitorId: String(TEST_MONITOR_ID),
      privateLocationId: String(TEST_LOCATION_ID),
      status: "error",
      cronTimestamp: 9330010,
      statusCode: 500,
      message: "down",
    });
    expect(res.status).toBe(200);

    const monitorAfter = await db
      .select()
      .from(monitor)
      .where(eq(monitor.id, TEST_MONITOR_ID))
      .get();
    // Monitor has cloud regions, so private status updates should not affect it
    expect(monitorAfter?.status).toBe("active");
  });

  for (const source of ["private", "cloud"] as const) {
    for (const status of ["error", "active", "degraded"] as const) {
      test(`${source}: failed ${status} incident write rolls back status and replay completes once`, async () => {
        const id =
          source === "private" ? PRIVATE_ONLY_MONITOR_ID : TEST_MONITOR_ID;
        const priorStatus = status === "error" ? "active" : "error";
        const cronTimestamp = 9400000;
        await db
          .update(monitor)
          .set({ status: priorStatus })
          .where(eq(monitor.id, id));
        if (priorStatus === "error") {
          await db.insert(incidentTable).values({
            monitorId: id,
            workspaceId,
            startedAt: new Date(9300000),
          });
        }
        if (source === "private") {
          await db.insert(privateLocationMonitorStatus).values([
            {
              monitorId: id,
              privateLocationId: TEST_LOCATION_ID,
              status,
              cronTimestamp: 9398000,
            },
            {
              monitorId: id,
              privateLocationId: PRIVATE_LOCATION_2_ID,
              status: priorStatus,
              cronTimestamp: 9399000,
            },
          ]);
        } else {
          await db.insert(monitorStatusTable).values({
            monitorId: id,
            region: "ams",
            status: priorStatus,
            cronTimestamp: 9399000,
          });
        }

        const send = () =>
          checkerRoute.request(
            source === "private" ? "/updateStatusPrivate" : "/updateStatus",
            {
              method: "POST",
              headers: {
                Authorization: `Basic ${cronSecret}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                monitorId: String(id),
                privateLocationId: String(PRIVATE_LOCATION_2_ID),
                region: "ams",
                status,
                cronTimestamp,
              }),
            },
          );
        const regionalStatus =
          source === "private"
            ? db
                .select({
                  status: privateLocationMonitorStatus.status,
                  cronTimestamp: privateLocationMonitorStatus.cronTimestamp,
                })
                .from(privateLocationMonitorStatus)
                .where(
                  and(
                    eq(privateLocationMonitorStatus.monitorId, id),
                    eq(
                      privateLocationMonitorStatus.privateLocationId,
                      PRIVATE_LOCATION_2_ID,
                    ),
                  ),
                )
            : db
                .select({
                  status: monitorStatusTable.status,
                  cronTimestamp: monitorStatusTable.cronTimestamp,
                })
                .from(monitorStatusTable)
                .where(eq(monitorStatusTable.monitorId, id));
        const aggregateStatus = db
          .select({ status: monitor.status })
          .from(monitor)
          .where(eq(monitor.id, id));
        const incidents = db
          .select()
          .from(incidentTable)
          .where(eq(incidentTable.monitorId, id));
        const triggers = db
          .select()
          .from(notificationTrigger)
          .where(eq(notificationTrigger.monitorId, id));

        await db.run(
          sql.raw(`
          CREATE TRIGGER fail_status_incident
          BEFORE ${status === "error" ? "INSERT" : "UPDATE"} ON incident
          WHEN NEW.monitor_id = ${id}
          BEGIN SELECT RAISE(ABORT, 'injected incident write failure'); END
        `),
        );
        try {
          expect((await send()).status).toBe(500);
          expect(await regionalStatus.get()).toEqual({
            status: priorStatus,
            cronTimestamp: 9399000,
          });
          expect((await aggregateStatus.get())?.status).toBe(priorStatus);
          const unchangedIncidents = await incidents.all();
          expect(unchangedIncidents.length).toBe(status === "error" ? 0 : 1);
          if (status !== "error")
            expect(unchangedIncidents[0]?.resolvedAt).toBeNull();
          expect(await triggers.all()).toEqual([]);
        } finally {
          await db.run(sql`DROP TRIGGER fail_status_incident`);
        }

        expect((await send()).status).toBe(200);
        expect((await send()).status).toBe(200);
        expect(await regionalStatus.get()).toEqual({
          status,
          cronTimestamp: 9400000,
        });
        expect((await aggregateStatus.get())?.status).toBe(status);
        const completedIncidents = await incidents.all();
        expect(completedIncidents.length).toBe(1);
        expect(completedIncidents[0]?.resolvedAt).toEqual(
          status === "error" ? null : new Date(9400000),
        );
        expect((await triggers.all()).length).toBe(1);
        assertSpyCalls(mockEmailSendAlert, status === "error" ? 1 : 0);
        assertSpyCalls(mockEmailSendRecovery, status === "active" ? 1 : 0);
        assertSpyCalls(mockEmailSendDegraded, status === "degraded" ? 1 : 0);
      });
    }
  }

  for (const source of ["private", "cloud"] as const) {
    for (const status of ["error", "active"] as const) {
      test(`${source}: same-status replay repairs an unfinished ${status} incident transition`, async () => {
        const id =
          source === "private" ? PRIVATE_ONLY_MONITOR_ID : TEST_MONITOR_ID;
        await db.update(monitor).set({ status }).where(eq(monitor.id, id));
        if (source === "private") {
          await db.insert(privateLocationMonitorStatus).values([
            {
              monitorId: id,
              privateLocationId: TEST_LOCATION_ID,
              status,
              cronTimestamp: 9500000,
            },
            {
              monitorId: id,
              privateLocationId: PRIVATE_LOCATION_2_ID,
              status,
              cronTimestamp: 9500000,
            },
          ]);
        } else {
          await db.insert(monitorStatusTable).values({
            monitorId: id,
            region: "ams",
            status,
            cronTimestamp: 9500000,
          });
        }
        if (status === "active") {
          await db.insert(incidentTable).values({
            monitorId: id,
            workspaceId,
            startedAt: new Date(9400000),
          });
        }
        for (let replay = 0; replay < 2; replay++) {
          const response = await checkerRoute.request(
            source === "private" ? "/updateStatusPrivate" : "/updateStatus",
            {
              method: "POST",
              headers: {
                Authorization: `Basic ${cronSecret}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                monitorId: String(id),
                privateLocationId: String(PRIVATE_LOCATION_2_ID),
                region: "ams",
                status,
                cronTimestamp: 9500000,
              }),
            },
          );
          expect(response.status).toBe(200);
        }
        const incidents = await db
          .select()
          .from(incidentTable)
          .where(eq(incidentTable.monitorId, id))
          .all();
        expect(incidents.length).toBe(1);
        expect(incidents[0]?.resolvedAt).toEqual(
          status === "error" ? null : new Date(9500000),
        );
        assertSpyCalls(mockEmailSendAlert, status === "error" ? 1 : 0);
        assertSpyCalls(mockEmailSendRecovery, status === "active" ? 1 : 0);
      });
    }
  }

  test("failed notification intent insert rolls back the entire private transition", async () => {
    await db.insert(privateLocationMonitorStatus).values({
      monitorId: PRIVATE_ONLY_MONITOR_ID,
      privateLocationId: TEST_LOCATION_ID,
      status: "error",
      cronTimestamp: 9600000,
    });
    const payload = {
      monitorId: String(PRIVATE_ONLY_MONITOR_ID),
      privateLocationId: String(PRIVATE_LOCATION_2_ID),
      status: "error",
      cronTimestamp: 9601000,
    };
    await db.run(
      sql.raw(`
      CREATE TRIGGER fail_status_notification
      BEFORE INSERT ON notification_trigger
      WHEN NEW.monitor_id = ${PRIVATE_ONLY_MONITOR_ID}
      BEGIN SELECT RAISE(ABORT, 'injected notification intent failure'); END
    `),
    );
    try {
      expect((await post(payload)).status).toBe(500);
      expect(
        await readRow(PRIVATE_ONLY_MONITOR_ID, PRIVATE_LOCATION_2_ID),
      ).toBeUndefined();
      const row = await db
        .select()
        .from(monitor)
        .where(eq(monitor.id, PRIVATE_ONLY_MONITOR_ID))
        .get();
      expect(row?.status).toBe("active");
      const incidents = await db
        .select()
        .from(incidentTable)
        .where(eq(incidentTable.monitorId, PRIVATE_ONLY_MONITOR_ID))
        .all();
      expect(incidents).toEqual([]);
      assertSpyCalls(mockEmailSendAlert, 0);
    } finally {
      await db.run(sql`DROP TRIGGER fail_status_notification`);
    }
    expect((await post(payload)).status).toBe(200);
    expect((await post(payload)).status).toBe(200);
    assertSpyCalls(mockEmailSendAlert, 1);
  });

  for (const source of ["private", "cloud"] as const) {
    test(`${source}: replay sends committed pending intent without creating another incident`, async () => {
      const id =
        source === "private" ? PRIVATE_ONLY_MONITOR_ID : TEST_MONITOR_ID;
      const incident = await db.transaction(async (tx) => {
        await tx
          .update(monitor)
          .set({ status: "error" })
          .where(eq(monitor.id, id));
        if (source === "private") {
          await tx.insert(privateLocationMonitorStatus).values([
            {
              monitorId: id,
              privateLocationId: TEST_LOCATION_ID,
              status: "error",
              cronTimestamp: 9700000,
            },
            {
              monitorId: id,
              privateLocationId: PRIVATE_LOCATION_2_ID,
              status: "error",
              cronTimestamp: 9700000,
            },
          ]);
        } else {
          await tx.insert(monitorStatusTable).values({
            monitorId: id,
            region: "ams",
            status: "error",
            cronTimestamp: 9700000,
          });
        }
        const [created] = await tx
          .insert(incidentTable)
          .values({ monitorId: id, workspaceId, startedAt: new Date(9700000) })
          .returning();
        if (!created) throw new Error("incident fixture was not inserted");
        await enqueueNotifications(
          {
            monitorId: String(id),
            cronTimestamp: 9700000,
            notifType: "alert",
            incidentId: created.id,
            regions: ["Original location"],
            message: "Original failure",
          },
          tx,
        );
        return created;
      });
      const pending = await db
        .select()
        .from(notificationTrigger)
        .where(eq(notificationTrigger.monitorId, id))
        .all();
      expect(pending.length).toBe(1);
      expect(pending[0]?.status).toBe("pending");

      for (let replay = 0; replay < 2; replay++) {
        const response = await checkerRoute.request(
          source === "private" ? "/updateStatusPrivate" : "/updateStatus",
          {
            method: "POST",
            headers: {
              Authorization: `Basic ${cronSecret}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              monitorId: String(id),
              privateLocationId: String(PRIVATE_LOCATION_2_ID),
              region: "ams",
              status: "error",
              cronTimestamp: 9700000,
              message: "Replay must not replace the saved failure",
            }),
          },
        );
        expect(response.status).toBe(200);
      }
      const incidents = await db
        .select()
        .from(incidentTable)
        .where(eq(incidentTable.monitorId, id))
        .all();
      expect(incidents.map((row) => row.id)).toEqual([incident.id]);
      assertSpyCalls(mockEmailSendAlert, 1);
      expect(mockEmailSendAlert.calls[0]?.args[0]).toMatchObject({
        message: "Original failure",
        regions: ["Original location"],
        incident: { id: incident.id },
      });
      const sent = await db
        .select()
        .from(notificationTrigger)
        .where(eq(notificationTrigger.monitorId, id))
        .all();
      expect(sent.length).toBe(1);
      expect(sent[0]?.status).toBe("sent");
    });
  }

  test("cloud: older and conflicting equal reports cannot undo recovery", async () => {
    const send = (status: string, cronTimestamp: number) =>
      checkerRoute.request("/updateStatus", {
        method: "POST",
        headers: {
          Authorization: `Basic ${cronSecret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          monitorId: String(TEST_MONITOR_ID),
          region: "ams",
          status,
          cronTimestamp,
        }),
      });
    expect((await send("error", 9800000)).status).toBe(200);
    expect((await send("active", 9801000)).status).toBe(200);
    const incidents = await db
      .select()
      .from(incidentTable)
      .where(eq(incidentTable.monitorId, TEST_MONITOR_ID))
      .all();
    expect(incidents.length).toBe(1);
    expect(incidents[0]?.resolvedAt).toEqual(new Date(9801000));

    expect((await send("error", 9800000)).status).toBe(200);
    expect((await send("error", 9801000)).status).toBe(200);
    const regional = await db
      .select()
      .from(monitorStatusTable)
      .where(eq(monitorStatusTable.monitorId, TEST_MONITOR_ID))
      .get();
    expect(regional?.status).toBe("active");
    expect(regional?.cronTimestamp).toBe(9801000);
    const aggregate = await db
      .select()
      .from(monitor)
      .where(eq(monitor.id, TEST_MONITOR_ID))
      .get();
    expect(aggregate?.status).toBe("active");
    expect(
      await db
        .select()
        .from(incidentTable)
        .where(eq(incidentTable.monitorId, TEST_MONITOR_ID))
        .all(),
    ).toEqual(incidents);
    assertSpyCalls(mockEmailSendAlert, 1);
    assertSpyCalls(mockEmailSendRecovery, 1);
  });

  test("cloud: the first event timestamps legacy regional status without changing it", async () => {
    await db.insert(monitorStatusTable).values({
      monitorId: TEST_MONITOR_ID,
      region: "ams",
      status: "active",
      createdAt: null,
      updatedAt: null,
    });
    const response = await checkerRoute.request("/updateStatus", {
      method: "POST",
      headers: {
        Authorization: `Basic ${cronSecret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        monitorId: String(TEST_MONITOR_ID),
        region: "ams",
        status: "active",
        cronTimestamp: 9900000,
      }),
    });
    expect(response.status).toBe(200);
    const regional = await db
      .select()
      .from(monitorStatusTable)
      .where(eq(monitorStatusTable.monitorId, TEST_MONITOR_ID))
      .get();
    expect(regional?.status).toBe("active");
    expect(regional?.cronTimestamp).toBe(9900000);
    assertSpyCalls(mockEmailSendAlert, 0);
    assertSpyCalls(mockEmailSendRecovery, 0);
  });

  for (const source of ["private", "cloud"] as const) {
    test(`${source}: split votes do not flap on replay and same-cron transitions each notify`, async () => {
      const id =
        source === "private" ? PRIVATE_ONLY_MONITOR_ID : TEST_MONITOR_ID;
      if (source === "private") {
        await db
          .update(privateLocationToMonitors)
          .set({ deletedAt: new Date() })
          .where(
            and(
              eq(privateLocationToMonitors.monitorId, id),
              eq(
                privateLocationToMonitors.privateLocationId,
                PRIVATE_LOCATION_3_ID,
              ),
            ),
          );
      } else {
        await db
          .update(monitor)
          .set({ regions: "ams,iad" })
          .where(eq(monitor.id, id));
      }
      const send = (location: 1 | 2, status: string, cronTimestamp: number) =>
        checkerRoute.request(
          source === "private" ? "/updateStatusPrivate" : "/updateStatus",
          {
            method: "POST",
            headers: {
              Authorization: `Basic ${cronSecret}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              monitorId: String(id),
              privateLocationId: String(
                location === 1 ? TEST_LOCATION_ID : PRIVATE_LOCATION_2_ID,
              ),
              region: location === 1 ? "ams" : "iad",
              status,
              cronTimestamp,
            }),
          },
        );
      try {
        expect((await send(1, "error", 10000000)).status).toBe(200);
        expect((await send(2, "error", 10001000)).status).toBe(200);
        expect((await send(2, "active", 10002000)).status).toBe(200);
        const closed = await db
          .select()
          .from(incidentTable)
          .where(eq(incidentTable.monitorId, id))
          .all();
        expect(closed.length).toBe(1);
        expect(closed[0]?.resolvedAt).toEqual(new Date(10002000));
        expect((await send(1, "error", 10000000)).status).toBe(200);
        expect((await send(1, "error", 10003000)).status).toBe(200);
        const aggregate = await db
          .select()
          .from(monitor)
          .where(eq(monitor.id, id))
          .get();
        expect(aggregate?.status).toBe("active");
        expect(
          await db
            .select()
            .from(incidentTable)
            .where(eq(incidentTable.monitorId, id))
            .all(),
        ).toEqual(closed);
        assertSpyCalls(mockEmailSendAlert, 1);
        assertSpyCalls(mockEmailSendRecovery, 1);

        expect((await send(1, "active", 10004000)).status).toBe(200);
        expect((await send(2, "error", 10004000)).status).toBe(200);
        expect((await send(2, "active", 10005000)).status).toBe(200);
        expect((await send(1, "error", 10005000)).status).toBe(200);
        expect((await send(2, "active", 10005000)).status).toBe(200);
        expect((await send(1, "error", 10005000)).status).toBe(200);
        const final = await db
          .select()
          .from(monitor)
          .where(eq(monitor.id, id))
          .get();
        expect(final?.status).toBe("error");
        const sameCron = await db
          .select()
          .from(notificationTrigger)
          .where(
            and(
              eq(notificationTrigger.monitorId, id),
              eq(notificationTrigger.cronTimestamp, 10005000),
            ),
          )
          .all();
        expect(sameCron.map((row) => row.status)).toEqual(["sent", "sent"]);
        assertSpyCalls(mockEmailSendAlert, 3);
        assertSpyCalls(mockEmailSendRecovery, 2);
      } finally {
        await db
          .update(monitor)
          .set({ regions: source === "private" ? "" : "ams" })
          .where(eq(monitor.id, id));
        await db
          .update(privateLocationToMonitors)
          .set({ deletedAt: null })
          .where(
            and(
              eq(privateLocationToMonitors.monitorId, id),
              eq(
                privateLocationToMonitors.privateLocationId,
                PRIVATE_LOCATION_3_ID,
              ),
            ),
          );
      }
    });
  }
});
