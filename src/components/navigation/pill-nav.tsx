import Link from "next/link";
import { pillClass } from "@/components/ui/styles";

export type PillNavItem = {
  href: string;
  label: string;
  /**
   * How the pill is current, if it is: `"page"` when it links to this very page, `"true"`
   * when it stands for a group the page belongs to (Integrations, on the Webhooks page).
   */
  current?: "page" | "true";
};

/** A row of pills that switch between sibling views: admin sections, departments. */
export function PillNav({ label, items }: { label: string; items: readonly PillNavItem[] }) {
  return (
    <nav aria-label={label} className="flex flex-wrap gap-2 text-sm">
      {items.map((item) => (
        <Link key={item.href} href={item.href} aria-current={item.current} className={pillClass(item.current !== undefined)}>
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
