import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import type { Database } from "@/db/types";
import type { Actor, Role } from "@/domain/actor";
import { byUser } from "@/domain/change-source";
import type { ServiceContext } from "@/server/context";
import { getApprovalTriage } from "@/server/services/approvals";

export interface PersonSpec {
  role?: Role;
  canSelfApprove?: boolean;
  managerKey?: string;
  isActive?: boolean;
  /** Creation time; decides which admin is the fallback approver. */
  createdAt?: string;
}

export interface Company {
  companyId: string;
  /** Active, first by sort order: the default leave type. */
  pto: string;
  archived: string;
  people: Record<string, Actor & { email: string; name: string }>;
}

/**
 * Seeds an isolated company: a PTO type, an archived type, one holiday
 * (Thu 2026-11-26), Mon-Fri working days, and the given people. Every call makes a new
 * company, so tests in one file never see each other's rows.
 */
export async function seedCompany(db: Database, people: Record<string, PersonSpec>): Promise<Company> {
  const [company] = await db
    .insert(schema.companies)
    .values({ name: `Co ${randomUUID().slice(0, 8)}` })
    .returning();
  const [pto] = await db.insert(schema.leaveTypes).values({ companyId: company.id, code: "PTO", name: "PTO", sortOrder: 0 }).returning();
  const [archived] = await db
    .insert(schema.leaveTypes)
    .values({ companyId: company.id, code: "OLD", name: "Old", sortOrder: 1, archivedAt: new Date() })
    .returning();
  await db.insert(schema.holidays).values({ companyId: company.id, date: "2026-11-26", name: "Thanksgiving" });

  const ids = Object.fromEntries(Object.keys(people).map((key) => [key, randomUUID()]));
  const out: Company["people"] = {};
  for (const [key, spec] of Object.entries(people)) {
    const email = `${key.toLowerCase()}-${ids[key].slice(0, 8)}@example.com`;
    await db.insert(schema.user).values({
      id: ids[key],
      name: key[0].toUpperCase() + key.slice(1),
      email,
      companyId: company.id,
      role: spec.role ?? "employee",
      canSelfApprove: spec.canSelfApprove ?? false,
      isActive: spec.isActive ?? true,
      createdAt: spec.createdAt ? new Date(spec.createdAt) : undefined,
    });
    out[key] = {
      id: ids[key],
      companyId: company.id,
      role: spec.role ?? "employee",
      canSelfApprove: spec.canSelfApprove ?? false,
      source: byUser(ids[key]),
      email,
      name: key[0].toUpperCase() + key.slice(1),
    };
  }
  // Managers are linked after everyone exists, so specs can reference each other.
  for (const [key, spec] of Object.entries(people)) {
    if (spec.managerKey) {
      await db.update(schema.user).set({ managerId: ids[spec.managerKey] }).where(eq(schema.user.id, ids[key]));
    }
  }
  return { companyId: company.id, pto: pto.id, archived: archived.id, people: out };
}

/**
 * Every pending request `actor` may decide, first page of both Approvals tabs (Needs you,
 * then Waiting on others), with their combined count: what one inbox used to hold.
 */
export async function decidable(ctx: ServiceContext, actor: Actor) {
  const mine = await getApprovalTriage(ctx, actor, { view: "mine", size: 100 });
  const others = await getApprovalTriage(ctx, actor, { view: "others", size: 100 });
  // A non-admin asking for "others" gets their own tab back; count it once.
  const items = [...mine.items, ...(others.view === "others" ? others.items : [])];
  return { items, total: mine.needsYouTotal + mine.waitingTotal };
}

/** Audit rows for one request, oldest first. */
export async function auditFor(db: Database, requestId: string) {
  return db
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.entityType, "leave_request"), eq(schema.auditLog.entityId, requestId)))
    .orderBy(asc(schema.auditLog.createdAt));
}

/** A company's audit rows, oldest first, optionally only those whose action starts with `prefix`. */
export async function companyAudit(db: Database, companyId: string, prefix = "") {
  const rows = await db
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.companyId, companyId))
    .orderBy(asc(schema.auditLog.createdAt));
  return rows.filter((r) => r.action.startsWith(prefix));
}

/** A company's outbox events, oldest first, optionally only those whose type starts with `prefix`. */
export async function companyEvents(db: Database, companyId: string, prefix = "") {
  const rows = await db
    .select()
    .from(schema.eventsOutbox)
    .where(eq(schema.eventsOutbox.companyId, companyId))
    .orderBy(asc(schema.eventsOutbox.createdAt));
  return rows.filter((r) => r.type.startsWith(prefix));
}

/** Captures what `work` writes to stderr (the error log), restoring it afterwards. */
export async function captureStderr(work: () => Promise<void>): Promise<string[]> {
  const stderr = process.stderr.write.bind(process.stderr);
  const logged: string[] = [];
  process.stderr.write = ((chunk: string) => (logged.push(String(chunk)), true)) as typeof process.stderr.write;
  try {
    await work();
  } finally {
    process.stderr.write = stderr;
  }
  return logged;
}

/** Outbox events whose payload names this request, in insertion order. */
export async function eventsFor(db: Database, companyId: string, requestId: string) {
  const rows = await db
    .select()
    .from(schema.eventsOutbox)
    .where(eq(schema.eventsOutbox.companyId, companyId))
    .orderBy(asc(schema.eventsOutbox.createdAt));
  return rows.filter((r) => (r.payload as { requestId?: string }).requestId === requestId);
}

export async function requestsOf(db: Database, userId: string) {
  return db.select().from(schema.leaveRequests).where(eq(schema.leaveRequests.userId, userId));
}

export interface LeaveTypeSpec {
  code: string;
  defaultAllowanceDays?: number | null;
  countsAgainstAllowance?: boolean;
  carryoverEnabled?: boolean;
  carryoverMaxDays?: number | null;
  sortOrder?: number;
  archived?: boolean;
}

/** Adds a leave type with balance settings to a seeded company; returns its id. */
export async function addLeaveType(db: Database, companyId: string, spec: LeaveTypeSpec): Promise<string> {
  const [row] = await db
    .insert(schema.leaveTypes)
    .values({
      companyId,
      code: spec.code,
      name: spec.code,
      defaultAllowanceDays: spec.defaultAllowanceDays ?? null,
      countsAgainstAllowance: spec.countsAgainstAllowance ?? true,
      carryoverEnabled: spec.carryoverEnabled ?? false,
      carryoverMaxDays: spec.carryoverMaxDays ?? null,
      sortOrder: spec.sortOrder ?? 10,
      archivedAt: spec.archived ? new Date() : null,
    })
    .returning();
  return row.id;
}

/** Sets (inserting or replacing) a person's allowance row for one type and year. */
export async function setAllowance(
  db: Database,
  values: { userId: string; leaveTypeId: string; year: number; days: number; carriedOverDays?: number; adjustmentDays?: number },
) {
  const row = { carriedOverDays: 0, adjustmentDays: 0, ...values };
  await db
    .insert(schema.allowances)
    .values(row)
    .onConflictDoUpdate({
      target: [schema.allowances.userId, schema.allowances.leaveTypeId, schema.allowances.year],
      set: { days: row.days, carriedOverDays: row.carriedOverDays, adjustmentDays: row.adjustmentDays },
    });
}

/** A person's allowance rows, as `{ leaveTypeId, year, days, carriedOverDays, adjustmentDays }`, sorted. */
export async function allowancesOf(db: Database, userId: string) {
  const rows = await db.select().from(schema.allowances).where(eq(schema.allowances.userId, userId));
  return rows
    .map(({ leaveTypeId, year, days, carriedOverDays, adjustmentDays }) => ({ leaveTypeId, year, days, carriedOverDays, adjustmentDays }))
    .sort((a, b) => a.year - b.year || a.leaveTypeId.localeCompare(b.leaveTypeId));
}

/** What a request costs per year, as stored at submit. */
export async function requestDaysOf(db: Database, requestId: string) {
  const rows = await db
    .select({ year: schema.leaveRequestDays.year, days: schema.leaveRequestDays.days })
    .from(schema.leaveRequestDays)
    .where(eq(schema.leaveRequestDays.requestId, requestId));
  return rows.sort((a, b) => a.year - b.year);
}

/** A request email's subject, "Ana asked for Nov 23 to Nov 27", which names the requester and dates. */
export const REVIEW_SUBJECT = /^.+ asked for [A-Z][a-z]{2} \d{1,2}( to [A-Z][a-z]{2} \d{1,2})?$/;

/** An email's subject with request emails' names and dates folded away, for comparing lists. */
export function subjectOf(mail: { subject: string }): string {
  return REVIEW_SUBJECT.test(mail.subject) ? "Time off request to review" : mail.subject;
}
