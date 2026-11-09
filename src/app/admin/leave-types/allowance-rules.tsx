import Link from "next/link";
import { MAX_ALLOWANCE_DAYS } from "@/domain/leave-type-settings";
import { formatDays } from "@/lib/format";
import { Section } from "@/components/ui/section";
import { Item, ItemList } from "@/components/ui/card";
import { SelectField, TextField } from "@/components/ui/fields";
import { ActionForm } from "@/components/forms/action-form";
import { InlineAction } from "@/components/forms/inline-action";
import { Reveal } from "@/components/forms/reveal";
import { outlineButton, textLink } from "@/components/ui/styles";
import { removeAllowanceRuleAction, setAllowanceRuleAction } from "@/app/admin/leave-types/rule-actions";

interface Rule {
  id: string;
  days: number;
  departmentName: string | null;
  levelName: string | null;
}

/** "Dev", "Intern", "Intern in Dev". */
function targetOf(rule: Rule): string {
  if (rule.departmentName && rule.levelName) return `${rule.levelName} in ${rule.departmentName}`;
  return rule.levelName ?? rule.departmentName ?? "Everyone";
}

/**
 * A leave type's allowances by department and level: the rules, each removable, and a
 * form (behind a reveal, so the page keeps one main action) that adds one or changes
 * the days of an existing one.
 */
export function AllowanceRules({
  leaveTypeId,
  rules,
  departments,
  levels,
}: {
  leaveTypeId: string;
  rules: readonly Rule[];
  departments: readonly { id: string; name: string }[];
  levels: readonly { id: string; name: string }[];
}) {
  const none = { value: "", label: "Any" };
  return (
    <Section title="Allowance by department or level" surface>
      <p className="text-sm text-muted">
        Give some people a different yearly allowance than the default. The most specific rule wins: a level in a department, then a
        level, then a department. People whose allowance you set by hand keep it.
      </p>
      {rules.length > 0 && (
        <ItemList>
          {rules.map((r) => (
            <Item key={r.id} className="flex flex-wrap items-baseline justify-between gap-3">
              <p>
                <span className="font-medium">{targetOf(r)}</span> <span className="text-muted">· {formatDays(r.days)} a year</span>
              </p>
              <InlineAction
                action={removeAllowanceRuleAction}
                fields={{ id: r.id }}
                label="Remove"
                ariaLabel={`Remove the rule for ${targetOf(r)}`}
                pendingLabel="Removing…"
                variant="danger"
                confirm={`Remove the rule for ${targetOf(r)}? They go back to the default.`}
                confirmLabel="Yes, remove"
              />
            </Item>
          ))}
        </ItemList>
      )}
      {departments.length === 0 && levels.length === 0 ? (
        <p className="text-sm text-muted">
          Add <Link href="/admin/departments" className={textLink}>departments</Link> or <Link href="/admin/levels" className={textLink}>levels</Link> first.
        </p>
      ) : (
        <Reveal label={rules.length > 0 ? "Add or change a rule" : "Add a rule"}>
          <ActionForm action={setAllowanceRuleAction} submitLabel="Save rule" pendingLabel="Saving…" buttonClassName={outlineButton} className="space-y-4">
            <input type="hidden" name="leaveTypeId" value={leaveTypeId} />
            <div className="grid gap-4 sm:grid-cols-3">
              {departments.length > 0 && (
                <SelectField label="Department" name="departmentId" options={[none, ...departments.map((d) => ({ value: d.id, label: d.name }))]} />
              )}
              {levels.length > 0 && <SelectField label="Level" name="levelId" options={[none, ...levels.map((l) => ({ value: l.id, label: l.name }))]} />}
              <TextField label="Days a year" name="days" type="number" inputMode="decimal" required min={0} max={MAX_ALLOWANCE_DAYS} step={0.1} />
            </div>
          </ActionForm>
        </Reveal>
      )}
    </Section>
  );
}
