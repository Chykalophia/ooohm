/**
 * Idempotent first-run seed: one company, its first admin, the default leave types,
 * and the admin's allowances for the current year. Safe to re-run; it only fills gaps.
 *
 *   SEED_COMPANY_NAME   default "My Company"
 *   SEED_ADMIN_EMAIL    required
 *   SEED_ADMIN_NAME     default: the part of the email before "@"
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../src/db/schema";

const url = process.env.DATABASE_URL;
const adminEmail = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
if (!url) throw new Error("DATABASE_URL is not set");
if (!adminEmail) {
  console.log("SEED_ADMIN_EMAIL is not set; skipping seed.");
  process.exit(0);
}

const companyName = process.env.SEED_COMPANY_NAME?.trim() || "My Company";
const adminName = process.env.SEED_ADMIN_NAME?.trim() || adminEmail.split("@")[0];

/** Default leave types. Allowance numbers are starting points that admins can change. */
const DEFAULT_LEAVE_TYPES = [
  { code: "PTO", name: "PTO (Scheduled Time Off)", color: "#0f766e", defaultAllowanceDays: 15 },
  { code: "EMERGENCY", name: "Emergency Leave", color: "#b45309", defaultAllowanceDays: 3 },
  { code: "SICK", name: "Sick Leave", color: "#be123c", defaultAllowanceDays: 5 },
  { code: "BONUS", name: "Bonus Time Off", color: "#7c3aed", defaultAllowanceDays: 0 },
] as const;

const client = postgres(url, { max: 1 });
const db = drizzle(client, { schema, casing: "snake_case" });

await db.transaction(async (tx) => {
  let [company] = await tx.select().from(schema.companies).limit(1);
  if (!company) {
    [company] = await tx.insert(schema.companies).values({ name: companyName }).returning();
    console.log(`Created company "${company.name}".`);
  }

  for (const [i, lt] of DEFAULT_LEAVE_TYPES.entries()) {
    await tx
      .insert(schema.leaveTypes)
      .values({ companyId: company.id, sortOrder: i, ...lt })
      .onConflictDoNothing({ target: [schema.leaveTypes.companyId, schema.leaveTypes.code] });
  }

  let [admin] = await tx.select().from(schema.user).where(eq(schema.user.email, adminEmail));
  if (!admin) {
    [admin] = await tx
      .insert(schema.user)
      .values({
        id: randomUUID(),
        email: adminEmail,
        name: adminName,
        emailVerified: true,
        companyId: company.id,
        role: "admin",
        canSelfApprove: true,
      })
      .returning();
    console.log(`Created admin ${admin.email}.`);
  }

  const year = new Date().getFullYear();
  const types = await tx
    .select()
    .from(schema.leaveTypes)
    .where(and(eq(schema.leaveTypes.companyId, company.id)));
  for (const lt of types) {
    if (lt.defaultAllowanceDays === null) continue;
    await tx
      .insert(schema.allowances)
      .values({ userId: admin.id, leaveTypeId: lt.id, year, days: lt.defaultAllowanceDays })
      .onConflictDoNothing({
        target: [schema.allowances.userId, schema.allowances.leaveTypeId, schema.allowances.year],
      });
  }
});

await client.end();
console.log("Seed complete.");
