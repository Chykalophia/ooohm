/**
 * Rules for deleting a person: when it is allowed, what the tombstone left behind is
 * called, what the confirmation dialog says it will remove, and how a person's name and
 * email are taken out of stored text and JSON. Pure; the deletion service loads the
 * facts and applies these inside its transaction.
 *
 * A deleted person's `user` row is never removed: it stays as a tombstone so every
 * foreign key to it holds. Two modes:
 *
 * - `scrubbed` (the default): nothing about the person remains. The tombstone is
 *   "Former employee #<short id>".
 * - `records_kept`: their sign-in and email go, their history stays under
 *   "<Name> (deleted)".
 */
import type { Role } from "./actor";
import { DomainError } from "./errors";
import type { DeletionMode } from "./events";
import { displayName } from "./person";
import { oneLine } from "./text";

export type { DeletionMode } from "./events";

export const DELETION_MODES: readonly DeletionMode[] = ["scrubbed", "records_kept"];

/** How long a full scrub waits when the company's grace option is on. */
export const DELETION_GRACE_DAYS = 7;

export function isDeletionMode(value: unknown): value is DeletionMode {
  return typeof value === "string" && (DELETION_MODES as readonly string[]).includes(value);
}

/** When a scrub requested at `now` may run, with the grace option on. */
export function scrubDueAt(now: Date): Date {
  return new Date(now.getTime() + DELETION_GRACE_DAYS * 86_400_000);
}

/**
 * A short id for naming a tombstone ("Former employee #3f9a2c"): the first six letters or
 * digits of the person's id, lowercased. Stable (the same person always gets the same
 * one) and not secret: the full id is already in every record about them.
 */
export function shortStableId(userId: string): string {
  const id = userId.replace(/[^A-Za-z0-9]/g, "").toLowerCase().slice(0, 6);
  return id || "000000";
}

const DELETED_SUFFIX = " (deleted)";
/** Names are capped at 100 characters on display; the suffix must survive that cap. */
const TOMBSTONE_NAME_MAX = 100;

/**
 * The name a tombstone carries: "Former employee #3f9a2c" after a full scrub, "Ana Lima
 * (deleted)" when records were kept (cut so the suffix always shows).
 */
export function tombstoneName(person: { id: string; name: string }, mode: DeletionMode): string {
  if (mode === "scrubbed") return `Former employee #${shortStableId(person.id)}`;
  const base = displayName(person.name).slice(0, TOMBSTONE_NAME_MAX - DELETED_SUFFIX.length).trim();
  return `${base || "Former employee"}${DELETED_SUFFIX}`;
}

const TOMBSTONE_EMAIL = /^deleted\+[a-z0-9-]+@invalid$/;

/**
 * The email a tombstone carries in place of the real one: `deleted+<id>@invalid`.
 * Unique (the id is), lowercase (the `user_email_lowercase` check), and unusable: `.invalid`
 * is reserved and never resolves (RFC 2606), and an address without a dot after the `@`
 * fails the email rule invites, syncs and Better Auth's sign-in endpoint all apply, so
 * it can neither be mailed nor signed in with. Ids outside `[a-z0-9-]` are hex-encoded so
 * two ids can never fold to one address.
 */
export function tombstoneEmail(userId: string): string {
  const safe = /^[a-z0-9-]+$/.test(userId)
    ? userId
    : [...new TextEncoder().encode(userId)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `deleted+${safe}@invalid`;
}

export function isTombstoneEmail(email: string): boolean {
  return TOMBSTONE_EMAIL.test(email);
}

/** What has to change before a person can be deleted. Every field empty or false: nothing blocks. */
export interface DeletionBlockers {
  /** Deleting takes two steps: deactivate first. */
  readonly stillActive: boolean;
  /** People whose manager they are: give them another manager first. */
  readonly reports: readonly { id: string; name: string }[];
  /** Pending requests assigned to them to decide. */
  readonly pendingApprovals: number;
  /** They are the company's only active admin. */
  readonly lastAdmin: boolean;
}

/** The facts the deletion rules need, read under the company and member locks. */
export interface DeletionFacts {
  person: { id: string; role: Role; isActive: boolean };
  reports: readonly { id: string; name: string }[];
  pendingApprovals: number;
  /** The company's active admins before the change. */
  activeAdminIds: readonly string[];
}

export function deletionBlockers(facts: DeletionFacts): DeletionBlockers {
  const { person } = facts;
  return {
    stillActive: person.isActive,
    reports: facts.reports,
    pendingApprovals: facts.pendingApprovals,
    // Only an active admin holds a seat, so this can only ever add to `stillActive`.
    lastAdmin: person.role === "admin" && person.isActive && !facts.activeAdminIds.some((id) => id !== person.id),
  };
}

export function isBlocked(blockers: DeletionBlockers): boolean {
  return blockers.stillActive || blockers.reports.length > 0 || blockers.pendingApprovals > 0 || blockers.lastAdmin;
}

/**
 * @throws DomainError `deletion_blocked`, carrying the {@link DeletionBlockers} as its
 *   `details`, when anything blocks the delete.
 */
export function assertDeletable(facts: DeletionFacts): void {
  const blockers = deletionBlockers(facts);
  if (isBlocked(blockers)) throw new DomainError("deletion_blocked", "Something has to change before this person can be deleted.", blockers);
}

/** The blockers a `deletion_blocked` error carries; `null` for any other error. */
export function deletionBlockersOf(err: DomainError): DeletionBlockers | null {
  return err.code === "deletion_blocked" && err.details && "stillActive" in err.details ? err.details : null;
}

/** What the admin must type to confirm: the person's name as shown, or their email when the name is blank. */
export function confirmationTarget(person: { name: string; email: string }): string {
  return displayName(person.name) || person.email;
}

const fold = (s: string) => oneLine(s).toLocaleLowerCase();

/** Whether `typed` is the person's full name (spaces and case aside). */
export function confirmationMatches(typed: string, person: { name: string; email: string }): boolean {
  const target = fold(confirmationTarget(person));
  return target.length > 0 && fold(typed) === target;
}

/** @throws DomainError `confirmation_mismatch` unless `typed` is the person's full name. */
export function assertConfirmed(typed: string, person: { name: string; email: string }): void {
  if (!confirmationMatches(typed, person)) throw new DomainError("confirmation_mismatch");
}

/** What a person's delete would remove, counted from the database for the confirmation. */
export interface DeletionCounts {
  leaveRequests: number;
  /** Their own requests still waiting for a decision: keeping records withdraws them. */
  pendingRequests: number;
  /** Distinct years they have allowance rows for. */
  balanceYears: number;
  allowanceRows: number;
  /** Audit entries about them (`subject_user_id`). */
  auditEntries: number;
  sessions: number;
  /** Linked sign-in accounts, such as Google. */
  accounts: number;
  calendarFeeds: number;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The confirmation's account of a delete, in plain words: what goes and what stays.
 * Counts of zero are left out.
 */
export function describeDeletion(mode: DeletionMode, c: DeletionCounts): { removes: string[]; keeps: string[] } {
  const signIn = [
    c.sessions > 0 ? plural(c.sessions, "signed-in session") : null,
    c.accounts > 0 ? plural(c.accounts, "linked Google sign-in") : null,
    c.calendarFeeds > 0 ? plural(c.calendarFeeds, "calendar link") : null,
  ].filter((s): s is string => s !== null);
  const history = [
    c.leaveRequests > 0 ? plural(c.leaveRequests, "leave request") : null,
    c.balanceYears > 0 ? plural(c.balanceYears, "year of balances", "years of balances") : null,
    c.auditEntries > 0 ? plural(c.auditEntries, "audit entry", "audit entries") : null,
  ].filter((s): s is string => s !== null);
  if (mode === "scrubbed") {
    return { removes: ["their name and email, everywhere OOOhm stores them", ...history, ...signIn], keeps: [] };
  }
  const withdrawn = c.pendingRequests > 0 ? [`${plural(c.pendingRequests, "request")} of theirs still waiting for a decision (withdrawn)`] : [];
  return { removes: ["their email address", ...withdrawn, ...signIn], keeps: history.length > 0 ? history : ["their history (there is none yet)"] };
}

/**
 * How a deleted person's personal data is taken out of stored text and JSON.
 *
 * - Their **email** is replaced wherever it stands as a whole address, in either mode. A
 *   longer address that merely contains it (`ted@acme.com` when `ed@acme.com` goes) is
 *   another person's and is left alone.
 * - On a full scrub, their **name** goes too, in two ways. The `name` field of a record
 *   that is theirs (see {@link redactJson}) becomes the tombstone name, whatever name it
 *   holds, so a name they had before a rename goes as well. In free text (notes, reasons,
 *   messages, and the name of a thing such as an API key or a holiday) every full name
 *   they are known to have had is replaced, as whole words and ignoring case, but only a
 *   name of two or more words: a one-word name ("May", "Will") is too often an ordinary
 *   word to rewrite other people's text for. Nor is a name another person of the company
 *   also has: the text cannot say which of them it means.
 * - The `name` field of a record that is someone else's is never rewritten by name.
 */
export interface PersonRedaction {
  /** Whose data: their id and current email tell their records from others'. */
  owner: { id: string; email: string };
  /** What their email address becomes. */
  emailReplacement: string;
  /** Full scrub only (`null` when records are kept). */
  name: {
    /** What the `name` field of their own records becomes. */
    replacement: string;
    /** The full names searched for in free text: two words or more, longest first. */
    freeText: readonly string[];
  } | null;
}

/**
 * The redaction for a deleted person. A full scrub replaces their name and email; keeping
 * records replaces only the email (their name stays on the history kept under the
 * tombstone).
 *
 * @param formerNames Names they had before their current one (from their own `user.*`
 *   events and audit snapshots), searched for in free text too.
 * @param namesInUse The names the company's other people go by (see {@link nameInUse}).
 *   A name one of them shares is left out of the free-text search, so a scrub never
 *   rewrites a namesake's notes, or anyone's mention of them.
 */
export function personRedactions(
  person: { id: string; name: string; email: string },
  mode: DeletionMode,
  formerNames: readonly string[] = [],
  namesInUse: readonly string[] = [],
): PersonRedaction {
  const base = { owner: { id: person.id, email: person.email }, emailReplacement: tombstoneEmail(person.id) };
  if (mode !== "scrubbed") return { ...base, name: null };
  const shared = new Set(namesInUse.map(fold));
  const byFolded = new Map<string, string>();
  for (const n of [person.name, ...formerNames].map(displayName)) {
    if (n.includes(" ") && !byFolded.has(fold(n)) && !shared.has(fold(n))) byFolded.set(fold(n), n);
  }
  const freeText = [...byFolded.values()].sort((a, b) => b.length - a.length);
  return { ...base, name: { replacement: tombstoneName(person, "scrubbed"), freeText } };
}

/**
 * The name another person of the company goes by, for {@link personRedactions}: their
 * name, or, for someone deleted with their records kept, the name before " (deleted)"
 * (their kept history still says it). `null` for a scrubbed tombstone, which shares no
 * one's name.
 */
export function nameInUse(person: { name: string; deletionMode: string | null }): string | null {
  if (person.deletionMode === "scrubbed") return null;
  if (person.deletionMode === "records_kept" && person.name.endsWith(DELETED_SUFFIX)) return person.name.slice(0, -DELETED_SUFFIX.length);
  return person.name;
}

/**
 * The strings to look for in stored text before redacting it, lowercased: the email, the
 * longest word of each free-text name, each as written and as escaped inside JSON, and
 * the person's id (which finds the records that are theirs, whatever name they hold).
 * A name is looked for by one word because the rewrite matches its words with any run of
 * spaces between them (two spaces, a line break, or `\n` inside JSON), which no single
 * substring covers. So the lookup finds every row the rewrite would change (as far as
 * the database lowercases letters as JavaScript does), and some it then leaves alone.
 */
export function redactionNeedles(r: PersonRedaction): string[] {
  const longestWord = (name: string) => name.split(/\s+/).reduce((a, b) => (b.length > a.length ? b : a), "");
  const values = [r.owner.email, ...(r.name?.freeText ?? []).map(longestWord)].filter((v) => v.length > 0);
  const needles = values.flatMap((v) => [v, JSON.stringify(v).slice(1, -1)]);
  if (r.name) needles.push(r.owner.id);
  return [...new Set(needles.map((s) => s.toLowerCase()))];
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `email` as a whole address: not preceded by a character that could continue its local
 * part, and not followed by one that could continue its domain (a dot counts only when
 * more of a domain follows it, so a sentence may end right after the address).
 */
function emailPattern(email: string): RegExp {
  // Only the characters that continue a local part in practice: the rarer ones RFC 5322
  // allows there (`/ = ? { | # &`...) are far more often a separator in a URL, query
  // string or log line (`/users/ed@acme.com`, `?email=ed@acme.com`).
  return new RegExp(`(?<![\\p{L}\\p{N}._%+-])${escapeRegExp(email)}(?![\\p{L}\\p{N}-]|\\.[\\p{L}\\p{N}])`, "giu");
}

/** `name` as whole words, ignoring case, any run of spaces between its words. */
function namePattern(name: string): RegExp {
  const body = name.split(" ").map(escapeRegExp).join("\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, "giu");
}

function redactEmail(text: string, r: PersonRedaction): string {
  return r.owner.email.length > 0 ? text.replace(emailPattern(r.owner.email), () => r.emailReplacement) : text;
}

/** Whether `text` still holds the person's email as a whole address. */
export function mentionsEmail(text: string, r: PersonRedaction): boolean {
  return r.owner.email.length > 0 && emailPattern(r.owner.email).test(text);
}

/** Free `text` (a note, a reason, a message) with the person's email and, on a scrub, their full names replaced. */
export function redactText(text: string, r: PersonRedaction): string {
  const out = redactEmail(text, r);
  if (!r.name) return out;
  const replacement = r.name.replacement;
  return r.name.freeText.reduce((acc, name) => acc.replace(namePattern(name), () => replacement), out);
}

/**
 * Whose record an object in stored JSON is, by its own `userId`, else its `email` (a
 * person snapshot in the audit log carries only the email): `owner`'s, another
 * person's, or no person's (a holiday, an API key).
 */
function recordOf(o: Record<string, unknown>, owner: { id: string; email: string }): "theirs" | "other" | "none" {
  if (typeof o.userId === "string") return o.userId === owner.id ? "theirs" : "other";
  if (typeof o.email === "string") return o.email.toLowerCase() === owner.email.toLowerCase() ? "theirs" : "other";
  return "none";
}

function isOwnRecord(o: Record<string, unknown>, owner: { id: string; email: string }): boolean {
  return recordOf(o, owner) === "theirs";
}

/**
 * A JSON value with the person's data redacted. Numbers, booleans and structure are
 * untouched; object keys lose only the email. An object is theirs when its own `userId`
 * or `email` ({@link recordOf}) says so: on a scrub, its `name` field becomes the
 * tombstone name, whatever name it holds. The `name` field of someone else's record
 * keeps its value bar the email. Every other string, the `name` of a thing (an API key,
 * a holiday, a department) included, is free text ({@link redactText}), whoever the
 * record is about.
 *
 * @returns The redacted copy, and whether anything changed.
 */
export function redactJson(value: unknown, r: PersonRedaction): { value: unknown; changed: boolean } {
  let changed = false;
  const text = (from: string, to: string) => {
    if (to !== from) changed = true;
    return to;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return text(v, redactText(v, r));
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const whose = recordOf(o, r.owner);
      return Object.fromEntries(
        Object.entries(o).map(([k, item]) => {
          const key = text(k, redactEmail(k, r));
          if (k !== "name" || typeof item !== "string" || whose === "none") return [key, walk(item)];
          return [key, text(item, whose === "theirs" && r.name ? r.name.replacement : redactEmail(item, r))];
        }),
      );
    }
    return v;
  };
  const out = walk(value);
  return { value: out, changed };
}

/**
 * A stored webhook body (the envelope as JSON text) with the person's data redacted, or
 * `null` when it cannot be redacted safely: it is not JSON, or their email is still in
 * it afterwards. A pending delivery whose body cannot be redacted must never be sent.
 */
export function redactJsonText(text: string, r: PersonRedaction): { text: string; changed: boolean } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const { value, changed } = redactJson(parsed, r);
  const out = changed ? JSON.stringify(value) : text;
  if (mentionsEmail(out, r)) return null;
  return { text: out, changed };
}

/**
 * The names a person's own records hold: the `name` field of each object in `value` that
 * is theirs by its own `userId` or `email`, and of the top-level object too when
 * `whole` says the whole value is about them (an audit snapshot of their account). How
 * a scrub learns the names they had before a rename, before those records go.
 */
export function namesInOwnRecords(value: unknown, owner: { id: string; email: string }, whole = false): string[] {
  const found: string[] = [];
  const walk = (v: unknown, top: boolean) => {
    if (Array.isArray(v)) {
      for (const item of v) walk(item, false);
      return;
    }
    if (v === null || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (typeof o.name === "string" && ((top && whole) || isOwnRecord(o, owner))) found.push(o.name);
    for (const item of Object.values(o)) walk(item, false);
  };
  walk(value, true);
  return found;
}
