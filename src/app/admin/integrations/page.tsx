import type { Metadata } from "next";
import Link from "next/link";
import { listAdapters } from "@/server/services/integrations";
import { AdminShell, requireAdminPage } from "@/app/admin/admin-shell";
import { InlineAction } from "@/app/admin/forms";
import { card, outlineButton, textLink } from "@/app/styles";
import { syncAdapterAction } from "@/app/admin/integrations/actions";

export const metadata: Metadata = { title: "Connectors · Admin · OOOhm" };

export default async function IntegrationsPage() {
  const { actor, ctx, userName, approvals } = await requireAdminPage();
  const adapters = await listAdapters(ctx, actor);

  return (
    <AdminShell
      userName={userName}
      approvals={approvals}
      section="integrations"
      title="Connectors"
      description="Built-in connections to other systems, such as payroll or chat. Each one is checked when this page opens."
    >
      {adapters.length === 0 ? (
        <section aria-label="No connectors" className={`${card} space-y-3`}>
          <p className="font-medium">No connectors are installed.</p>
          <p className="text-sm text-muted">
            You can still connect other apps today: send them events with{" "}
            <Link href="/admin/webhooks" className={textLink}>
              webhooks
            </Link>
            , or let them read OOOhm with an{" "}
            <Link href="/admin/api-keys" className={textLink}>
              API key
            </Link>
            .
          </p>
        </section>
      ) : (
        <ul className="divide-y divide-border rounded-2xl border border-border bg-surface">
          {adapters.map((a) => (
            <li key={a.id} className="space-y-2 p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-medium">{a.displayName}</p>
                <span className={`text-sm ${a.ok ? "text-accent" : "text-red-700 dark:text-red-400"}`}>{a.ok ? "Connected" : "Not connected"}</span>
              </div>
              {a.detail && <p className="text-sm text-muted">{a.detail}</p>}
              {a.syncs && (
                <InlineAction action={syncAdapterAction} fields={{ adapterId: a.id }} label="Sync now" pendingLabel="Syncing…" className={outlineButton} />
              )}
            </li>
          ))}
        </ul>
      )}
    </AdminShell>
  );
}
