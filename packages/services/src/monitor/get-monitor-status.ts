import { and, db as defaultDb, eq, inArray, isNull } from "@openstatus/db";
import {
  type MonitorStatus,
  privateLocation,
  privateLocationMonitorStatus,
  privateLocationToMonitors,
  selectMonitorSchema,
} from "@openstatus/db/src/schema";
import { monitorStatusTable } from "@openstatus/db/src/schema/monitor_status/monitor_status";

import type { ServiceContext } from "../context";
import { getMonitorInWorkspace } from "./internal";
import { GetMonitorStatusInput } from "./schemas";

export type MonitorRegionStatus = {
  region: string;
  status: MonitorStatus;
};

export type GetMonitorStatusResult = {
  id: number;
  regions: MonitorRegionStatus[];
};

export async function getMonitorStatus(args: {
  ctx: ServiceContext;
  input: GetMonitorStatusInput;
}): Promise<GetMonitorStatusResult> {
  const { ctx } = args;
  const input = GetMonitorStatusInput.parse(args.input);
  const db = ctx.db ?? defaultDb;

  const record = await getMonitorInWorkspace({
    tx: db,
    id: input.monitorId,
    workspaceId: ctx.workspace.id,
  });
  const parsed = selectMonitorSchema.parse(record);

  const rows = await db
    .select({
      region: monitorStatusTable.region,
      status: monitorStatusTable.status,
    })
    .from(monitorStatusTable)
    .where(
      and(
        eq(monitorStatusTable.monitorId, record.id),
        inArray(monitorStatusTable.region, parsed.regions),
      ),
    )
    .all();

  const privateRows = await db
    .selectDistinct({
      privateLocationId: privateLocationMonitorStatus.privateLocationId,
      status: privateLocationMonitorStatus.status,
    })
    .from(privateLocationMonitorStatus)
    .innerJoin(
      privateLocationToMonitors,
      and(
        eq(
          privateLocationMonitorStatus.monitorId,
          privateLocationToMonitors.monitorId,
        ),
        eq(
          privateLocationMonitorStatus.privateLocationId,
          privateLocationToMonitors.privateLocationId,
        ),
      ),
    )
    .innerJoin(
      privateLocation,
      eq(privateLocationMonitorStatus.privateLocationId, privateLocation.id),
    )
    .where(
      and(
        eq(privateLocationMonitorStatus.monitorId, record.id),
        eq(privateLocation.workspaceId, ctx.workspace.id),
        isNull(privateLocationToMonitors.deletedAt),
      ),
    )
    .all();

  return {
    id: record.id,
    regions: [
      ...rows,
      ...privateRows.map((r) => ({
        region: String(r.privateLocationId),
        status: r.status,
      })),
    ],
  };
}
