/**
 * How the audit log reads to an admin: a label per action, and a field-by-field
 * summary of what a change did, computed from the row's `before` and `after` JSON.
 * Pure, so the viewer's wording is unit tested without a database.
 */
import {
  ADMIN_EVENT_TYPES,
  ALLOWANCE_AUDIT_ACTIONS,
  CALENDAR_FEED_EVENT_TYPES,
  IMPORT_AUDIT_ACTIONS,
  INTEGRATION_EVENT_TYPES,
  RECORDS_EXPORTED_AUDIT_ACTION,
} from "./events";

/** Every `audit_log.action` the app writes, with how the viewer names it. */
export const AUDIT_ACTION_LABELS: Readonly<Record<string, string>> = {
  "leave_request.requested": "Leave requested",
  "leave_request.approved": "Leave approved",
  "leave_request.rejected": "Leave declined",
  "leave_request.cancelled": "Leave cancelled",
  "leave_request.reassigned": "Leave reassigned",
  "leave_request.recounted": "Leave recounted",
  [ALLOWANCE_AUDIT_ACTIONS.allowance_created]: "Allowance created",
  [ALLOWANCE_AUDIT_ACTIONS.carryover]: "Days carried over",
  [ALLOWANCE_AUDIT_ACTIONS.admin_edit]: "Allowance edited",
  [CALENDAR_FEED_EVENT_TYPES.issued]: "Calendar link created",
  [CALENDAR_FEED_EVENT_TYPES.revoked]: "Calendar link turned off",
  [ADMIN_EVENT_TYPES.userCreated]: "Person invited",
  [ADMIN_EVENT_TYPES.userUpdated]: "Person edited",
  [ADMIN_EVENT_TYPES.userDeactivated]: "Person deactivated",
  [ADMIN_EVENT_TYPES.userReactivated]: "Person reactivated",
  [ADMIN_EVENT_TYPES.userInviteResent]: "Invite sent again",
  [ADMIN_EVENT_TYPES.userDeletionScheduled]: "Deletion scheduled",
  [ADMIN_EVENT_TYPES.userDeletionCancelled]: "Scheduled deletion undone",
  [ADMIN_EVENT_TYPES.userDeleted]: "Person deleted",
  [RECORDS_EXPORTED_AUDIT_ACTION]: "Records exported",
  [ADMIN_EVENT_TYPES.departmentCreated]: "Department created",
  [ADMIN_EVENT_TYPES.departmentRenamed]: "Department renamed",
  [ADMIN_EVENT_TYPES.departmentDeleted]: "Department deleted",
  [ADMIN_EVENT_TYPES.leaveTypeCreated]: "Leave type created",
  [ADMIN_EVENT_TYPES.leaveTypeUpdated]: "Leave type edited",
  [ADMIN_EVENT_TYPES.leaveTypeArchived]: "Leave type archived",
  [ADMIN_EVENT_TYPES.leaveTypeUnarchived]: "Leave type restored",
  [ADMIN_EVENT_TYPES.leaveTypeReordered]: "Leave types reordered",
  [ADMIN_EVENT_TYPES.holidayCreated]: "Holiday added",
  [ADMIN_EVENT_TYPES.holidayRenamed]: "Holiday renamed",
  [ADMIN_EVENT_TYPES.holidayDeleted]: "Holiday deleted",
  [ADMIN_EVENT_TYPES.companyUpdated]: "Company settings changed",
  [ALLOWANCE_AUDIT_ACTIONS.sync]: "Allowance synced",
  [INTEGRATION_EVENT_TYPES.webhookEndpointCreated]: "Webhook endpoint added",
  [INTEGRATION_EVENT_TYPES.webhookEndpointUpdated]: "Webhook endpoint edited",
  [INTEGRATION_EVENT_TYPES.webhookEndpointEnabled]: "Webhook endpoint turned on",
  [INTEGRATION_EVENT_TYPES.webhookEndpointDisabled]: "Webhook endpoint turned off",
  [INTEGRATION_EVENT_TYPES.webhookEndpointSecretRotated]: "Webhook secret replaced",
  [INTEGRATION_EVENT_TYPES.webhookEndpointDeleted]: "Webhook endpoint deleted",
  [INTEGRATION_EVENT_TYPES.webhookEndpointPinged]: "Webhook test event sent",
  [INTEGRATION_EVENT_TYPES.webhookDeliveryRedelivered]: "Webhook sent again",
  [INTEGRATION_EVENT_TYPES.apiKeyCreated]: "API key created",
  [INTEGRATION_EVENT_TYPES.apiKeyRevoked]: "API key revoked",
  [IMPORT_AUDIT_ACTIONS.company]: "Imported: company settings",
  [IMPORT_AUDIT_ACTIONS.department]: "Imported: department",
  [IMPORT_AUDIT_ACTIONS.leaveType]: "Imported: leave type",
  [IMPORT_AUDIT_ACTIONS.holiday]: "Imported: holiday",
  [IMPORT_AUDIT_ACTIONS.user]: "Imported: person",
  [IMPORT_AUDIT_ACTIONS.allowance]: "Imported: allowance",
  [IMPORT_AUDIT_ACTIONS.leaveRequest]: "Imported: leave",
  [IMPORT_AUDIT_ACTIONS.completed]: "Import finished",
};

export function isAuditAction(value: string): boolean {
  return Object.hasOwn(AUDIT_ACTION_LABELS, value);
}

/** The viewer's name for an action; an unknown one (from a later version) reads as itself. */
export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action;
}

/** One field a change touched. `before` is absent for a creation, `after` for a deletion. */
export interface AuditFieldChange {
  field: string;
  before?: unknown;
  after?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The fields a change touched, in the order the snapshot lists them.
 *
 * - Both snapshots present: only fields whose value differs. A field only one side has
 *   (a fact the change added, such as `sessionsRevoked` or `urlChanged`) has only that side.
 * - Only `after` (a creation): every field that has a value.
 * - Only `before` (a deletion): every field that had a value.
 */
export function diffAuditSnapshots(before: unknown, after: unknown): AuditFieldChange[] {
  const b = asRecord(before);
  const a = asRecord(after);
  if (a && b) {
    const fields = [...new Set([...Object.keys(b), ...Object.keys(a)])];
    return fields
      .filter((f) => !same(b[f], a[f]))
      .map((field) => ({ field, ...(Object.hasOwn(b, field) && { before: b[field] }), ...(Object.hasOwn(a, field) && { after: a[field] }) }));
  }
  if (a) return Object.keys(a).filter((f) => a[f] !== null && a[f] !== undefined).map((field) => ({ field, after: a[field] }));
  if (b) return Object.keys(b).filter((f) => b[f] !== null && b[f] !== undefined).map((field) => ({ field, before: b[field] }));
  return [];
}

const FIELD_LABELS: Readonly<Record<string, string>> = {
  name: "Name",
  email: "Email",
  role: "Role",
  departmentId: "Department",
  managerId: "Manager",
  canSelfApprove: "Approves own requests",
  isActive: "Active",
  status: "Status",
  leaveTypeId: "Leave type",
  startDate: "From",
  endDate: "To",
  dayPortion: "Part of day",
  days: "Days",
  note: "Note",
  approverId: "Approver",
  decidedAt: "Decided",
  decisionNote: "Decision note",
  userId: "Person",
  year: "Year",
  carriedOverDays: "Carried over",
  adjustmentDays: "Adjustment",
  reason: "Reason",
  kind: "Calendar",
  createdAt: "Created",
  revokedAt: "Turned off",
  code: "Code",
  color: "Colour",
  isPaid: "Paid",
  countsAgainstAllowance: "Counts against allowance",
  defaultAllowanceDays: "Default allowance",
  carryoverEnabled: "Carryover",
  carryoverMaxDays: "Carryover cap",
  sortOrder: "Position",
  archived: "Archived",
  date: "Date",
  timezone: "Time zone",
  workingDays: "Working days",
  allowancePolicy: "Allowance policy",
  sessionsRevoked: "Sessions ended",
  feedsRevoked: "Calendar links turned off",
  requestsReassigned: "Requests reassigned",
  urlOrigin: "Address",
  urlChanged: "Full address changed",
  eventTypes: "Events",
  enabled: "On",
  prefix: "Key",
  scopes: "Access",
  revoked: "Revoked",
  attempts: "Attempts",
  source: "Source",
  fileName: "File",
  timeoffApproverId: "Approver in TimeOff",
  sourceSha256: "File checksum (SHA-256)",
  people: "People",
  departments: "Departments",
  leaveTypes: "Leave types",
  holidays: "Holidays",
  allowances: "Allowances",
  leaveRequests: "Leave requests",
  mismatches: "Balance differences",
  warnings: "Warnings",
  conflicts: "Conflicts",
  mode: "How",
  counts: "Removed or changed",
  scheduledFor: "Runs on",
  leaveRequestsDeleted: "Leave requests deleted",
  allowancesDeleted: "Allowance rows deleted",
  auditEntriesDeleted: "Audit entries deleted",
  sessionsDeleted: "Sessions ended",
  accountsDeleted: "Sign-in links (Google) removed",
  verificationsDeleted: "Unused sign-in links removed",
  calendarFeedsDeleted: "Calendar links removed",
  eventsRedacted: "Events redacted",
  deliveriesRedacted: "Webhook deliveries redacted",
  deliveriesFailed: "Pending webhook deliveries stopped",
  importRunsRedacted: "Import reports redacted",
  auditEntriesRedacted: "Other audit entries redacted",
  notesRedacted: "Notes redacted",
  rows: "Rows",
};

const DELETION_MODE_LABELS: Readonly<Record<string, string>> = {
  scrubbed: "full scrub (nothing kept)",
  records_kept: "account removed, records kept",
};

/** "carriedOverDays" → "Carried over days" for a field the viewer has no label for. */
export function auditFieldLabel(field: string): string {
  if (FIELD_LABELS[field]) return FIELD_LABELS[field];
  const words = field.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Resolves ids in a snapshot to names. Each returns `undefined` for an id it does not know. */
export interface AuditNames {
  person(id: string): string | undefined;
  department(id: string): string | undefined;
  leaveType(id: string): string | undefined;
  /** An ISO instant ("2026-11-03T01:43:53.883Z") as the reader's time; printed as stored without it. */
  instant?(iso: string): string;
}

/** An instant as snapshots store it: `Date#toISOString()`. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/**
 * Whether a snapshot field holds an instant (`revokedAt`, `scheduledFor`). Only those are
 * printed as times: free text (a note, a name) prints as typed, even when someone types
 * something shaped like a time.
 */
function isInstantField(field: string): boolean {
  return /[a-z]At$/.test(field) || field === "scheduledFor";
}

/** A stored instant that is a real moment (`2026-13-45T…` matches the shape but is not). */
function isInstant(value: string): boolean {
  return ISO_INSTANT.test(value) && !Number.isNaN(Date.parse(value));
}

const PERSON_FIELDS = new Set(["managerId", "approverId", "userId", "actorId", "previousApproverId", "timeoffApproverId"]);
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** One value from a snapshot, as the viewer prints it. */
export function formatAuditValue(field: string, value: unknown, names: AuditNames): string {
  if (value === null || value === undefined || value === "") return "none";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (field === "counts" && asRecord(value)) {
    const parts = Object.entries(asRecord(value)!)
      .filter(([, n]) => typeof n === "number" && n !== 0)
      .map(([key, n]) => `${auditFieldLabel(key)}: ${n}`);
    return parts.length > 0 ? parts.join(", ") : "nothing";
  }
  if (typeof value === "string") {
    if (field === "mode") return DELETION_MODE_LABELS[value] ?? value;
    if (PERSON_FIELDS.has(field)) return names.person(value) ?? "someone else";
    if (field === "departmentId") return names.department(value) ?? "a deleted department";
    if (field === "leaveTypeId") return names.leaveType(value) ?? "another leave type";
    if (names.instant && isInstantField(field) && isInstant(value)) return names.instant(value);
    return value;
  }
  if (field === "workingDays" && Array.isArray(value)) {
    return value.map((d) => (typeof d === "number" && d >= 1 && d <= 7 ? WEEKDAYS[d - 1] : String(d))).join(", ");
  }
  if (Array.isArray(value)) return value.map(String).join(", ");
  if (typeof value === "number") return String(value);
  return JSON.stringify(value);
}

/**
 * A change in words, one entry per field: "Role: employee → admin", "Name: Ana" for a
 * creation, "Name: was Ana" for a deletion.
 */
export function describeAuditChange(before: unknown, after: unknown, names: AuditNames): string[] {
  return diffAuditSnapshots(before, after).map(({ field, ...change }) => {
    const label = auditFieldLabel(field);
    if (!("before" in change)) return `${label}: ${formatAuditValue(field, change.after, names)}`;
    if (!("after" in change)) return `${label}: was ${formatAuditValue(field, change.before, names)}`;
    return `${label}: ${formatAuditValue(field, change.before, names)} → ${formatAuditValue(field, change.after, names)}`;
  });
}
