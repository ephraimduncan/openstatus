import { and, eq } from "@openstatus/db";
import { privateLocation } from "@openstatus/db/src/schema";

import { requireScope } from "../auth/require-scope";
import { type ServiceContext, getReadDb } from "../context";
import { NotFoundError } from "../errors";
import { GetPrivateLocationInput } from "./schemas";

/** Return the agent's bearer token only to actors with write access. */
export async function getPrivateLocation(args: {
  ctx: ServiceContext;
  input: GetPrivateLocationInput;
}) {
  requireScope(args.ctx, "write");
  const input = GetPrivateLocationInput.parse(args.input);
  const db = getReadDb(args.ctx);

  const row = await db.query.privateLocation.findFirst({
    where: and(
      eq(privateLocation.id, input.id),
      eq(privateLocation.workspaceId, args.ctx.workspace.id),
    ),
    with: {
      privateLocationToMonitors: {
        with: { monitor: true },
      },
    },
  });

  if (!row) throw new NotFoundError("private_location", input.id);

  return {
    ...row,
    monitors: row.privateLocationToMonitors
      .map((link) => link.monitor)
      .filter((m) => m !== null),
  };
}
