import { getLogger } from "@logtape/logtape";
import { and, eq, isNull, schema } from "@openstatus/db";
import type { MonitorStatus } from "@openstatus/db/src/schema";
import type { DrizzleTx } from "@openstatus/services";

import { checkerAudit } from "../utils/audit-log";

const logger = getLogger(["workflow"]);

type Incident = typeof schema.incidentTable.$inferSelect;

export type StatusChange = {
  changed: boolean;
  incidentId: number | undefined;
  incidents: Incident[];
};

/** Keep aggregate status and incident state in the caller's result transaction. */
export async function applyMonitorStatus({
  tx,
  monitor,
  status,
  cronTimestamp,
}: {
  tx: DrizzleTx;
  monitor: Pick<
    typeof schema.monitor.$inferSelect,
    "id" | "workspaceId" | "status"
  >;
  status: MonitorStatus;
  cronTimestamp: number;
}): Promise<StatusChange> {
  const changed = monitor.status !== status;
  if (changed) {
    await tx
      .update(schema.monitor)
      .set({ status })
      .where(eq(schema.monitor.id, monitor.id));
  }

  const openIncident = and(
    eq(schema.incidentTable.monitorId, monitor.id),
    isNull(schema.incidentTable.resolvedAt),
  );

  // Same-status reports can finish an interrupted transition from older writers.
  if (status === "error") {
    const existing = await tx
      .select()
      .from(schema.incidentTable)
      .where(openIncident)
      .get();
    if (existing) {
      return { changed, incidentId: existing.id, incidents: [] };
    }
    const incidents = await tx
      .insert(schema.incidentTable)
      .values({
        monitorId: monitor.id,
        workspaceId: monitor.workspaceId,
        startedAt: new Date(cronTimestamp),
      })
      .returning();
    return { changed: true, incidentId: incidents[0]?.id, incidents };
  }

  const incidents = await tx
    .update(schema.incidentTable)
    .set({ resolvedAt: new Date(cronTimestamp), autoResolved: true })
    .where(openIncident)
    .returning();
  return {
    changed: changed || incidents.length > 0,
    incidentId: incidents[0]?.id,
    incidents,
  };
}

/** Tinybird is best-effort and must only run after the database commits. */
export async function publishStatusAudit({
  monitorId,
  status,
  region,
  cronTimestamp,
  statusCode,
  message,
  latency,
  incidents = [],
}: {
  monitorId: string;
  status: MonitorStatus;
  region: string;
  cronTimestamp: number;
  statusCode?: number;
  message?: string;
  latency?: number;
  incidents?: Incident[];
}): Promise<void> {
  try {
    for (const incident of incidents) {
      await checkerAudit.publishAuditLog({
        id: `monitor:${monitorId}`,
        action: status === "error" ? "incident.created" : "incident.resolved",
        targets: [{ id: monitorId, type: "monitor" }],
        metadata: { cronTimestamp, incidentId: incident.id },
      });
    }
    await checkerAudit.publishAuditLog({
      id: `monitor:${monitorId}`,
      action:
        status === "error"
          ? "monitor.failed"
          : status === "degraded"
            ? "monitor.degraded"
            : "monitor.recovered",
      targets: [{ id: monitorId, type: "monitor" }],
      metadata: {
        region,
        statusCode: statusCode ?? -1,
        cronTimestamp,
        latency,
        ...(status === "error" ? { message } : {}),
      },
    });
  } catch (error) {
    logger.error("Failed to publish status audit log", {
      monitor_id: monitorId,
      error,
    });
  }
}
