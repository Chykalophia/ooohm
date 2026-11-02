import type { Balance } from "@/domain/allowance-policy";
import { formatBalanceTotal, formatBalanceUsage, formatDays } from "@/lib/format";

/** What is left, in words, with an overdrawn balance said plainly rather than as a negative. */
export function remainingText(balance: Balance): string {
  if (!balance.tracked) return "No limit";
  if (balance.remaining < 0) return `${formatDays(-balance.remaining)} over`;
  return `${formatDays(balance.remaining)} left`;
}

/** One person's balances, as an admin reads them: compact, one line per leave type. */
export function BalanceList({
  year,
  items,
}: {
  year: number;
  items: readonly { leaveTypeId: string; name: string; color: string; archived: boolean; balance: Balance }[];
}) {
  if (items.length === 0) return <p className="text-muted">No active leave types.</p>;
  return (
    <ul className="divide-y divide-border rounded-2xl border border-border bg-surface">
      {items.map(({ leaveTypeId, name, color, archived, balance }) => {
        const usage = formatBalanceUsage(balance, year);
        const overdrawn = balance.tracked && balance.remaining < 0;
        return (
          <li key={leaveTypeId} className="flex flex-wrap items-baseline justify-between gap-2 p-4">
            <span className="flex items-center gap-2 font-medium">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden />
              {name}
              {archived && <span className="text-sm font-normal text-muted">(archived)</span>}
            </span>
            <span className="text-right text-sm">
              <span className={overdrawn ? "font-medium text-red-700 dark:text-red-400" : "font-medium"}>{remainingText(balance)}</span>
              <span className="block text-muted">
                {[balance.tracked ? formatBalanceTotal(balance) : null, usage].filter(Boolean).join(" · ")}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
