import { PageHeader } from "@/components/ui/section";
import { buttonClass } from "@/components/ui/styles";
import { AppHeader, type HeaderNav, type HeaderSection } from "./app-header";

/**
 * The frame of every signed-in page: the app header, an optional section switcher (the
 * admin sub-navigation), then the page's `main` opening with its {@link PageHeader}. A
 * "Skip to content" link comes first, shown when focused, so keyboard users can pass the
 * header (WCAG 2.4.1).
 *
 * @param nav Who the header is for, from the page loader (`requireMemberPage`).
 * @param current Which header link is marked as the current page.
 * @param titleHidden Keep the `h1` for screen readers only.
 * @param className Spacing between the page's blocks.
 */
export function AppPage({
  nav,
  current,
  title,
  titleHidden = false,
  description,
  action,
  subnav,
  className = "space-y-6",
  children,
}: {
  nav: HeaderNav;
  current: HeaderSection;
  title: React.ReactNode;
  titleHidden?: boolean;
  description?: React.ReactNode;
  action?: React.ReactNode;
  subnav?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="app-page mx-auto w-full max-w-3xl flex-1 px-6 py-8">
      <a href="#main" className={`sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 ${buttonClass("primary")}`}>
        Skip to content
      </a>
      <AppHeader nav={nav} current={current} />
      {subnav && <div className="mb-8">{subnav}</div>}
      <main id="main" tabIndex={-1} className={`outline-none ${className}`}>
        <PageHeader title={title} description={description} action={action} hidden={titleHidden} />
        {children}
      </main>
    </div>
  );
}
