import type { Metadata } from "next";
import { LEVEL_NAME_MAX_LENGTH } from "@/domain/people";
import { formatCount } from "@/lib/format";
import { listLevelsForAdmin } from "@/server/services/admin-levels";
import { AdminShell } from "@/app/admin/admin-shell";
import { requireAdminPage } from "@/app/_lib/page-context";
import { Card, Item, ItemList } from "@/components/ui/card";
import { TextField } from "@/components/ui/fields";
import { ActionForm } from "@/components/forms/action-form";
import { InlineAction } from "@/components/forms/inline-action";
import { Reveal } from "@/components/forms/reveal";
import { outlineButton } from "@/components/ui/styles";
import { createLevelAction, deleteLevelAction, renameLevelAction } from "@/app/admin/levels/actions";

export const metadata: Metadata = { title: "Levels · Admin · OOOhm" };

export default async function LevelsPage() {
  const { actor, ctx, nav } = await requireAdminPage();
  const levels = await listLevelsForAdmin(ctx, actor);

  return (
    <AdminShell
      nav={nav}
      section="levels"
      title="Levels"
      description="Optional. Place people at a level, like Intern or Senior, so a leave type can give them more or less time off. Set the days on each leave type."
    >
      <Card aria-label="Add a level">
        <ActionForm action={createLevelAction} submitLabel="Add level" pendingLabel="Adding…" resetOnSuccess className="space-y-4">
          <TextField label="Name" name="name" required maxLength={LEVEL_NAME_MAX_LENGTH} autoComplete="off" />
        </ActionForm>
      </Card>

      {levels.length === 0 ? (
        <p className="text-muted">No levels yet.</p>
      ) : (
        <ItemList>
          {levels.map((l) => (
            <Item key={l.id} className="space-y-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-medium break-words">{l.name}</p>
                <p className="text-sm text-muted">{l.members === 0 ? "Nobody" : formatCount(l.members, "person", "people")}</p>
              </div>
              <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
                <Reveal label="Rename" ariaLabel={`Rename ${l.name}`}>
                  <ActionForm action={renameLevelAction} submitLabel="Save" pendingLabel="Saving…" buttonClassName={outlineButton} className="space-y-3">
                    <input type="hidden" name="id" value={l.id} />
                    <TextField label={`New name for ${l.name}`} name="name" required maxLength={LEVEL_NAME_MAX_LENGTH} defaultValue={l.name} />
                  </ActionForm>
                </Reveal>
                {l.members === 0 ? (
                  <InlineAction
                    action={deleteLevelAction}
                    fields={{ id: l.id }}
                    label="Delete"
                    ariaLabel={`Delete ${l.name}`}
                    pendingLabel="Deleting…"
                    variant="danger"
                    confirm={`Delete ${l.name}? Its allowance rules go with it.`}
                    confirmLabel="Yes, delete"
                  />
                ) : (
                  <p className="text-sm text-muted">To delete it, move its people to another level first.</p>
                )}
              </div>
            </Item>
          ))}
        </ItemList>
      )}
    </AdminShell>
  );
}
