import type { Balance } from "@/domain/allowance-policy";
import { normalizeHexColor } from "@/lib/color";
import { formatBalanceTotal, formatBalanceUsage, formatDays } from "@/lib/format";
import { Card } from "@/components/ui/card";
import { Section } from "@/components/ui/section";
import { errorText } from "@/components/ui/styles";
import { type BalanceItem, LeaveTypeName } from "./balance-list";

export type BalanceSummaryProps = { year: number; items: readonly BalanceItem[] } | null;

function Remaining({ balance }: { balance: Extract<Balance, { tracked: true }> }) {
  if (balance.remaining < 0) {
    return <p className={`text-lg font-semibold ${errorText}`}>{formatDays(-balance.remaining)} over</p>;
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
function Squares({ balance, color: stored }: { balance: Extract<Balance, { tracked: true }>; color: string }) {
  const color = normalizeHexColor(stored);
  const count = Math.ceil(balance.total);
  if (count <= 0 || count > MAX_SQUARES) return null;
  const segment = (from: number, i: number) => Math.min(Math.max(from - i, 0), 1);
  return (
    <div aria-hidden data-swatch className="flex flex-wrap gap-1 pt-1">
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
export function BalanceSummary({ summary, title }: { summary: BalanceSummaryProps; title?: string }) {
  if (!summary) {
    return (
      <p className="text-muted">Balances aren&apos;t available right now. Ask an admin to check the company&apos;s allowance policy.</p>
    );
  }
  if (summary.items.length === 0) return null;
  // The balances drawn as squares, which the legend under the list explains.
  const squared = summary.items.flatMap(({ balance }) =>
    balance.tracked && balance.total > 0 && Math.ceil(balance.total) <= MAX_SQUARES ? [balance] : [],
  );

  return (
    <Section title={title ?? `Your balance for ${summary.year}`}>
      <ul className="grid gap-3 sm:grid-cols-2">
        {summary.items.map(({ leaveTypeId, name, color, archived, balance }) => {
          const used = formatBalanceUsage(balance, summary.year);
          return (
            <Card as="li" padding="sm" key={leaveTypeId} className="space-y-1">
              <LeaveTypeName name={name} color={color} archived={archived} as="p" className="text-sm font-medium" />
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
                <p className="text-sm text-muted">No limit{used ? ` · ${used}` : ""}</p>
              )}
            </Card>
          );
        })}
      </ul>
      {squared.length > 0 && (
        <p aria-hidden className="text-xs text-muted">
          One square is one day. Filled is taken, striped is waiting for approval,
          {squared.some((b) => b.carriedOut > 0) && " faint is carried into next year,"} empty is left.
        </p>
      )}
    </Section>
  );
}
