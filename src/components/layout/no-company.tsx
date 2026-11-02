import type { HeaderNav, HeaderSection } from "./app-header";
import { AppPage } from "./app-page";

/** What a signed-in person without a company sees on any page. */
export function NoCompany({ nav, current }: { nav: HeaderNav; current: HeaderSection }) {
  return (
    <AppPage nav={nav} current={current} title="Not part of a company yet" titleHidden>
      <p className="text-muted">Your account isn&apos;t part of a company yet. Ask an admin to finish setting it up.</p>
    </AppPage>
  );
}
