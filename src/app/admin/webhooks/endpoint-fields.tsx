import { WEBHOOK_DESCRIPTION_MAX_LENGTH, WEBHOOK_EVENT_GROUPS } from "@/domain/integrations";
import { WEBHOOK_URL_MAX_LENGTH } from "@/domain/webhook-target";
import { TextField } from "@/app/admin/fields";

/**
 * The fields of a webhook endpoint form: URL, description, and the event types grouped
 * as checkboxes. The everyday groups (leave, balances, people) are open; the rest sit
 * in a collapsed "More events" so the form stays calm. A new endpoint starts with the
 * everyday groups ticked.
 */
export function EndpointFields({ endpoint }: { endpoint?: { url: string; description: string; eventTypes: readonly string[] } }) {
  const chosen = new Set(endpoint ? endpoint.eventTypes : WEBHOOK_EVENT_GROUPS.filter((g) => g.common).flatMap((g) => g.types));
  const group = (g: (typeof WEBHOOK_EVENT_GROUPS)[number]) => (
    <fieldset key={g.label} className="space-y-2">
      <legend className="text-sm font-medium">{g.label}</legend>
      <div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
        {g.types.map((type) => (
          <label key={type} className="flex cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" name="eventTypes" value={type} defaultChecked={chosen.has(type)} className="h-4 w-4 shrink-0 accent-[var(--accent)]" />
            <code className="font-mono text-[13px]">{type}</code>
          </label>
        ))}
      </div>
    </fieldset>
  );
  const rare = WEBHOOK_EVENT_GROUPS.filter((g) => !g.common);
  const rareChosen = rare.some((g) => g.types.some((t) => chosen.has(t)));

  return (
    <>
      <TextField
        label="Endpoint URL"
        name="url"
        type="url"
        required
        maxLength={WEBHOOK_URL_MAX_LENGTH}
        defaultValue={endpoint?.url}
        placeholder="https://example.com/ooohm/webhooks"
        hint="A public https:// address. OOOhm signs every request; the API guide (linked on the Webhooks page) shows how to verify it."
        autoComplete="off"
      />
      <TextField
        label="Description"
        name="description"
        optional
        maxLength={WEBHOOK_DESCRIPTION_MAX_LENGTH}
        defaultValue={endpoint?.description}
        hint="What this endpoint is for, so others know."
        autoComplete="off"
      />
      <div className="space-y-4">
        <p className="text-sm font-medium">Events to send</p>
        {WEBHOOK_EVENT_GROUPS.filter((g) => g.common).map(group)}
        <details open={rareChosen} className="space-y-4">
          <summary className="cursor-pointer text-sm text-muted hover:text-foreground">More events</summary>
          <div className="mt-4 space-y-4">{rare.map(group)}</div>
        </details>
      </div>
    </>
  );
}
