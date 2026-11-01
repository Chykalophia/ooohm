import { and, asc, eq, isNull } from "drizzle-orm";
import { Logo } from "@/components/logo";
import { db, schema } from "@/db";
import { requireUser } from "@/lib/auth";
import { SignOutButton } from "./sign-out-button";

export default async function HomePage() {
  const user = await requireUser();
  const year = new Date().getFullYear();

  // M1 placeholder dashboard: proves auth, the schema and the seed data line up.
  // Real balances (minus taken/pending days) arrive with the policy engine in M3.
  const rows = user.companyId
    ? await db
        .select({
          id: schema.leaveTypes.id,
          name: schema.leaveTypes.name,
          code: schema.leaveTypes.code,
          color: schema.leaveTypes.color,
          days: schema.allowances.days,
        })
        .from(schema.leaveTypes)
        .leftJoin(
          schema.allowances,
          and(
            eq(schema.allowances.leaveTypeId, schema.leaveTypes.id),
            eq(schema.allowances.userId, user.id),
            eq(schema.allowances.year, year),
          ),
        )
        .where(and(eq(schema.leaveTypes.companyId, user.companyId), isNull(schema.leaveTypes.archivedAt)))
        .orderBy(asc(schema.leaveTypes.sortOrder))
    : [];

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-6 py-8">
      <header className="mb-10 flex items-center justify-between">
        <Logo />
        <div className="flex items-center gap-4 text-sm">
          <span className="text-muted">{user.name || user.email}</span>
          <SignOutButton />
        </div>
      </header>

      <main className="space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight">Your {year} time off</h1>

        {rows.length === 0 ? (
          <p className="text-muted">No leave types yet. An admin needs to set them up.</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {rows.map((r) => (
              <li key={r.id} className="flex items-center gap-3 rounded-xl border border-border bg-surface p-4">
                <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: r.color }} aria-hidden />
                <span className="flex-1 font-medium">{r.name}</span>
                <span className="tabular-nums text-muted">
                  {r.days === null ? "—" : `${r.days} ${r.days === 1 ? "day" : "days"}`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
