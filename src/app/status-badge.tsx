import { STATUS_LABEL } from "@/lib/format";

type Status = keyof typeof STATUS_LABEL;

const TONE: Record<Status, string> = {
  pending: "border-border text-foreground",
  approved: "border-accent/40 text-accent-ink",
  rejected: "border-red-200 text-red-700 dark:border-red-900 dark:text-red-400",
  cancelled: "border-border text-muted",
};

export function StatusBadge({ status }: { status: Status }) {
  return (
    <span className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-medium ${TONE[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}
