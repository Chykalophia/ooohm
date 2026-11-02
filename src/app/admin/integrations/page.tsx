import type { Metadata } from "next";
import Link from "next/link";
import { listAdapters } from "@/server/services/integrations";
import { AdminShell } from "@/app/admin/admin-shell";
import { requireAdminPage } from "@/app/_lib/page-context";
import { Card, Item, ItemList } from "@/components/ui/card";
import { InlineAction } from "@/components/forms/inline-action";
import { cx, errorText, outlineButton, textLink } from "@/components/ui/styles";
import { syncAdapterAction } from "@/app/admin/integrations/actions";

export const metadata: Metadata = { title: "Connectors · Admin · OOOhm" };

export default async function IntegrationsPage() {
  const { actor, ctx, nav } = await requireAdminPage();
  const adapters = await listAdapters(ctx, actor);

  return (
    <AdminShell
      nav={nav}
      section="integrations"
      title="Connectors"
      description="Built-in connections to other systems, such as payroll or chat. Each one is checked when this page opens."
    >
      {adapters.length === 0 ? (
        <Card aria-label="No connectors" className="space-y-3">
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
        </Card>
      ) : (
        <ItemList>
          {adapters.map((a) => (
            <Item key={a.id} className="space-y-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-medium">{a.displayName}</p>
                <span className={cx("text-sm", a.ok ? "text-accent" : errorText)}>{a.ok ? "Connected" : "Not connected"}</span>
              </div>
              {a.detail && <p className="text-sm text-muted">{a.detail}</p>}
              {a.syncs && (
                <InlineAction action={syncAdapterAction} fields={{ adapterId: a.id }} label="Sync now" pendingLabel="Syncing…" className={outlineButton} />
              )}
            </Item>
          ))}
        </ItemList>
      )}
    </AdminShell>
  );
}
