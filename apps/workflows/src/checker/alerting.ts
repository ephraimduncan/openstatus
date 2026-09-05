import { getLogger } from "@logtape/logtape";
import {
  and,
  asc,
  count,
  db,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  or,
  schema,
} from "@openstatus/db";
import {
  selectMonitorSchema,
  selectNotificationSchema,
  selectWorkspaceSchema,
} from "@openstatus/db/src/schema";
import type { DrizzleTx } from "@openstatus/services";
import { Effect, Either, Schedule } from "effect";
import { z } from "zod";

import { checkerAudit } from "../utils/audit-log";
import { providerToFunction } from "./utils";

const logger = getLogger("workflow");
const leaseDuration = 5 * 60_000;
const notificationInputSchema = z.object({
  monitorId: z.string(),
  statusCode: z.number().optional(),
  message: z.string().optional(),
  notifType: z.enum(["alert", "recovery", "degraded"]),
  cronTimestamp: z.number(),
  incidentId: z.number().optional(),
  regions: z.array(z.string()).optional(),
  latency: z.number().optional(),
});
type NotificationInput = z.infer<typeof notificationInputSchema>;

/** Persist delivery intent in the same transaction as the monitor transition. */
export async function enqueueNotifications(
  input: NotificationInput,
  tx: DrizzleTx,
): Promise<void> {
  const notifications = await tx
    .select({ notificationId: schema.notificationsToMonitors.notificationId })
    .from(schema.notificationsToMonitors)
    .where(
      eq(schema.notificationsToMonitors.monitorId, Number(input.monitorId)),
    );
  if (notifications.length === 0) return;

  const payload = JSON.stringify(input);
  await tx.insert(schema.notificationTrigger).values(
    notifications.map(({ notificationId }) => ({
      notificationId,
      monitorId: Number(input.monitorId),
      cronTimestamp: input.cronTimestamp,
      status: "pending" as const,
      payload,
    })),
  );
}

/** Deliver pending intent; reject while any delivery still needs a retry. */
export async function triggerNotifications(
  input: Pick<NotificationInput, "monitorId" | "cronTimestamp">,
): Promise<{ notificationId: number; provider: string }[]> {
  const notifications = await db
    .select()
    .from(schema.notificationTrigger)
    .innerJoin(
      schema.notification,
      eq(schema.notification.id, schema.notificationTrigger.notificationId),
    )
    .innerJoin(
      schema.monitor,
      eq(schema.monitor.id, schema.notificationTrigger.monitorId),
    )
    .where(
      and(
        eq(schema.notificationTrigger.monitorId, Number(input.monitorId)),
        eq(schema.notificationTrigger.status, "pending"),
        lte(schema.notificationTrigger.cronTimestamp, input.cronTimestamp),
      ),
    )
    .orderBy(
      asc(schema.notificationTrigger.cronTimestamp),
      asc(schema.notificationTrigger.id),
    );
  const triggered: { notificationId: number; provider: string }[] = [];
  const failed = new Set<number>();

  for (const notif of notifications) {
    if (failed.has(notif.notification.id)) continue;
    const payload = notificationInputSchema.parse(
      JSON.parse(notif.notification_trigger.payload ?? "null"),
    );
    const monitor = selectMonitorSchema.parse(notif.monitor);
    const notification = selectNotificationSchema.parse(notif.notification);

    if (notification.provider === "sms" && !(await hasSmsQuota(notification))) {
      failed.add(notification.id);
      continue;
    }

    const token = crypto.randomUUID();
    const [claim] = await db
      .update(schema.notificationTrigger)
      .set({ leaseToken: token, leaseExpiresAt: Date.now() + leaseDuration })
      .where(
        and(
          eq(schema.notificationTrigger.id, notif.notification_trigger.id),
          eq(schema.notificationTrigger.status, "pending"),
          or(
            isNull(schema.notificationTrigger.leaseExpiresAt),
            lte(schema.notificationTrigger.leaseExpiresAt, Date.now()),
          ),
        ),
      )
      .returning({ id: schema.notificationTrigger.id });
    if (!claim) {
      const current = await db
        .select({ status: schema.notificationTrigger.status })
        .from(schema.notificationTrigger)
        .where(eq(schema.notificationTrigger.id, notif.notification_trigger.id))
        .get();
      if (current?.status === "pending") failed.add(notification.id);
      continue;
    }

    const owner = and(
      eq(schema.notificationTrigger.id, claim.id),
      eq(schema.notificationTrigger.status, "pending"),
      eq(schema.notificationTrigger.leaseToken, token),
    );
    let leaseLost = false;
    let delivered = false;
    let heartbeat = Promise.resolve();
    const timer = setInterval(() => {
      heartbeat = heartbeat
        .then(async () => {
          const renewed = await db
            .update(schema.notificationTrigger)
            .set({ leaseExpiresAt: Date.now() + leaseDuration })
            .where(owner)
            .returning({ id: schema.notificationTrigger.id });
          if (renewed.length === 0) leaseLost = true;
        })
        .catch(() => {
          leaseLost = true;
        });
    }, 30_000);

    try {
      const incident =
        payload.incidentId === undefined
          ? undefined
          : await db.query.incidentTable.findFirst({
              where: eq(schema.incidentTable.id, payload.incidentId),
            });
      const provider = providerToFunction[notification.provider];
      const send = {
        alert: provider.sendAlert,
        recovery: provider.sendRecovery,
        degraded: provider.sendDegraded,
      }[payload.notifType];
      const context = { ...payload, monitor, notification, incident };
      const result = await Effect.runPromise(
        Effect.tryPromise({
          try: () =>
            leaseLost
              ? Promise.reject(new Error("Notification lease lost"))
              : send(context),
          catch: () =>
            new Error(
              `Failed sending notification via ${notification.provider} for monitor ${monitor.id}`,
            ),
        }).pipe(
          Effect.retry({
            times: 3,
            schedule: Schedule.exponential("1000 millis"),
          }),
          Effect.either,
        ),
      );
      if (Either.isLeft(result) || leaseLost) {
        logger.error("Failed to send notification", {
          monitor_id: monitor.id,
          provider: notification.provider,
          notification_id: notification.id,
          notification_type: payload.notifType,
        });
        failed.add(notification.id);
        continue;
      }

      const [sent] = await db
        .update(schema.notificationTrigger)
        .set({ status: "sent", leaseToken: null, leaseExpiresAt: null })
        .where(owner)
        .returning({ id: schema.notificationTrigger.id });
      if (!sent) {
        failed.add(notification.id);
        continue;
      }
      delivered = true;
      triggered.push({
        notificationId: notification.id,
        provider: notification.provider,
      });
      await checkerAudit.publishAuditLog({
        id: `monitor:${monitor.id}`,
        action: "notification.sent",
        targets: [{ id: String(monitor.id), type: "monitor" }],
        metadata: {
          provider: notification.provider,
          cronTimestamp: payload.cronTimestamp,
          type: payload.notifType,
          notificationId: notification.id,
        },
      });
    } finally {
      clearInterval(timer);
      await heartbeat;
      if (!delivered) {
        await db
          .update(schema.notificationTrigger)
          .set({ leaseToken: null, leaseExpiresAt: null })
          .where(owner);
      }
    }
  }

  if (failed.size > 0)
    throw new Error(
      `Notification delivery pending for monitor ${input.monitorId}`,
    );
  return triggered;
}

async function hasSmsQuota(
  notification: z.infer<typeof selectNotificationSchema>,
): Promise<boolean> {
  if (notification.workspaceId === null) return false;
  const workspace = await db
    .select()
    .from(schema.workspace)
    .where(eq(schema.workspace.id, notification.workspaceId))
    .get();
  if (!workspace) return false;
  const data = selectWorkspaceSchema.parse(workspace);
  const oneMonthAgo = new Date();
  oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
  const smsNotifications = await db
    .select({ id: schema.notification.id })
    .from(schema.notification)
    .where(
      and(
        eq(schema.notification.workspaceId, notification.workspaceId),
        eq(schema.notification.provider, "sms"),
      ),
    );
  const [sent] = await db
    .select({ count: count() })
    .from(schema.notificationTrigger)
    .where(
      and(
        eq(schema.notificationTrigger.status, "sent"),
        gte(schema.notificationTrigger.cronTimestamp, oneMonthAgo.getTime()),
        inArray(
          schema.notificationTrigger.notificationId,
          smsNotifications.map(({ id }) => id),
        ),
      ),
    );
  return (sent?.count ?? 0) < data.limits["sms-limit"];
}
