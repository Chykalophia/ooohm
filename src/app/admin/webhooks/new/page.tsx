import type { Metadata } from "next";
import { AdminShell, requireAdminPage } from "@/app/admin/admin-shell";
import { RevealForm } from "@/app/admin/reveal-once";
import { card } from "@/app/styles";
import { createEndpointAction } from "@/app/admin/webhooks/actions";
import { EndpointFields } from "@/app/admin/webhooks/endpoint-fields";

export const metadata: Metadata = { title: "Add endpoint · Webhooks · Admin · OOOhm" };

export default async function NewWebhookPage() {
  const { userName, approvals } = await requireAdminPage();
  return (
    <AdminShell
      userName={userName}
      approvals={approvals}
      section="webhooks"
      title="Add endpoint"
      description="The endpoint gets the events you pick, from now on. You'll see its signing secret once, right after you add it."
    >
      <section aria-label="New endpoint" className={card}>
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
      </section>
    </AdminShell>
  );
}
