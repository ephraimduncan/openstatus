import { evaluatePageAccess } from "@openstatus/api/src/auth/page-access";
import { expect } from "@std/expect";
import { describe, test } from "@std/testing/bdd";

const base = {
  passwordAuthorized: false,
  authEmail: null,
  authEmailDomains: null,
  clientIp: null,
  allowedIpRanges: null,
} as const;

describe("evaluatePageAccess", () => {
  test("public → ok", () => {
    expect(evaluatePageAccess({ ...base, accessType: "public" })).toEqual({
      ok: true,
    });
  });

  describe("password", () => {
    test("authorized → ok", () => {
      expect(
        evaluatePageAccess({
          ...base,
          accessType: "password",
          passwordAuthorized: true,
        }),
      ).toEqual({ ok: true });
    });

    test("not authorized → 401", () => {
      expect(
        evaluatePageAccess({
          ...base,
          accessType: "password",
          passwordAuthorized: false,
        }),
      ).toMatchObject({ ok: false, status: 401 });
    });
  });

  describe("email-domain", () => {
    test("allowed domain → ok", () => {
      expect(
        evaluatePageAccess({
          ...base,
          accessType: "email-domain",
          authEmail: "alice@acme.com",
          authEmailDomains: ["acme.com"],
        }),
      ).toEqual({ ok: true });
    });

    test("no session → 403", () => {
      expect(
        evaluatePageAccess({
          ...base,
          accessType: "email-domain",
          authEmailDomains: ["acme.com"],
        }),
      ).toMatchObject({ ok: false, status: 403 });
    });

    test("wrong domain → 403", () => {
      expect(
        evaluatePageAccess({
          ...base,
          accessType: "email-domain",
          authEmail: "bob@evil.com",
          authEmailDomains: ["acme.com"],
        }),
      ).toMatchObject({ ok: false, status: 403 });
    });

    test("empty authEmailDomains → 403", () => {
      expect(
        evaluatePageAccess({
          ...base,
          accessType: "email-domain",
          authEmail: "alice@acme.com",
          authEmailDomains: [],
        }),
      ).toMatchObject({ ok: false, status: 403 });
    });
  });

  describe("ip-restriction", () => {
    test("allowed IP → ok", () => {
      expect(
        evaluatePageAccess({
          ...base,
          accessType: "ip-restriction",
          clientIp: "10.0.0.5",
          allowedIpRanges: ["10.0.0.0/24"],
        }),
      ).toEqual({ ok: true });
    });

    test("disallowed IP → 403", () => {
      expect(
        evaluatePageAccess({
          ...base,
          accessType: "ip-restriction",
          clientIp: "192.168.1.1",
          allowedIpRanges: ["10.0.0.0/24"],
        }),
      ).toMatchObject({ ok: false, status: 403 });
    });

    test("missing IP is denied", () => {
      expect(
        evaluatePageAccess({
          ...base,
          accessType: "ip-restriction",
          allowedIpRanges: ["10.0.0.0/24"],
        }),
      ).toMatchObject({ ok: false, status: 403 });
    });
  });
});
