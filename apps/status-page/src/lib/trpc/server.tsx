import "server-only";
import { createTRPCContext } from "@openstatus/api";
import { statusPageRouter } from "@openstatus/api/src/router/statusPage";
import { createServerHelpers } from "@openstatus/api/src/rsc";
import type { NextRequest } from "next/server";

import { auth } from "../auth";
import { makeQueryClient } from "./query-client";

export const {
  trpc,
  getQueryClient,
  HydrateClient,
  prefetch,
  batchPrefetch,
  fetchQueryOrNotFound,
} = createServerHelpers({
  // Lazy: `../auth` imports this module, so referencing `auth` eagerly would
  // hit a circular-init TDZ.
  makeQueryClient,
  auth: () => auth(),
});

/** Keeps route-handler passwords, cookies, and sessions on the actual request. */
export async function createStatusPageCaller(request: NextRequest) {
  const context = await createTRPCContext({ req: request, auth: () => auth() });
  return statusPageRouter.createCaller(context);
}
