import {
  StatusPageMain,
  StatusPageShell,
} from "@openstatus/ui/components/blocks/status-page-shell";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { EmbedShell } from "../../../../../components/layout/embed-shell";
import { Footer } from "../../../../../components/nav/footer";
import { Header } from "../../../../../components/nav/header";
import { FloatingButton } from "../../../../../components/status-page/floating-button";
import {
  getQueryClient,
  HydrateClient,
  trpc,
} from "../../../../../lib/trpc/server";

export default async function Layout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ domain: string }>;
}) {
  const { domain } = await params;
  const page = await getQueryClient().fetchQuery(
    trpc.statusPage.get.queryOptions({ slug: domain }),
  );
  if (!page) return notFound();
  return (
    <Suspense>
      <HydrateClient>
        <EmbedShell>
          <StatusPageShell className="group-data-[embed=true]/embed:min-h-0">
            <Header className="w-full border-b" />
            <StatusPageMain className="group-data-[embed=true]/embed:mx-0 group-data-[embed=true]/embed:max-w-none">
              {children}
            </StatusPageMain>
            <Footer className="w-full border-t" />
          </StatusPageShell>
        </EmbedShell>
        {page.createdAt ? (
          <FloatingButton
            pageId={page.id}
            token={page.createdAt.getTime().toString()}
          />
        ) : null}
      </HydrateClient>
    </Suspense>
  );
}
