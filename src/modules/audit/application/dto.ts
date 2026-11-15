import "server-only";
import { auditActionLabel, describeAuditChange } from "@/domain/audit";
import { type ChangeSourceKind, changeSourceLabel, recordedChangeSource } from "@/domain/change-source";
import type { PageCursor } from "@/domain/paging";
import { personLabel } from "@/domain/person";
import type { AuditPageSize } from "./schemas";

/** One row as the viewer shows it. */
export interface AuditLogEntryDTO {
  id: string;
  at: Date;
  action: string;
  label: string;
  /** Who or what did it: "Ana", "Ana, via Gusto sync", "System: year rollover" (`changeSourceLabel`). */
  actorLabel: string;
  /** Whether a person (directly, through something, or with an API key) or a system process did it. */
  actorKind: ChangeSourceKind;
  /** The person who did it (directly, through something, or with their API key), for filtering by them. */
  actorId: string | null;
  /** Who it is about, if anyone. */
  subjectName: string | null;
  subjectUserId: string | null;
  /** What changed, one line per field. */
  changes: string[];
}

/** One page of the audit log, with what its filters and pickers need. */
export interface AuditLogDTO {
  timezone: string;
  entries: AuditLogEntryDTO[];
  previous: PageCursor | null;
  next: PageCursor | null;
  oldestFirst: boolean;
  size: AuditPageSize;
  /** The filters in force, after anything malformed was dropped. */
  filters: {
    query: string | undefined;
    action: string | undefined;
    actorId: string | undefined;
    subjectUserId: string | undefined;
    from: string | undefined;
    to: string | undefined;
  };
  /** The "Done by" and "About" pickers: the company's people, never deleted ones. */
  people: { id: string; label: string }[];
  /** The "What" picker: every action the log names. */
  actions: { value: string; label: string }[];
}

/** An audit row as the repository reads it: the row, with the names its joins bring. */
export interface AuditRowView {
  id: string;
  action: string;
  before: unknown;
  after: unknown;
  createdAt: Date;
  actorKind: string;
  actorId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  apiKeyId: string | null;
  apiKeyName: string | null;
  apiKeyPrefix: string | null;
  actorVia: string | null;
  actorProcess: string | null;
  actorRequestedBy: string | null;
  requesterName: string | null;
  requesterEmail: string | null;
  subjectUserId: string | null;
  subjectName: string | null;
  subjectEmail: string | null;
}

/** How ids inside a row are named: the snapshot names, and an adapter's display name. */
export interface AuditRowNames {
  snapshot: Parameters<typeof describeAuditChange>[2];
  adapter: (id: string) => string | undefined;
}

export function toAuditLogEntryDTO(r: AuditRowView, names: AuditRowNames): AuditLogEntryDTO {
  return {
    id: r.id,
    at: r.createdAt,
    action: r.action,
    label: auditActionLabel(r.action),
    actorLabel: changeSourceLabel(recordedChangeSource(r), {
      person: (id) => {
        if (id === r.actorId && r.actorName !== null) return personLabel({ name: r.actorName, email: r.actorEmail ?? "" });
        if (id === r.actorRequestedBy && r.requesterName !== null) return personLabel({ name: r.requesterName, email: r.requesterEmail ?? "" });
        return undefined;
      },
      apiKey: () => (r.apiKeyName === null ? undefined : { name: r.apiKeyName, prefix: r.apiKeyPrefix ?? "" }),
      adapter: names.adapter,
    }),
    actorKind: r.actorKind === "user" || r.actorKind === "api_key" ? r.actorKind : "system",
    actorId: r.actorId,
    subjectUserId: r.subjectUserId,
    subjectName: r.subjectUserId ? personLabel({ name: r.subjectName ?? "", email: r.subjectEmail ?? "" }) || null : null,
    changes: describeAuditChange(r.before, r.after, names.snapshot),
  };
}
