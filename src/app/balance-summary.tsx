import type { Balance } from "@/domain/allowance-policy";
import { formatBalanceTotal, formatBalanceUsage, formatDays } from "@/lib/format";

export type BalanceSummaryProps = {
  year: number;
  items: { leaveTypeId: string; name: string; color: string; archived: boolean; balance: Balance }[];
} | null;

function Remaining({ balance }: { balance: Extract<Balance, { tracked: true }> }) {
  if (balance.remaining < 0) {
    return <p className="text-lg font-semibold text-red-700 dark:text-red-400">{formatDays(-balance.remaining)} over</p>;
  }
  return (
    <p className="text-2xl font-semibold tabular-nums">
      {balance.remaining} <span className="text-sm font-normal text-muted">{balance.remaining === 1 ? "day" : "days"} left</span>
    </p>
  );
}

/**
 * The person's balance per active leave type (and any archived type they still have
 * days or an allowance for, marked as such) for the current year: what is left in
 * large type, and quietly underneath what it is out of (the allowance, plus any
 * carryover or adjustment) and the used and pending days. Untracked
 * (unlimited) types say so plainly.
 */
export function BalanceSummary({ summary }: { summary: BalanceSummaryProps }) {
  if (!summary) {
    return (
      <p className="text-muted">
        Balances aren&apos;t available right now. Ask an admin to check the company&apos;s allowance policy.
      </p>
    );
  }
  if (summary.items.length === 0) return null;

  return (
    <section aria-labelledby="balance-heading" className="space-y-4">
      <h2 id="balance-heading" className="text-lg font-semibold tracking-tight">
        Your balance for {summary.year}
      </h2>
      <ul className="grid gap-3 sm:grid-cols-2">
        {summary.items.map(({ leaveTypeId, name, color, archived, balance }) => {
          const used = formatBalanceUsage(balance, summary.year);
          return (
            <li key={leaveTypeId} className="space-y-1 rounded-2xl border border-border bg-surface p-4">
              <p className="flex items-center gap-2 text-sm font-medium">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden />
                {name}
                {archived && <span className="font-normal text-muted">(archived)</span>}
              </p>
              {balance.tracked ? (
                <>
                  <Remaining balance={balance} />
                  <p className="text-sm text-muted">
                    {formatBalanceTotal(balance)}
                    {used && ` · ${used}`}
                  </p>
                </>
              ) : (
                <p className="text-sm text-muted">
                  No limit{used ? ` · ${used}` : ""}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
