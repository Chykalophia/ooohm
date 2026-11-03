import { OooDots } from "@/components/ui/ooo-dots";

/** Shown while a page loads. Fades in late, so quick navigations never flash it. */
export default function Loading() {
  return (
    <main className="ooo-loading flex flex-1 items-center justify-center p-6">
      <div role="status">
        <OooDots className="text-3xl text-accent-ink" />
        <span className="sr-only">Loading</span>
      </div>
    </main>
  );
}
