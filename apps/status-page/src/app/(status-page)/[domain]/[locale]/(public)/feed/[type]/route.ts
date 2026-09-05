import { statusLabel } from "@openstatus/utils";
import { TRPCError } from "@trpc/server";
import { Feed } from "feed";
import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";

import { getBaseUrl } from "../../../../../../../lib/base-url";
import { createStatusPageCaller } from "../../../../../../../lib/trpc/server";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  props: { params: Promise<{ domain: string; type: string }> },
) {
  try {
    const caller = await createStatusPageCaller(request);
    const { domain, type } = await props.params;

    if (!["rss", "atom"].includes(type)) return notFound();

    const page = await caller.get({ slug: domain });
    if (!page) return notFound();

    const baseUrl = getBaseUrl({
      slug: page.slug,
      customDomain: page.customDomain,
    });

    const feed = new Feed({
      id: `${baseUrl}/feed/${type}`,
      title: page.title,
      description: page.description,
      generator: "OpenStatus - Status Page Updates",
      feedLinks: {
        rss: `${baseUrl}/feed/rss`,
        atom: `${baseUrl}/feed/atom`,
      },
      link: baseUrl,
      author: {
        name: page.title,
        email:
          page.contactUrl?.startsWith("mailto:") && page.contactUrl !== null
            ? page.contactUrl.slice(7)
            : undefined,
        link: page.homepageUrl || baseUrl,
      },
      copyright: `Copyright ${new Date()
        .getFullYear()
        .toString()} openstatus.dev`,
      language: "en-US",
      updated: new Date(),
      ttl: 60,
    });

    for (const maintenance of page.maintenances ?? []) {
      const maintenanceUrl = `${baseUrl}/events/maintenance/${maintenance.id}`;
      feed.addItem({
        id: maintenanceUrl,
        title: `${statusLabel("maintenance")} - ${maintenance.title}`,
        link: maintenanceUrl,
        description: maintenance.message,
        date: maintenance.updatedAt ?? maintenance.createdAt ?? new Date(),
      });
    }

    for (const statusReport of page.statusReports ?? []) {
      const statusReportUrl = `${baseUrl}/events/report/${statusReport.id}`;
      const status = statusLabel(statusReport.status);
      const statusReportUpdates = (statusReport.statusReportUpdates ?? [])
        .map((update) => {
          const updateStatus = statusLabel(update.status);
          return `${updateStatus}: ${update.message}.`;
        })
        .join("\n\n");

      feed.addItem({
        id: statusReportUrl,
        title: `${status} - ${statusReport.title}`,
        link: statusReportUrl,
        description: statusReportUpdates,
        date: statusReport.updatedAt ?? statusReport.createdAt ?? new Date(),
      });
    }

    feed.items.sort((a, b) => a.date.getTime() - b.date.getTime());

    const res = type === "atom" ? feed.atom1() : feed.rss2();

    return new Response(res, {
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
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
