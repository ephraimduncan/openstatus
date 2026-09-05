import { getLogger } from "@logtape/logtape";
import { and, db, eq, inArray, schema, sql } from "@openstatus/db";
import { monitorRegions } from "@openstatus/db/src/schema/constants";
import {
  monitorStatusSchema,
  selectMonitorSchema,
} from "@openstatus/db/src/schema/monitors/validation";
import { Hono } from "hono";
import { z } from "zod";

import { env } from "../env";
import type { Env } from "../index";
import { enqueueNotifications, triggerNotifications } from "./alerting";
import { applyMonitorStatus, publishStatusAudit } from "./incident-utils";
import { updateStatusPrivate } from "./private-location";

export const checkerRoute = new Hono<Env>();

checkerRoute.post("/updateStatusPrivate", updateStatusPrivate);

const payloadSchema = z.object({
  monitorId: z.string(),
  message: z.string().optional(),
  statusCode: z.number().optional(),
  region: z.enum(monitorRegions),
  cronTimestamp: z.number(),
  status: monitorStatusSchema,
  latency: z.number().optional(),
});

const logger = getLogger(["workflow"]);

checkerRoute.post("/updateStatus", async (c) => {
  const auth = c.req.header("Authorization");
  if (auth !== `Basic ${env().CRON_SECRET}`) {
    logger.error("Unauthorized");
    return c.text("Unauthorized", 401);
  }

  const result = payloadSchema.safeParse(await c.req.json());
  if (!result.success) {
    return c.text("Unprocessable Entity", 422);
  }

  const {
    monitorId,
    message,
    region,
    statusCode,
    cronTimestamp,
    status,
    latency,
  } = result.data;

  try {
    const outcome = await db.transaction(async (tx) => {
      const currentMonitor = await tx
        .select()
        .from(schema.monitor)
        .where(eq(schema.monitor.id, Number(monitorId)))
        .get();
      const monitor = selectMonitorSchema.parse(currentMonitor);
      const priorRow = await tx
        .select()
        .from(schema.monitorStatusTable)
        .where(
          and(
            eq(schema.monitorStatusTable.monitorId, monitor.id),
            eq(schema.monitorStatusTable.region, region),
          ),
        )
        .get();
      if (
        priorRow?.cronTimestamp != null &&
        (cronTimestamp < priorRow.cronTimestamp ||
          (cronTimestamp === priorRow.cronTimestamp &&
            status !== priorRow.status))
      ) {
        return;
      }

      await tx
        .insert(schema.monitorStatusTable)
        .values({ status, region, monitorId: monitor.id, cronTimestamp })
        .onConflictDoUpdate({
          target: [
            schema.monitorStatusTable.monitorId,
            schema.monitorStatusTable.region,
          ],
          set: { status, cronTimestamp, updatedAt: new Date() },
          setWhere: sql`${schema.monitorStatusTable.cronTimestamp} IS NULL OR excluded.cron_timestamp > ${schema.monitorStatusTable.cronTimestamp}`,
        });

      const affectedRegions = await tx
        .select({ region: schema.monitorStatusTable.region })
        .from(schema.monitorStatusTable)
        .where(
          and(
            eq(schema.monitorStatusTable.monitorId, monitor.id),
            eq(schema.monitorStatusTable.status, status),
            inArray(schema.monitorStatusTable.region, monitor.regions),
          ),
        )
        .all();
      if (affectedRegions.length === 0) return;

      const statusChanged = status !== (priorRow?.status ?? "active");
      const transition =
        affectedRegions.length >= monitor.regions.length / 2 &&
        (statusChanged || monitor.status === status)
          ? await applyMonitorStatus({ tx, monitor, status, cronTimestamp })
          : undefined;
      const notification = {
        monitorId,
        statusCode,
        message,
        notifType:
          status === "error"
            ? "alert"
            : status === "active"
              ? "recovery"
              : "degraded",
        cronTimestamp,
        regions: affectedRegions.map((entry) => entry.region),
        latency,
        incidentId: transition?.incidentId,
      } satisfies Parameters<typeof enqueueNotifications>[0];
      if (transition?.changed) {
        await enqueueNotifications(notification, tx);
      }
      return { transition, affectedRegionCount: affectedRegions.length };
    });

    if (!outcome) return c.json({ success: true }, 200);

    await publishStatusAudit({
      monitorId,
      status,
      region,
      cronTimestamp,
      statusCode,
      message,
      latency,
      incidents: outcome.transition?.incidents,
    });
    const notifications = await triggerNotifications({
      monitorId,
      cronTimestamp,
    });
    const event = c.get("event");
    if (event) {
      event.status_update = {
        status,
        message,
        region,
        status_code: statusCode,
        cron_timestamp: cronTimestamp,
        latency_ms: latency,
        affectedRegionsCount: outcome.affectedRegionCount,
        monitorId: Number(monitorId),
        notificationTriggered: notifications.length > 0,
        notifications,
      };
    }
    return c.text("Ok", 200);
  } catch (error) {
    logger.error("Failed to update monitor status", {
      monitor_id: monitorId,
      region,
      error,
    });
    return c.text("Internal Server Error", 500);
  }
});
