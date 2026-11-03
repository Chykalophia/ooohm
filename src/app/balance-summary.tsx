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

/** Above this many days, squares stop being readable at a glance and are left out. */
const MAX_SQUARES = 40;

/** Diagonal stripes in the leave type's colour: days waiting for approval. */
function stripes(color: string): string {
  return `repeating-linear-gradient(135deg, ${color} 0 2px, transparent 2px 5px)`;
}

/**
 * The year's allowance as one square per day: filled for days taken, striped for days
 * waiting for approval, faint for days carried into next year, and empty for what is
 * left. A half day fills half a square. For the eye only: the numbers beside it say
 * the same in words.
 */
function Squares({ balance, color }: { balance: Extract<Balance, { tracked: true }>; color: string }) {
  const count = Math.ceil(balance.total);
  if (count <= 0 || count > MAX_SQUARES) return null;
  const segment = (from: number, i: number) => Math.min(Math.max(from - i, 0), 1);
  return (
    <div aria-hidden className="flex flex-wrap gap-1 pt-1">
      {Array.from({ length: count }, (_, i) => {
        const used = segment(balance.used, i);
        const pending = segment(balance.used + balance.pending, i) - used;
        const carried = segment(balance.used + balance.pending + balance.carriedOut, i) - used - pending;
        return (
          <span key={i} className="flex h-4 w-4 overflow-hidden rounded-[4px] border border-border bg-surface">
            {used > 0 && <span style={{ width: `${used * 100}%`, backgroundColor: color }} />}
            {pending > 0 && <span style={{ width: `${pending * 100}%`, backgroundImage: stripes(color) }} />}
            {carried > 0 && <span className="bg-muted/30" style={{ width: `${carried * 100}%` }} />}
          </span>
        );
      })}
    </div>
  );
}

/**
 * The person's balance per active leave type (and any archived type they still have
 * days or an allowance for, marked as such) for the current year: what is left in
 * large type, and quietly underneath what it is out of (the allowance, plus any
 * carryover or adjustment) and the used and pending days. Untracked
 * (unlimited) types say so plainly. Under the numbers, {@link Squares} draw the same
 * year one square per day.
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
                  <Squares balance={balance} color={color} />
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
      {summary.items.some(({ balance }) => balance.tracked && balance.total > 0 && Math.ceil(balance.total) <= MAX_SQUARES) && (
        <p aria-hidden className="text-xs text-muted">
          One square is one day. Filled is taken, striped is waiting for approval, empty is left.
        </p>
      )}
    </section>
  );
}
