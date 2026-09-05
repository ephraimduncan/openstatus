"use client";

import { createProtectedCookieKey } from "@openstatus/api/src/auth/protected";
import { Button } from "@openstatus/ui/components/ui/button";
import { useCookieState } from "@openstatus/ui/hooks/use-cookie-state";
import { useMutation } from "@tanstack/react-query";
import { useExtracted } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";

import {
  Section,
  SectionDescription,
  SectionHeader,
  SectionTitle,
} from "../../../../../../../components/content/section";
import { FormPassword } from "../../../../../../../components/forms/form-password";
import { useTRPC } from "../../../../../../../lib/trpc/client";

export function SectionPassword({ slug }: { slug: string }) {
  const t = useExtracted();
  const searchParams = useSearchParams();
  const trpc = useTRPC();
  const [_, setPassword] = useCookieState(createProtectedCookieKey(slug));
  const router = useRouter();
  const verifyPasswordMutation = useMutation(
    trpc.statusPage.verifyPassword.mutationOptions({}),
  );

  return (
    <Section className="bg-card m-auto w-full max-w-lg rounded-lg border p-4">
      <SectionHeader>
        <SectionTitle>{t("Protected Page")}</SectionTitle>
        <SectionDescription>
          {t("Enter the password to access the status page.")}
        </SectionDescription>
      </SectionHeader>
      <div className="flex flex-col gap-2">
        <FormPassword
          id="password-form"
          onSubmit={async (values) => {
            const result = await verifyPasswordMutation.mutateAsync({
              slug,
              password: values.password,
            });
            if (result) {
              setPassword(values.password);
              const redirect = searchParams.get("redirect");
              // Only allow safe relative paths to prevent XSS via javascript: URLs
              if (redirect?.startsWith("/") && !redirect.startsWith("//")) {
                router.push(redirect);
              } else {
                router.push("/");
              }
            }
          }}
        />
        <Button type="submit" form="password-form">
          {t("Submit")}
        </Button>
      </div>
    </Section>
  );
}
