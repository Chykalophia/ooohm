/**
 * True for a request that won't happen (cancelled, or declined). Its card is drawn in
 * grey, so it can't be mistaken for booked time off.
 */
export function isSettledAway(status: "pending" | "approved" | "rejected" | "cancelled"): boolean {
  return status === "cancelled" || status === "rejected";
}
