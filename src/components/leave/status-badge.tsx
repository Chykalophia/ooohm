import { STATUS_LABEL } from "@/lib/format";

type Status = keyof typeof STATUS_LABEL;

const TONE: Record<Status, string> = {
  pending: "border-border text-foreground",
  approved: "border-accent/40 text-accent",
  rejected: "border-danger-border text-danger",
  cancelled: "border-border text-muted",
};

export function StatusBadge({ status }: { status: Status }) {
  return (
    <span className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-medium ${TONE[status]}`}>{STATUS_LABEL[status]}</span>
  );
}
