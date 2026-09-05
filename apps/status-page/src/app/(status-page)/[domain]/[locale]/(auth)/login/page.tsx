"use client";

import { useQuery } from "@tanstack/react-query";
import { notFound, useParams } from "next/navigation";

import { useTRPC } from "../../../../../../lib/trpc/client";
import { SectionMagicLink } from "./_components/section-magic-link";
import { SectionPassword } from "./_components/section-password";

export default function LoginPage() {
  const { domain } = useParams<{ domain: string }>();
  const trpc = useTRPC();
  const { data: page } = useQuery(
    trpc.statusPage.getGate.queryOptions({ slug: domain }),
  );

  if (page?.accessType === "password") {
    return <SectionPassword slug={page.slug} />;
  }

  if (page?.accessType === "email-domain") {
    return <SectionMagicLink />;
  }

  return notFound();
}
