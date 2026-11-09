import type { Role } from "@/domain/actor";
import { PERSON_NAME_MAX_LENGTH } from "@/domain/people";
import { ROLE_LABEL } from "@/lib/format";
import { CheckboxField, SelectField, TextField } from "@/components/ui/fields";

const ROLE_OPTIONS = Object.entries(ROLE_LABEL).map(([value, label]) => ({ value, label }));

/** The fields an admin sets about a person, shared by the invite and edit forms. */
export function PersonFields({
  departments,
  managers,
  person,
}: {
  departments: readonly { id: string; name: string }[];
  managers: readonly { id: string; label: string }[];
  person?: { name: string; role: Role; departmentId: string | null; managerId: string | null; canSelfApprove: boolean };
}) {
  const managerOptions = [{ value: "", label: "No manager (their department's manager or an admin approves)" }, ...managers.map((m) => ({ value: m.id, label: m.label }))];
  return (
    <>
      <TextField label="Name" name="name" required maxLength={PERSON_NAME_MAX_LENGTH} defaultValue={person?.name ?? ""} autoComplete="off" />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          label="Role"
          name="role"
          defaultValue={person?.role ?? "employee"}
          options={ROLE_OPTIONS}
          hint="Managers see an Approvals inbox. Admins also manage the company."
        />
        <SelectField
          label="Department"
          name="departmentId"
          optional
          defaultValue={person?.departmentId ?? ""}
          options={[{ value: "", label: "None" }, ...departments.map((d) => ({ value: d.id, label: d.name }))]}
        />
      </div>
      <SelectField
        label="Manager"
        name="managerId"
        optional
        defaultValue={person?.managerId ?? ""}
        options={managerOptions}
        hint="Approves their time off. People who report to this person aren't listed."
      />
      <CheckboxField
        label="Approves their own requests"
        name="canSelfApprove"
        defaultChecked={person?.canSelfApprove ?? false}
        hint="Their requests are approved as soon as they're sent, still within their balance."
      />
    </>
  );
}
