import type { Metadata } from "next";
import { API_KEY_NAME_MAX_LENGTH } from "@/domain/integrations";
import { personLabel } from "@/domain/person";
import { formatInstantDateTime } from "@/lib/format";
import { listApiKeys } from "@/server/services/api-keys";
import { revokeApiKeyAction, createApiKeyAction } from "@/app/admin/api-keys/actions";
import { AdminShell } from "@/app/admin/admin-shell";
import { requireAdminPage } from "@/app/_lib/page-context";
import { Card, Item, ItemList } from "@/components/ui/card";
import { TextField } from "@/components/ui/fields";
import { InlineAction } from "@/components/forms/inline-action";
import { RevealForm } from "@/components/forms/reveal-form";
import { textLink } from "@/components/ui/styles";

export const metadata: Metadata = { title: "API keys · Admin · OOOhm" };

export default async function ApiKeysPage() {
  const { actor, ctx, nav } = await requireAdminPage();
  const { keys, timezone } = await listApiKeys(ctx, actor);
  const at = (d: Date) => formatInstantDateTime(d, timezone);

  return (
    <AdminShell
      nav={nav}
      section="api-keys"
      title="API keys"
      description={
        <>
          Keys let other apps read people, leave, balances, holidays and events through the REST API, described at{" "}
          <a href="/api/v1/openapi.json" className={textLink}>
            /api/v1/openapi.json
          </a>
          . A key can read everything in the company but change nothing, and never sees request notes.
        </>
      }
    >
      <Card aria-label="Create a key">
        <RevealForm
          action={createApiKeyAction}
          submitLabel="Create key"
          pendingLabel="Creating…"
          valueLabel="API key"
          note="Copy it into the app that will use it now. OOOhm stores only a hash, so it can't show it again. Send it as Authorization: Bearer <key>."
          className="space-y-4"
        >
          <TextField label="Name" name="name" required maxLength={API_KEY_NAME_MAX_LENGTH} hint="Which app uses it, e.g. Payroll export." autoComplete="off" />
        </RevealForm>
      </Card>

      {keys.length === 0 ? (
        <p className="text-muted">No keys yet.</p>
      ) : (
        <ItemList>
          {keys.map((k) => (
            <Item key={k.id} className="space-y-1.5 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-medium break-words">{k.name}</p>
                <span className={k.revokedAt ? "text-muted" : "text-accent"}>{k.revokedAt ? "Revoked" : "Active"}</span>
              </div>
              <p className="text-muted">
                <code className="font-mono text-foreground">{k.prefix}…</code> · {k.scopes.join(", ")} · created {at(k.createdAt)}
                {k.createdByEmail && ` by ${personLabel({ name: k.createdByName ?? "", email: k.createdByEmail })}`}
              </p>
              <p className="text-muted">
                {k.revokedAt ? `Revoked ${at(k.revokedAt)}.` : k.lastUsedAt ? `Last used ${at(k.lastUsedAt)}.` : "Not used yet."}
              </p>
              {!k.revokedAt && (
                <InlineAction
                  action={revokeApiKeyAction}
                  fields={{ id: k.id }}
                  label="Revoke"
                  ariaLabel={`Revoke ${k.name}`}
                  pendingLabel="Revoking…"
                  variant="danger"
                  confirm={`Revoke ${k.name}? Apps using it stop working at once.`}
                  confirmLabel="Yes, revoke"
                />
              )}
            </Item>
          ))}
        </ItemList>
      )}
    </AdminShell>
  );
}
