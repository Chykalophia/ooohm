import { errorText } from "@/components/ui/styles";

/** How a delivery's status reads, and its colour. Never colour alone: the word is always there. */
const LABELS = {
  pending: { label: "Queued", className: "text-muted" },
  delivered: { label: "Delivered", className: "text-accent-ink" },
  failed: { label: "Failed", className: errorText },
  cancelled: { label: "Cancelled", className: "text-muted" },
} as const;

export type DeliveryStatus = keyof typeof LABELS;

export function DeliveryStatusText({ status, retrying = false }: { status: DeliveryStatus; retrying?: boolean }) {
  const { label, className } = LABELS[status];
  return <span className={`font-medium ${className}`}>{status === "pending" && retrying ? "Retrying" : label}</span>;
}
