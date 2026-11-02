import Link from "next/link";
import { useId } from "react";
import { card, cx, subtleButton } from "./styles";

const HEADING = {
  md: "text-lg font-semibold tracking-tight",
  sm: "text-sm font-medium text-foreground",
} as const;

/**
 * The top of a page: its one `h1`, a sentence on what the page is for, and the screen's
 * main action beside them. `hidden` keeps the heading for screen readers only, on a page
 * whose content already says what it is (the dashboard).
 */
export function PageHeader({
  title,
  description,
  action,
  hidden = false,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  hidden?: boolean;
}) {
  if (hidden) return <h1 className="sr-only">{title}</h1>;
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="max-w-prose text-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}

/**
 * A titled part of a page, labelled by its `h2` for assistive technology.
 *
 * @param surface Draw it as a card.
 * @param action Shown beside the heading, e.g. a link to edit what the section lists.
 * @param headingId A fixed id for the heading, for code that moves focus to it (it then
 *   also becomes focusable); otherwise one is generated.
 */
export function Section({
  id,
  title,
  size = "md",
  surface = false,
  action,
  headingId,
  className = "space-y-4",
  children,
}: {
  /** The section's own id, for links that jump to it. */
  id?: string;
  title: React.ReactNode;
  size?: keyof typeof HEADING;
  surface?: boolean;
  action?: React.ReactNode;
  headingId?: string;
  className?: string;
  children: React.ReactNode;
}) {
  const generated = useId();
  const labelId = headingId ?? generated;
  const heading = (
    <h2 id={labelId} tabIndex={headingId ? -1 : undefined} className={cx(HEADING[size], headingId && "outline-none")}>
      {title}
    </h2>
  );
  return (
    <section id={id} aria-labelledby={labelId} className={cx(surface && card, className)}>
      {action ? (
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          {heading}
          {action}
        </div>
      ) : (
        heading
      )}
      {children}
    </section>
  );
}

/** The quiet way back to the list a detail page came from. */
export function BackLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <p>
      <Link href={href} className={subtleButton}>
        {children}
      </Link>
    </p>
  );
}
