"use server";

import { z } from "zod";
import { formatCount } from "@/lib/format";
import { syncAdapterNow } from "@/server/services/integrations";
import type { FormState } from "@/components/forms/form-state";
import { adminAction } from "@/app/admin/admin-action";

export async function syncAdapterAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "adapter_sync",
    formData,
    z.object({ adapterId: z.string().min(1).max(40) }),
    async (ctx, actor, { adapterId }) => {
      const r = await syncAdapterNow(ctx, actor, adapterId);
      const skipped = r.users.skipped.length + r.balances.skipped.length;
      return (
        `Synced: ${formatCount(r.users.created, "person added", "people added")} (waiting for you to activate them), ` +
        `${formatCount(r.users.updated, "person renamed", "people renamed")}, ${formatCount(r.balances.changed, "allowance changed", "allowances changed")}` +
        (skipped > 0 ? `, ${formatCount(skipped, "entry", "entries")} skipped.` : ".")
      );
    },
    { not_found: "That integration isn't installed, or has nothing to sync." },
  );
}
