import { db, eq } from "@openstatus/db";
import { monitor } from "@openstatus/db/src/schema";
import {
  createMonitor,
  createTestWorkspace,
} from "@openstatus/db/src/test/factories";
import { expect } from "@std/expect";
import { test } from "@std/testing/bdd";

import { app } from "@/index";

import { MonitorSchema } from "./schema";

test("update the monitor", async () => {
  const res = await app.request("/v1/monitor/1", {
    method: "PUT",
    headers: {
      "x-openstatus-key": "1",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: "New Name",
    }),
  });
  const data = await res.json();
  const monitor = MonitorSchema.parse(data);
  expect(res.status).toBe(200);
  expect(monitor.name).toBe("New Name");
});

test("invalid monitor id should return 404", async () => {
  const res = await app.request("/v1/monitor/404", {
    method: "PUT",
    headers: {
      "x-openstatus-key": "1",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      /* */
    }),
  });

  expect(res.status).toBe(404);
});

test("no auth key should return 401", async () => {
  const res = await app.request("/v1/monitor/2", {
    method: "PUT",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      /* */
    }),
  });

  expect(res.status).toBe(401);
});

test("name-only update preserves timeout and configured monitoring behavior", async () => {
  const { workspace } = await createTestWorkspace();
  const original = await createMonitor(workspace.id, {
    jobType: "http",
    timeout: 12000,
    active: true,
    public: true,
    retry: 7,
    followRedirects: false,
    method: "POST",
    body: "request body",
    regions: "ams",
    headers: JSON.stringify([{ key: "x-test", value: "preserved" }]),
  });
  const request = (body: Record<string, unknown>) =>
    app.request(`/v1/monitor/${original.id}`, {
      method: "PUT",
      headers: {
        "x-openstatus-key": String(workspace.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

  const renamed = await request({ name: "Renamed monitor" });
  expect(renamed.status).toBe(200);
  expect(await renamed.json()).toMatchObject({
    name: "Renamed monitor",
    timeout: 12000,
    regions: ["ams"],
  });
  expect(
    await db.query.monitor.findFirst({ where: eq(monitor.id, original.id) }),
  ).toMatchObject({
    name: "Renamed monitor",
    timeout: 12000,
    active: true,
    public: true,
    retry: 7,
    followRedirects: false,
    method: "POST",
    body: "request body",
    regions: "ams",
    headers: JSON.stringify([{ key: "x-test", value: "preserved" }]),
  });

  const changed = await request({ timeout: 9000, active: false });
  expect(changed.status).toBe(200);
  expect(
    await db.query.monitor.findFirst({ where: eq(monitor.id, original.id) }),
  ).toMatchObject({ timeout: 9000, active: false });
});

for (const jobType of ["http", "tcp", "dns"] as const) {
  test(`${jobType} update preserves omitted timeout and accepts an explicit timeout`, async () => {
    const { workspace } = await createTestWorkspace();
    const original = await createMonitor(workspace.id, {
      jobType,
      timeout: 12000,
    });
    const request =
      jobType === "http"
        ? { url: "https://example.com", method: "GET" }
        : jobType === "tcp"
          ? { host: "example.com", port: 443 }
          : { uri: "example.com" };

    for (const timeout of [undefined, 0]) {
      const res = await app.request(`/v1/monitor/${jobType}/${original.id}`, {
        method: "PUT",
        headers: {
          "x-openstatus-key": String(workspace.id),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Updated monitor",
          frequency: "10m",
          regions: ["ams"],
          request,
          timeout,
        }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        name: "Updated monitor",
        jobType,
        timeout: timeout === undefined ? 12000 : 0,
      });
      expect(
        await db.query.monitor.findFirst({
          where: eq(monitor.id, original.id),
        }),
      ).toMatchObject({ jobType, timeout: timeout === undefined ? 12000 : 0 });
    }
  });
}
