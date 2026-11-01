import { AppHeader, type HeaderSection } from "./app-header";

/** What a signed-in person without a company sees on any page. */
export function NoCompany({ userName, current }: { userName: string; current: HeaderSection }) {
  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-6 py-8">
      <AppHeader userName={userName} approvals={null} current={current} member={false} />
      <main>
        <p className="text-muted">Your account isn&apos;t part of a company yet. Ask an admin to finish setting it up.</p>
      </main>
    </div>
  );
}
