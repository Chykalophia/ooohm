import { LEAVE_TYPE_CODE_MAX_LENGTH, LEAVE_TYPE_NAME_MAX_LENGTH, MAX_ALLOWANCE_DAYS } from "@/domain/leave-type-settings";
import { CheckboxField, TextField } from "@/app/admin/fields";
import { ColorField } from "./color-field";

/** Every leave type setting, shared by the create and edit forms. */
export function LeaveTypeFields({
  leaveType,
}: {
  leaveType?: {
    name: string;
    code: string;
    color: string;
    isPaid: boolean;
    countsAgainstAllowance: boolean;
    defaultAllowanceDays: number | null;
    carryoverEnabled: boolean;
    carryoverMaxDays: number | null;
  };
}) {
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
        <TextField label="Name" name="name" required maxLength={LEAVE_TYPE_NAME_MAX_LENGTH} defaultValue={leaveType?.name ?? ""} />
        <TextField
          label="Code"
          name="code"
          required
          maxLength={LEAVE_TYPE_CODE_MAX_LENGTH}
          defaultValue={leaveType?.code ?? ""}
          hint="Short label on calendars, like PTO: letters, digits, - or _."
        />
      </div>
      <ColorField defaultColor={leaveType?.color ?? "#0f766e"} />
      <CheckboxField label="Paid" name="isPaid" defaultChecked={leaveType?.isPaid ?? true} />
      <CheckboxField
        label="Counts against an allowance"
        name="countsAgainstAllowance"
        defaultChecked={leaveType?.countsAgainstAllowance ?? true}
        hint="Off means people can take as much as they need, and it's only tracked."
      />
      <TextField
        label="Yearly allowance"
        name="defaultAllowanceDays"
        type="number"
        inputMode="decimal"
        optional
        min={0}
        max={MAX_ALLOWANCE_DAYS}
        step={0.1}
        defaultValue={leaveType?.defaultAllowanceDays ?? ""}
        hint="Days each person gets every year, unless you set theirs. Leave it blank to set people one by one."
      />
      <CheckboxField
        label="Carry unused days into next year"
        name="carryoverEnabled"
        defaultChecked={leaveType?.carryoverEnabled ?? false}
      />
      <TextField
        label="Most days carried over"
        name="carryoverMaxDays"
        type="number"
        inputMode="decimal"
        optional
        min={0}
        max={MAX_ALLOWANCE_DAYS}
        step={0.1}
        defaultValue={leaveType?.carryoverMaxDays ?? ""}
        hint="Blank means no cap. Only used when carrying over is on."
      />
      <p className="text-sm text-muted">Allowance changes apply to everyone&apos;s balance straight away.</p>
    </>
  );
}
