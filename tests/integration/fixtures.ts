import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import type { Database } from "@/db/types";
import type { Actor, Role } from "@/domain/actor";

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
  const [company] = await db.insert(schema.companies).values({ name: `Co ${randomUUID().slice(0, 8)}` }).returning();
  const [pto] = await db
    .insert(schema.leaveTypes)
    .values({ companyId: company.id, code: "PTO", name: "PTO", sortOrder: 0 })
    .returning();
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

/** Audit rows for one request, oldest first. */
export async function auditFor(db: Database, requestId: string) {
  return db
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.entityType, "leave_request"), eq(schema.auditLog.entityId, requestId)))
    .orderBy(asc(schema.auditLog.createdAt));
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
