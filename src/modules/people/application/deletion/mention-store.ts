import "server-only";
/**
 * The stored text a delete redacts, as the redaction step sees it: each kind of record
 * that can mention a person, found by the needles of their redaction and written back
 * one row at a time. Bound to one company and one transaction. The Drizzle store is
 * `infrastructure/drizzle-mention-store.ts`; the use-case tests run on an in-memory one.
 */

/** A label an admin typed on a company setting: an API key's or catalog entry's name, a webhook's description. */
export interface SettingLabel {
  kind: "api_key" | "webhook_endpoint" | "department" | "leave_type" | "holiday";
  id: string;
  text: string;
}

export interface MentionStore {
  /** Outbox events whose payload mentions a needle. */
  events(needles: readonly string[]): Promise<{ id: string; payload: unknown }[]>;
  setEventPayload(id: string, payload: unknown): Promise<void>;
  /** Drops the outcome of adapter attempts in flight with these events' old payloads, so they run again. */
  supersedeAdapterAttempts(eventIds: readonly string[], now: Date): Promise<number>;
  /** Webhook deliveries whose body or response excerpt mentions a needle. */
  deliveries(needles: readonly string[]): Promise<{ id: string; status: string; body: string; lastResponseExcerpt: string | null }[]>;
  /** Rewrites a delivery's body and excerpt; `fail` stops a pending one for good (`subject_deleted`). */
  rewriteDelivery(id: string, values: { body: string; lastResponseExcerpt: string | null; fail: boolean; at: Date }): Promise<void>;
  /** Adapter deliveries whose last error mentions a needle. */
  adapterErrors(needles: readonly string[]): Promise<{ id: string; lastError: string | null }[]>;
  setAdapterError(id: string, lastError: string): Promise<void>;
  /** Import runs whose counts, report or file name mention a needle. */
  importRuns(needles: readonly string[]): Promise<{ id: string; counts: unknown; report: unknown; sourceFileName: string }[]>;
  setImportRunText(id: string, values: { counts: unknown; report: unknown; sourceFileName: string }): Promise<void>;
  /** The remaining audit rows whose snapshots mention a needle. */
  auditSnapshots(needles: readonly string[]): Promise<{ id: string; before: unknown; after: unknown }[]>;
  /** Through the database owner's function: the app role cannot update audit rows. */
  setAuditSnapshots(id: string, values: { before: unknown; after: unknown }): Promise<void>;
  /** Leave requests whose note or decision note mentions a needle. */
  notes(needles: readonly string[]): Promise<{ id: string; note: string | null; decisionNote: string | null }[]>;
  setNotes(id: string, values: { note: string | null; decisionNote: string | null }): Promise<void>;
  /** Setting labels that mention a needle. */
  settingLabels(needles: readonly string[]): Promise<SettingLabel[]>;
  setSettingLabel(label: Pick<SettingLabel, "kind" | "id">, text: string): Promise<void>;
}
