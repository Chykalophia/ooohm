import type { Balance } from "@/domain/allowance-policy";
import { formatBalanceTotal, formatBalanceUsage, formatRemaining } from "@/lib/format";
import { Item, ItemList } from "@/components/ui/card";
import { ColorLabel } from "@/components/ui/color-label";
import { cx, errorText } from "@/components/ui/styles";

export type BalanceItem = { leaveTypeId: string; name: string; color: string; archived: boolean; balance: Balance };

/** A leave type's name led by its colour, marked when the type is archived. */
export function LeaveTypeName({
  name,
  color,
  archived,
  as = "span",
  className = "font-medium",
}: {
  name: string;
  color: string;
  archived: boolean;
  as?: "p" | "span" | "h3";
  className?: string;
}) {
  return (
    <ColorLabel color={color} as={as} className={className}>
      {name}
      {archived && <span className="text-sm font-normal text-muted">(archived)</span>}
    </ColorLabel>
  );
}

/**
 * A balance as an admin reads it, right-aligned: what is left (red when overdrawn), and
 * underneath what it is out of and what is used or pending.
 */
export function BalanceFigures({ balance, year }: { balance: Balance; year: number }) {
  const overdrawn = balance.tracked && balance.remaining < 0;
  const details = [balance.tracked ? formatBalanceTotal(balance) : null, formatBalanceUsage(balance, year)].filter(Boolean).join(" · ");
  return (
    <span className="text-right text-sm">
      <span className={cx("font-medium", overdrawn && errorText)}>{formatRemaining(balance)}</span>
      <span className="block text-muted">{details}</span>
    </span>
  );
}

/** One person's balances, as an admin reads them: compact, one line per leave type. */
export function BalanceList({ year, items }: { year: number; items: readonly BalanceItem[] }) {
  if (items.length === 0) return <p className="text-muted">No active leave types.</p>;
  return (
    <ItemList>
      {items.map(({ leaveTypeId, name, color, archived, balance }) => (
        <Item key={leaveTypeId} className="flex flex-wrap items-baseline justify-between gap-2">
          <LeaveTypeName name={name} color={color} archived={archived} />
          <BalanceFigures balance={balance} year={year} />
        </Item>
      ))}
    </ItemList>
  );
}
