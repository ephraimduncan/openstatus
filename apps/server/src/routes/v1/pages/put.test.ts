import { db, eq } from "@openstatus/db";
import { page, pageComponent } from "@openstatus/db/src/schema";
import {
  createMonitor,
  createPage,
  createPageComponent,
  createTestWorkspace,
} from "@openstatus/db/src/test/factories";
import { expect } from "@std/expect";
import { test } from "@std/testing/bdd";

import { app } from "@/index";

import { PageSchema } from "./schema";

test("update the page with monitor ids", async () => {
  const res = await app.request("/v1/page/1", {
    method: "PUT",
    headers: {
      "x-openstatus-key": "1",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title: "New Title",
      monitors: [1, 2],
    }),
  });

  const result = PageSchema.safeParse(await res.json());

  expect(res.status).toBe(200);
  expect(result.success).toBe(true);
  expect(result.data?.title).toBe("New Title");
  expect(result.data?.monitors).toEqual([1, 2]);
});

test("update the page with monitor objects", async () => {
  const res = await app.request("/v1/page/1", {
    method: "PUT",
    headers: {
      "x-openstatus-key": "1",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      monitors: [
        { monitorId: 1, order: 1 },
        { monitorId: 2, order: 2 },
      ],
    }),
  });

  const result = PageSchema.safeParse(await res.json());

  expect(res.status).toBe(200);
  expect(result.success).toBe(true);
  expect(result.data?.monitors).toEqual([
    { monitorId: 1, order: 1 },
    { monitorId: 2, order: 2 },
  ]);
});

test("update the page with invalid monitors should return 400", async () => {
  const res = await app.request("/v1/page/1", {
    method: "PUT",
    headers: {
      "x-openstatus-key": "1",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      monitors: [404],
    }),
  });
  expect(res.status).toBe(400);
});

test("invalid page id should return 404", async () => {
  const res = await app.request("/v1/page/404", {
    method: "PUT",
    headers: {
      "x-openstatus-key": "1",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      acknowledgedAt: new Date().toISOString(),
    }),
  });

  expect(res.status).toBe(404);
});

test("no auth key should return 401", async () => {
  const res = await app.request("/v1/page/2", {
    method: "PUT",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      acknowledgedAt: new Date().toISOString(),
    }),
  });
  expect(res.status).toBe(401);
});

for (const accessType of ["password", "email-domain"] as const) {
  test(`title-only update preserves ${accessType} settings and components`, async () => {
    const { workspace } = await createTestWorkspace();
    const monitor = await createMonitor(workspace.id);
    const original = await createPage(workspace.id, {
      customDomain: "status.example.com",
      accessType,
      password: "page-password",
      passwordProtected: accessType === "password",
      authEmailDomains: "example.com",
      showMonitorValues: false,
    });
    const component = await createPageComponent(workspace.id, original.id, {
      type: "monitor",
      monitorId: monitor.id,
      order: 7,
    });
    const staticComponent = await createPageComponent(
      workspace.id,
      original.id,
    );
    const request = (body: Record<string, unknown>) =>
      app.request(`/v1/page/${original.id}`, {
        method: "PUT",
        headers: {
          "x-openstatus-key": String(workspace.id),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

    const renamed = await request({ title: "Renamed page" });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({
      title: "Renamed page",
      customDomain: "status.example.com",
      accessType,
      monitors: [monitor.id],
    });
    expect(
      await db.query.page.findFirst({ where: eq(page.id, original.id) }),
    ).toMatchObject({
      title: "Renamed page",
      customDomain: "status.example.com",
      accessType,
      password: "page-password",
      passwordProtected: accessType === "password",
      authEmailDomains: "example.com",
      showMonitorValues: false,
    });
    expect(
      await db
        .select()
        .from(pageComponent)
        .where(eq(pageComponent.pageId, original.id))
        .orderBy(pageComponent.id),
    ).toEqual([component, staticComponent]);

    const cleared = await request({ monitors: [] });
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).monitors).toEqual([]);
    expect(
      await db
        .select()
        .from(pageComponent)
        .where(eq(pageComponent.pageId, original.id)),
    ).toEqual([staticComponent]);

    const opened = await request({ accessType: "public" });
    expect(opened.status).toBe(200);
    expect(await opened.json()).toMatchObject({
      accessType: "public",
      passwordProtected: false,
    });
    const fetched = await app.request(`/v1/page/${original.id}`, {
      headers: { "x-openstatus-key": String(workspace.id) },
    });
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toMatchObject({
      accessType: "public",
      passwordProtected: false,
    });
  });
}

test("explicit domain and legacy password updates still apply", async () => {
  const { workspace } = await createTestWorkspace();
  const original = await createPage(workspace.id, {
    customDomain: "status.example.com",
  });
  for (const body of [
    { customDomain: "", passwordProtected: true, password: "page-password" },
    { customDomain: null, passwordProtected: false },
  ]) {
    const res = await app.request(`/v1/page/${original.id}`, {
      method: "PUT",
      headers: {
        "x-openstatus-key": String(workspace.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    expect(
      await db.query.page.findFirst({ where: eq(page.id, original.id) }),
    ).toMatchObject({
      customDomain: "",
      accessType: body.passwordProtected ? "password" : "public",
    });
  }
});
