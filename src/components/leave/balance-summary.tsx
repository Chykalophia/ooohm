import type { Balance } from "@/domain/allowance-policy";
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
      <p className="text-muted">Balances aren&apos;t available right now. Ask an admin to check the company&apos;s allowance policy.</p>
    );
  }
  if (summary.items.length === 0) return null;

  return (
    <Section title={`Your balance for ${summary.year}`}>
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
                </>
              ) : (
                <p className="text-sm text-muted">No limit{used ? ` · ${used}` : ""}</p>
              )}
            </Card>
          );
        })}
      </ul>
    </Section>
  );
}
