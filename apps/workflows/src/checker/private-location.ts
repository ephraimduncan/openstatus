import { getLogger } from "@logtape/logtape";
import {
  and,
  db,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  schema,
  sql,
} from "@openstatus/db";
import { monitorStatusSchema } from "@openstatus/db/src/schema/monitors/validation";
import type { Context } from "hono";
import { z } from "zod";

import { env } from "../env";
import type { Env } from "../index";
import { enqueueNotifications, triggerNotifications } from "./alerting";
import {
  applyMonitorStatus,
  publishStatusAudit,
  type StatusChange,
} from "./incident-utils";

const logger = getLogger(["workflow"]);

const payloadSchema = z.object({
  monitorId: z.string(),
  privateLocationId: z.string(),
  status: monitorStatusSchema,
  cronTimestamp: z.number(),
  message: z.string().optional(),
  statusCode: z.number().optional(),
  latency: z.number().optional(),
});

export async function updateStatusPrivate(c: Context<Env>) {
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
    privateLocationId,
    status,
    cronTimestamp,
    message,
    statusCode,
    latency,
  } = result.data;

  const event = c.get("event");
  const monitorIdNumber = Number(monitorId);
  const privateLocationIdNumber = Number(privateLocationId);
  const statusUpdate = {
    status,
    message,
    region: privateLocationId,
    status_code: statusCode,
    cron_timestamp: cronTimestamp,
    latency_ms: latency,
    monitorId: monitorIdNumber,
  };
  if (event) event.status_update = statusUpdate;

  try {
    const outcome = await db.transaction(async (tx) => {
      const monitor = await tx
        .select()
        .from(schema.monitor)
        .where(eq(schema.monitor.id, monitorIdNumber))
        .get();

      if (!monitor || monitor.deletedAt || !monitor.active) return;

      const now = new Date();
      const activeMaintenance = await tx
        .select({ id: schema.maintenance.id })
        .from(schema.maintenance)
        .innerJoin(
          schema.maintenancesToPageComponents,
          eq(
            schema.maintenancesToPageComponents.maintenanceId,
            schema.maintenance.id,
          ),
        )
        .innerJoin(
          schema.pageComponent,
          eq(
            schema.pageComponent.id,
            schema.maintenancesToPageComponents.pageComponentId,
          ),
        )
        .where(
          and(
            lte(schema.maintenance.from, now),
            gte(schema.maintenance.to, now),
            eq(schema.pageComponent.monitorId, monitorIdNumber),
          ),
        )
        .get();
      if (activeMaintenance) return;

      const attachment = await tx
        .select({ name: schema.privateLocation.name })
        .from(schema.privateLocationToMonitors)
        .innerJoin(
          schema.privateLocation,
          eq(
            schema.privateLocation.id,
            schema.privateLocationToMonitors.privateLocationId,
          ),
        )
        .where(
          and(
            eq(schema.privateLocationToMonitors.monitorId, monitorIdNumber),
            eq(
              schema.privateLocationToMonitors.privateLocationId,
              privateLocationIdNumber,
            ),
            isNull(schema.privateLocationToMonitors.deletedAt),
          ),
        )
        .get();
      if (!attachment) return;

      const priorRow = await tx
        .select()
        .from(schema.privateLocationMonitorStatus)
        .where(
          and(
            eq(schema.privateLocationMonitorStatus.monitorId, monitorIdNumber),
            eq(
              schema.privateLocationMonitorStatus.privateLocationId,
              privateLocationIdNumber,
            ),
          ),
        )
        .get();
      if (
        priorRow &&
        (cronTimestamp < priorRow.cronTimestamp ||
          (cronTimestamp === priorRow.cronTimestamp &&
            status !== priorRow.status))
      ) {
        return;
      }

      await tx
        .insert(schema.privateLocationMonitorStatus)
        .values({
          monitorId: monitorIdNumber,
          privateLocationId: privateLocationIdNumber,
          status,
          cronTimestamp,
        })
        .onConflictDoUpdate({
          target: [
            schema.privateLocationMonitorStatus.monitorId,
            schema.privateLocationMonitorStatus.privateLocationId,
          ],
          set: { status, cronTimestamp, updatedAt: now },
          setWhere: sql`excluded.cron_timestamp > ${schema.privateLocationMonitorStatus.cronTimestamp}`,
        });

      const statusChanged = status !== (priorRow?.status ?? "active");
      const hasCloudRegions = monitor.regions.trim().length > 0;
      let transition: StatusChange | undefined;
      if (!hasCloudRegions) {
        const allLocations = await tx
          .select({ id: schema.privateLocationToMonitors.privateLocationId })
          .from(schema.privateLocationToMonitors)
          .where(
            and(
              eq(schema.privateLocationToMonitors.monitorId, monitorIdNumber),
              isNull(schema.privateLocationToMonitors.deletedAt),
            ),
          )
          .all();
        const locationIds = allLocations
          .map((location) => location.id)
          .filter((id): id is number => id !== null);
        const affectedLocations = await tx
          .select({ id: schema.privateLocationMonitorStatus.privateLocationId })
          .from(schema.privateLocationMonitorStatus)
          .where(
            and(
              eq(
                schema.privateLocationMonitorStatus.monitorId,
                monitorIdNumber,
              ),
              eq(schema.privateLocationMonitorStatus.status, status),
              inArray(
                schema.privateLocationMonitorStatus.privateLocationId,
                locationIds,
              ),
            ),
          )
          .all();

        if (
          affectedLocations.length >= allLocations.length / 2 &&
          (statusChanged || monitor.status === status)
        ) {
          transition = await applyMonitorStatus({
            tx,
            monitor,
            status,
            cronTimestamp,
          });
        }
      }

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
        regions: [attachment.name],
        latency,
        incidentId: transition?.incidentId,
      } satisfies Parameters<typeof enqueueNotifications>[0];
      if (hasCloudRegions ? statusChanged : transition?.changed) {
        await enqueueNotifications(notification, tx);
      }
      return { transition, statusChanged };
    });

    if (!outcome) return c.json({ success: true }, 200);

    if (outcome.statusChanged || outcome.transition?.changed) {
      await publishStatusAudit({
        monitorId,
        status,
        region: privateLocationId,
        cronTimestamp,
        statusCode,
        message,
        latency,
        incidents: outcome.transition?.incidents,
      });
    }
    const notifications = await triggerNotifications({
      monitorId,
      cronTimestamp,
    });
    if (event) {
      event.status_update = {
        ...statusUpdate,
        notificationTriggered: notifications.length > 0,
        notifications,
      };
    }
    return c.json({ success: true }, 200);
  } catch (error) {
    logger.error("Failed to update private location status", {
      monitor_id: monitorId,
      private_location_id: privateLocationId,
      error_message: error instanceof Error ? error.message : String(error),
    });
    return c.text("Internal Server Error", 500);
  }
}
