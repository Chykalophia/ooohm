/**
 * Who or what made a change. Every `audit_log` row and every event names one, so no
 * change is anonymous:
 *
 * - `user`: a person, directly (`via` absent) or through something they started, such
 *   as an adapter sync they ran (`via: "adapter_sync:gusto"`).
 * - `api_key`: a person's API key: the person who created the key, and the key.
 * - `system`: a process with no person behind it (the year rollover, a scheduled sync).
 *
 * `via` and `process` share one vocabulary of stable, machine-readable identifiers
 * ({@link ChangeProcess}). They are stored in `audit_log` and published in event
 * payloads, so an identifier is never renamed.
 */

/** Identifiers of the processes a change can be made by, or run through. */
export const CHANGE_PROCESSES = {
  /** The year rollover: carryover and missing allowance rows. */
  yearRollover: "year_rollover",
  /** Integration retention. It prunes delivery machinery and writes no audit rows today. */
  retention: "retention",
  /**
   * The TimeOff.Management import. A person starts it, so it is only ever a `via`:
   * the admin named by the CLI's `--actor`, through the import.
   */
  timeoffImport: "timeoff_import",
  /**
   * A full-scrub delete that waited out the company's grace period, run by the daily job.
   * An admin asked for it, so its source names them as `requestedBy`.
   */
  scheduledScrub: "scheduled_scrub",
  /**
   * Recounting submitted requests after an admin added or deleted a company holiday.
   * An admin starts it, so it is only ever a `via`.
   */
  holidayChange: "holiday_change",
  /**
   * Recounting submitted requests after an admin changed the company's working days.
   * An admin starts it, so it is only ever a `via`.
   */
  workingDaysChange: "working_days_change",
  /** The one-click Approve link in a request email. Only ever a `via`: the approver, through the link. */
  emailLink: "email_link",
  /**
   * The web setup of a brand-new install (`/setup`). Only ever a `via`: the first admin,
   * who created themself and the company's default leave types through it.
   */
  firstInstall: "first_install",
  /**
   * Adding people from a CSV file on Admin → People → Import. An admin uploads the file,
   * so it is only ever a `via`: that admin, through the import.
   */
  peopleImport: "people_import",
} as const;

const ADAPTER_SYNC_PREFIX = "adapter_sync:";

/** A named process, or an adapter's inbound sync (`adapter_sync:<adapterId>`). */
export type ChangeProcess = (typeof CHANGE_PROCESSES)[keyof typeof CHANGE_PROCESSES] | `adapter_sync:${string}`;

/** The process identifier of one adapter's inbound sync. */
export function adapterSyncProcess(adapterId: string): ChangeProcess {
  return `${ADAPTER_SYNC_PREFIX}${adapterId}`;
}

/** The adapter id in an `adapter_sync:<id>` identifier, or `null` for any other. */
export function adapterIdOf(process: string): string | null {
  return process.startsWith(ADAPTER_SYNC_PREFIX) && process.length > ADAPTER_SYNC_PREFIX.length ? process.slice(ADAPTER_SYNC_PREFIX.length) : null;
}

export const CHANGE_SOURCE_KINDS = ["user", "api_key", "system"] as const;
export type ChangeSourceKind = (typeof CHANGE_SOURCE_KINDS)[number];

export interface UserChangeSource {
  readonly kind: "user";
  readonly userId: string;
  readonly via?: ChangeProcess;
}

export interface ApiKeyChangeSource {
  readonly kind: "api_key";
  /** The person who created the key. */
  readonly userId: string;
  readonly apiKeyId: string;
  readonly via?: ChangeProcess;
}

export interface SystemChangeSource {
  readonly kind: "system";
  readonly process: ChangeProcess;
  /**
   * The person who asked for this run ahead of time (an admin who scheduled a scrub).
   * The process still made the change: they are not its actor.
   */
  readonly requestedBy?: string;
}

export type ChangeSource = UserChangeSource | ApiKeyChangeSource | SystemChangeSource;

/** A source with a person behind it: what an `Actor` acts as. */
export type PersonChangeSource = UserChangeSource | ApiKeyChangeSource;

export function byUser(userId: string, via?: ChangeProcess): UserChangeSource {
  return via === undefined ? { kind: "user", userId } : { kind: "user", userId, via };
}

export function byApiKey(key: { userId: string; apiKeyId: string }, via?: ChangeProcess): ApiKeyChangeSource {
  const base = { kind: "api_key" as const, userId: key.userId, apiKeyId: key.apiKeyId };
  return via === undefined ? base : { ...base, via };
}

export function bySystem(process: ChangeProcess, requestedBy?: string): SystemChangeSource {
  return requestedBy === undefined ? { kind: "system", process } : { kind: "system", process, requestedBy };
}

/** The same person (and key), now acting through `via`: e.g. an admin running a sync. */
export function through(source: PersonChangeSource, via: ChangeProcess): PersonChangeSource {
  return { ...source, via };
}

/** The person behind a change, or `null` for a system process. */
export function personIdOf(source: ChangeSource): string | null {
  return source.kind === "system" ? null : source.userId;
}

/** What `audit_log` rows written before sources were recorded hold as a system row's process when nothing identified it. */
export const UNKNOWN_PROCESS = "unknown";

/**
 * A source as `audit_log` holds it. Looser than {@link ChangeSource}: the person or key
 * is `null` once their row was deleted (the foreign keys set it to null), and stored
 * identifiers are plain strings, since a later version may write ones this one does not
 * know.
 */
export type RecordedChangeSource =
  | { readonly kind: "user"; readonly userId: string | null; readonly via?: string | null }
  | { readonly kind: "api_key"; readonly userId: string | null; readonly apiKeyId: string | null; readonly via?: string | null }
  | { readonly kind: "system"; readonly process: string; readonly requestedBy?: string | null };

/** Reads the source columns of one `audit_log` row. An unknown kind reads as a system row. */
export function recordedChangeSource(row: {
  actorKind: string;
  actorId: string | null;
  apiKeyId: string | null;
  actorVia: string | null;
  actorProcess: string | null;
  actorRequestedBy?: string | null;
}): RecordedChangeSource {
  if (row.actorKind === "user") return { kind: "user", userId: row.actorId, via: row.actorVia };
  if (row.actorKind === "api_key") return { kind: "api_key", userId: row.actorId, apiKeyId: row.apiKeyId, via: row.actorVia };
  const process = row.actorProcess ?? UNKNOWN_PROCESS;
  return row.actorRequestedBy ? { kind: "system", process, requestedBy: row.actorRequestedBy } : { kind: "system", process };
}

/** Lookups the label needs; each returns `undefined` for an id it does not know. */
export interface ChangeSourceNames {
  person(userId: string): string | undefined;
  apiKey(apiKeyId: string): { name: string; prefix: string } | undefined;
  /** An adapter's display name ("Gusto"); unregistered adapters fall back to their id. */
  adapter(adapterId: string): string | undefined;
}

function processLabel(process: string, names: ChangeSourceNames, scheduled: boolean): string {
  const adapterId = adapterIdOf(process);
  if (adapterId !== null) return `${scheduled ? "scheduled " : ""}${names.adapter(adapterId) ?? adapterId} sync`;
  switch (process) {
    case CHANGE_PROCESSES.yearRollover:
      return "year rollover";
    case CHANGE_PROCESSES.retention:
      return "retention";
    case CHANGE_PROCESSES.timeoffImport:
      return "time-off import";
    case CHANGE_PROCESSES.scheduledScrub:
      return "scheduled deletion";
    case CHANGE_PROCESSES.holidayChange:
      return "holiday change";
    case CHANGE_PROCESSES.workingDaysChange:
      return "working days change";
    case CHANGE_PROCESSES.emailLink:
      return "the email Approve link";
    case CHANGE_PROCESSES.firstInstall:
      return "first-time setup";
    case CHANGE_PROCESSES.peopleImport:
      return "CSV import";
    case UNKNOWN_PROCESS:
      return "unknown process";
    default:
      return process;
  }
}

function personLabelOf(userId: string | null, names: ChangeSourceNames): string {
  if (userId === null) return "A deleted person";
  return names.person(userId) || "Someone";
}

/**
 * How the audit log names who or what made a change:
 *
 * - "Peter Krzyzek"
 * - "Peter Krzyzek, via Gusto sync"
 * - "Peter Krzyzek, via API key ‘Zapier’ (ooohm_ab12cd34…)"
 * - "System: year rollover", "System: scheduled Gusto sync"
 * - "System: scheduled deletion, requested by Peter Krzyzek"
 */
export function changeSourceLabel(source: RecordedChangeSource, names: ChangeSourceNames): string {
  if (source.kind === "system") {
    const label = `System: ${processLabel(source.process, names, true)}`;
    return source.requestedBy ? `${label}, requested by ${personLabelOf(source.requestedBy, names)}` : label;
  }
  const person = personLabelOf(source.userId, names);
  const via = source.via ? processLabel(source.via, names, false) : null;
  if (source.kind === "user") return via ? `${person}, via ${via}` : person;
  const key = source.apiKeyId === null ? undefined : names.apiKey(source.apiKeyId);
  const keyLabel = key ? `API key ‘${key.name}’ (${key.prefix}…)` : "an API key";
  return via ? `${person}, via ${via} with ${keyLabel}` : `${person}, via ${keyLabel}`;
}
