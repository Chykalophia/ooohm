import Link from "next/link";
import type { HeaderNav } from "@/components/layout/app-header";
import { AppPage } from "@/components/layout/app-page";
import { PillNav } from "@/components/navigation/pill-nav";
import { cx, focusRing } from "@/components/ui/styles";

export type AdminSection =
  | "people"
  | "departments"
  | "leave-types"
  | "holidays"
  | "company"
  | "appearance"
  | "emails"
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
  { id: "appearance", href: "/admin/appearance", label: "Appearance" },
  { id: "emails", href: "/admin/emails", label: "Emails" },
  { id: "audit", href: "/admin/audit", label: "Audit log" },
  { id: "webhooks", href: "/admin/webhooks", label: "Integrations", group: INTEGRATION_SECTIONS.map((s) => s.id) },
];

/**
 * The admin sub-navigation: one calm row of nine pills, wrapping on small screens. On
 * an integration screen a second, quieter row switches between webhooks, API keys and
 * connectors.
 */
function AdminNav({ section }: { section: AdminSection }) {
  const inIntegrations = INTEGRATION_SECTIONS.some((s) => s.id === section);
  return (
    <div className="space-y-3">
      <PillNav
        label="Admin"
        items={SECTIONS.map((s) => ({
          href: s.href,
          label: s.label,
          current: s.group ? (s.group.includes(section) ? "true" : undefined) : s.id === section ? "page" : undefined,
        }))}
      />
      {inIntegrations && (
        <nav aria-label="Integrations" className="flex flex-wrap gap-4 text-sm">
          {INTEGRATION_SECTIONS.map((s) => {
            const active = s.id === section;
            return (
              <Link
                key={s.id}
                href={s.href}
                aria-current={active ? "page" : undefined}
                className={cx("rounded", focusRing, active ? "text-accent-ink underline underline-offset-4" : "text-muted hover:text-foreground")}
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

/**
 * Page frame for the admin area: {@link AppPage} with the admin sub-navigation. Pages
 * open with `requireAdminPage()` (src/app/_lib/page-context.ts) and pass its `nav`.
 */
export function AdminShell({
  nav,
  section,
  title,
  description,
  action,
  children,
}: {
  nav: HeaderNav;
  section: AdminSection;
  title: string;
  description?: React.ReactNode;
  /** The screen's one main action, beside the title (e.g. an "Invite someone" link). */
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <AppPage
      nav={nav}
      current="admin"
      title={title}
      description={description}
      action={action}
      subnav={<AdminNav section={section} />}
      className="space-y-8"
    >
      {children}
    </AppPage>
  );
}
