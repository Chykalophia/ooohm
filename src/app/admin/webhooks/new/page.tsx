import type { Metadata } from "next";
import { AdminShell } from "@/app/admin/admin-shell";
import { requireAdminPage } from "@/app/_lib/page-context";
import { Card } from "@/components/ui/card";
import { RevealForm } from "@/components/forms/reveal-form";

import { createEndpointAction } from "@/app/admin/webhooks/actions";
import { EndpointFields } from "@/app/admin/webhooks/endpoint-fields";

export const metadata: Metadata = { title: "Add endpoint · Webhooks · Admin · OOOhm" };

export default async function NewWebhookPage() {
  const { nav } = await requireAdminPage();
  return (
    <AdminShell
      nav={nav}
      section="webhooks"
      title="Add endpoint"
      description="The endpoint gets the events you pick, from now on. You'll see its signing secret once, right after you add it."
    >
      <Card aria-label="New endpoint">
        <RevealForm
          action={createEndpointAction}
          submitLabel="Add endpoint"
          pendingLabel="Adding…"
          valueLabel="Signing secret"
          note="Store it with the app that receives the webhooks now. It won't be shown again; if it's lost, rotate it on the endpoint's page."
          hrefLabel="Go to the endpoint"
          hideFormOnReveal
        >
          <EndpointFields />
        </RevealForm>
      </Card>
    </AdminShell>
  );
}
