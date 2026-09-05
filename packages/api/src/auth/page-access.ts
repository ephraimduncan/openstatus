import type { Page } from "@openstatus/db/src/schema";

import { isEmailDomainAuthorized, isIpAuthorized } from "./access-predicates";

export type PageAccessResult =
  | { ok: true }
  | { ok: false; status: 401 | 403; body: string };

/** Applies the same access decision to RPC, feeds, and status-page content. */
export function evaluatePageAccess(input: {
  accessType: Page["accessType"];
  passwordAuthorized: boolean;
  authEmail: string | null | undefined;
  authEmailDomains: string[] | null;
  clientIp: string | null | undefined;
  allowedIpRanges: string[] | null;
}): PageAccessResult {
  switch (input.accessType) {
    case "public":
      return { ok: true };

    case "password":
      return input.passwordAuthorized
        ? { ok: true }
        : { ok: false, status: 401, body: "Unauthorized" };

    case "email-domain":
      return isEmailDomainAuthorized(input.authEmail, input.authEmailDomains)
        ? { ok: true }
        : { ok: false, status: 403, body: "Forbidden" };

    case "ip-restriction":
      return isIpAuthorized(input.clientIp, input.allowedIpRanges)
        ? { ok: true }
        : { ok: false, status: 403, body: "Forbidden" };

    default:
      // Unknown access type → deny.
      return { ok: false, status: 403, body: "Forbidden" };
  }
}
