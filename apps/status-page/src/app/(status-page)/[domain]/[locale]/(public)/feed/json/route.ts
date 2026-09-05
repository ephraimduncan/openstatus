import { TRPCError } from "@trpc/server";
import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";

import { createStatusPageCaller } from "../../../../../../../lib/trpc/server";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  props: { params: Promise<{ domain: string }> },
) {
  try {
    const caller = await createStatusPageCaller(request);
    const { domain } = await props.params;

    const page = await caller.get({ slug: domain });

    if (!page) return notFound();

    const res = {
      title: page.title,
      description: page.description,
      status: page.status,
      updatedAt: new Date(),
      // @deprecated Use pageComponents instead
      monitors: page.monitors.map((monitor) => ({
        id: monitor.id,
        name: monitor.name,
        description: monitor.description,
        status: monitor.status,
      })),
      // New field - exposes the page component structure
      pageComponents: page.pageComponents.map((component) => ({
        id: component.id,
        name: component.name,
        description: component.description,
        monitorId: component.monitorId,
        order: component.order,
        groupId: component.groupId,
        groupOrder: component.groupOrder,
      })),
      pageComponentGroups: page.pageComponentGroups.map((group) => ({
        id: group.id,
        name: group.name,
      })),
      maintenances: page.maintenances.map((maintenance) => ({
        id: maintenance.id,
        name: maintenance.title,
        message: maintenance.message,
        from: maintenance.from,
        to: maintenance.to,
        updatedAt: maintenance.updatedAt,
        // @deprecated Use components instead - returning monitor IDs for backwards compatibility
        monitors: maintenance.maintenancesToPageComponents
          .map((item) => item.pageComponent.monitorId)
          .filter((id): id is number => id !== null),
        // New field - references page component IDs
        pageComponents: maintenance.maintenancesToPageComponents.map(
          (item) => item.pageComponentId,
        ),
      })),
      statusReports: page.statusReports.map((report) => ({
        id: report.id,
        title: report.title,
        updatedAt: report.updatedAt,
        status: report.status,
        // @deprecated Use components instead - returning monitor IDs for backwards compatibility
        monitors: report.statusReportsToPageComponents
          .map((item) => item.pageComponent.monitorId)
          .filter((id): id is number => id !== null),
        // New field - references page component IDs
        pageComponents: report.statusReportsToPageComponents.map(
          (item) => item.pageComponentId,
        ),
        statusReportUpdates: report.statusReportUpdates.map((update) => ({
          id: update.id,
          status: update.status,
          message: update.message,
          date: update.date,
          updatedAt: update.updatedAt,
        })),
      })),
    };

    return new Response(JSON.stringify(res), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control":
          page.accessType === "public"
            ? "public, max-age=60"
            : "private, no-store",
      },
    });
  } catch (error) {
    if (
      error instanceof TRPCError &&
      (error.code === "UNAUTHORIZED" || error.code === "FORBIDDEN")
    ) {
      return new Response(
        error.code === "UNAUTHORIZED" ? "Unauthorized" : "Forbidden",
        {
          status: error.code === "UNAUTHORIZED" ? 401 : 403,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }
    console.error("Error generating feed:", error);
    throw error;
  }
}
