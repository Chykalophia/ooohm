import "server-only";
import Link from "next/link";
import { notFound } from "next/navigation";
import { canAdminister } from "@/domain/admin-permissions";
import { requireActor } from "@/lib/auth";
import { serviceContext } from "@/server/runtime";
import { getApprovalNav } from "@/server/services/approvals";
import { AppHeader } from "@/app/app-header";
import { focusRing } from "@/app/styles";

export type AdminSection =
  | "people"
  | "departments"
  | "leave-types"
  | "holidays"
  | "company"
  | "audit"
  | "webhooks"
  | "api-keys"
  | "integrations";

/** The integration screens, grouped under one "Integrations" link with their own row of tabs. */
const INTEGRATION_SECTIONS: { id: AdminSection; href: string; label: string }[] = [
  { id: "webhooks", href: "/admin/webhooks", label: "Webhooks" },
  { id: "api-keys", href: "/admin/api-keys", label: "API keys" },
  { id: "integrations", href: "/admin/integrations", label: "Connectors" },
];

const SECTIONS: { id: AdminSection; href: string; label: string; group?: readonly AdminSection[] }[] = [
  { id: "people", href: "/admin/people", label: "People" },
  { id: "departments", href: "/admin/departments", label: "Departments" },
  { id: "leave-types", href: "/admin/leave-types", label: "Leave types" },
  { id: "holidays", href: "/admin/holidays", label: "Holidays" },
  { id: "company", href: "/admin/company", label: "Company" },
  { id: "audit", href: "/admin/audit", label: "Audit log" },
  { id: "webhooks", href: "/admin/webhooks", label: "Integrations", group: INTEGRATION_SECTIONS.map((s) => s.id) },
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

/**
 * The admin sub-navigation: one calm row of seven links, wrapping on small screens. On
 * an integration screen a second, quieter row switches between webhooks, API keys and
 * connectors.
 */
function AdminNav({ section }: { section: AdminSection }) {
  const inIntegrations = INTEGRATION_SECTIONS.some((s) => s.id === section);
  return (
    <div className="space-y-3">
      <nav aria-label="Admin" className="flex flex-wrap gap-2 text-sm">
        {SECTIONS.map((s) => {
          const active = s.group ? s.group.includes(section) : s.id === section;
          return (
            <Link
              key={s.label}
              href={s.href}
              aria-current={active ? (s.group ? "true" : "page") : undefined}
              className={`rounded-full border px-3 py-1 ${focusRing} ${
                active ? "border-accent text-accent" : "border-border text-muted hover:text-foreground"
              }`}
            >
              {s.label}
            </Link>
          );
        })}
      </nav>
      {inIntegrations && (
        <nav aria-label="Integrations" className="flex flex-wrap gap-4 text-sm">
          {INTEGRATION_SECTIONS.map((s) => {
            const active = s.id === section;
            return (
              <Link
                key={s.id}
                href={s.href}
                aria-current={active ? "page" : undefined}
                className={`rounded ${focusRing} ${active ? "text-accent underline underline-offset-4" : "text-muted hover:text-foreground"}`}
              >
                {s.label}
              </Link>
            );
          })}
        </nav>
      )}
    </div>
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
