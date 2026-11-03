import { PageHeader } from "@/components/ui/section";
import { AppHeader, type HeaderNav, type HeaderSection } from "./app-header";

/**
 * The frame of every signed-in page: the app header, an optional section switcher (the
 * admin sub-navigation), then the page's `main` opening with its {@link PageHeader}.
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
      <AppHeader nav={nav} current={current} />
      {subnav && <div className="mb-8">{subnav}</div>}
      <main className={className}>
        <PageHeader title={title} description={description} action={action} hidden={titleHidden} />
        {children}
      </main>
    </div>
  );
}
