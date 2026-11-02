import "server-only";
import Link from "next/link";
import { notFound } from "next/navigation";
import { canAdminister } from "@/domain/admin-permissions";
import { requireActor } from "@/lib/auth";
import { serviceContext } from "@/server/runtime";
import { getApprovalNav } from "@/server/services/approvals";
import { AppHeader } from "@/app/app-header";
import { focusRing } from "./styles";

export type AdminSection = "people" | "departments" | "leave-types" | "holidays" | "company" | "audit";

const SECTIONS: { id: AdminSection; href: string; label: string }[] = [
  { id: "people", href: "/admin/people", label: "People" },
  { id: "departments", href: "/admin/departments", label: "Departments" },
  { id: "leave-types", href: "/admin/leave-types", label: "Leave types" },
  { id: "holidays", href: "/admin/holidays", label: "Holidays" },
  { id: "company", href: "/admin/company", label: "Company" },
  { id: "audit", href: "/admin/audit", label: "Audit log" },
];

/**
 * The entry point of every admin page: the signed-in admin, or a 404 for anyone else
 * (the admin area does not announce itself). Services check the role again; this only
 * keeps non-admins from seeing the screens.
 */
export async function requireAdminPage() {
  const { user, actor } = await requireActor();
  if (!actor || !canAdminister(actor)) notFound();
  const ctx = serviceContext();
  const approvals = await getApprovalNav(ctx, actor);
  return { actor, ctx, userName: user.name || user.email, approvals };
}

/** The admin sub-navigation: one calm row of links, wrapping on small screens. */
function AdminNav({ section }: { section: AdminSection }) {
  return (
    <nav aria-label="Admin" className="flex flex-wrap gap-2 text-sm">
      {SECTIONS.map((s) => {
        const active = s.id === section;
        return (
          <Link
            key={s.id}
            href={s.href}
            aria-current={active ? "page" : undefined}
            className={`rounded-full border px-3 py-1 ${focusRing} ${
              active ? "border-accent text-accent" : "border-border text-muted hover:text-foreground"
            }`}
          >
            {s.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Page frame for the admin area: the app header, the admin sub-nav, then the page. */
export function AdminShell({
  userName,
  approvals,
  section,
  title,
  description,
  action,
  children,
}: {
  userName: string;
  approvals: { visible: boolean; pending: number };
  section: AdminSection;
  title: string;
  description?: React.ReactNode;
  /** The screen's one main action, beside the title (e.g. an "Invite someone" link). */
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-6 py-8">
      <AppHeader userName={userName} approvals={approvals} current="admin" admin />
      <div className="mb-8">
        <AdminNav section={section} />
      </div>
      <main className="space-y-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            {description && <p className="max-w-prose text-muted">{description}</p>}
          </div>
          {action}
        </div>
        {children}
      </main>
    </div>
  );
}
