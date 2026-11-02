"use server";

import { z } from "zod";
import { syncAdapterNow } from "@/server/services/integrations";
import type { FormState } from "@/app/form-state";
import { adminAction } from "@/app/admin/admin-action";

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export async function syncAdapterAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "adapter_sync",
    formData,
    z.object({ adapterId: z.string().min(1).max(40) }),
    async (ctx, actor, { adapterId }) => {
      const r = await syncAdapterNow(ctx, actor, adapterId);
      const skipped = r.users.skipped.length + r.balances.skipped.length;
      return (
        `Synced: ${count(r.users.created, "person added", "people added")} (waiting for you to activate them), ` +
        `${count(r.users.updated, "person renamed", "people renamed")}, ${count(r.balances.changed, "allowance changed", "allowances changed")}` +
        (skipped > 0 ? `, ${count(skipped, "entry", "entries")} skipped.` : ".")
      );
    },
    { not_found: "That integration isn't installed, or has nothing to sync." },
  );
}
