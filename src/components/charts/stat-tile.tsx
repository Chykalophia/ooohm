import { cx, surface } from "@/components/ui/styles";

/** One headline number with what it counts, and an optional line of context under it. */
export function StatTile({ label, value, detail }: { label: string; value: React.ReactNode; detail?: React.ReactNode }) {
  return (
    <div className={cx(surface, "space-y-1 p-4")}>
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="text-2xl font-semibold tracking-tight tabular-nums">{value}</dd>
      {detail && <dd className="text-xs text-muted">{detail}</dd>}
    </div>
  );
}
