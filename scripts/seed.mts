/**
 * Idempotent first-run seed: one company, its first admin, the default leave types,
 * and the admin's allowances for the current year. Safe to re-run; it only fills gaps.
 * The migrate service runs it on every `docker compose up`, so anything it can't
 * safely decide is logged and skipped rather than thrown (a throw would block startup).
 *
 *   SEED_COMPANY_NAME   default "My Company"
 *   SEED_ADMIN_EMAIL    required
 *   SEED_ADMIN_NAME     default: the part of the email before "@"
 */
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { resolveDatabaseConfig } from "../src/db/config";
import { openDatabase } from "../src/db/connect";
import * as schema from "../src/db/schema";
import { nonEmptyEnv } from "../src/lib/integration-env";
import { yearInTimeZone } from "../src/lib/dates";
import { DEFAULT_LEAVE_TYPES } from "../src/domain/install";

const config = resolveDatabaseConfig(nonEmptyEnv(process.env));
const adminEmail = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
if (adminEmail && !z.email().safeParse(adminEmail).success) {
  throw new Error(`SEED_ADMIN_EMAIL is not a valid email address: "${adminEmail}"`);
}

const companyName = process.env.SEED_COMPANY_NAME?.trim() || "My Company";


const handle = await openDatabase(config, { purpose: "pnpm db:seed", max: 1 });
const { db } = handle;

if (!adminEmail) {
  // Invite-only: on a fresh database the seed admin is the only way anyone can sign in.
  const [anyUser] = await db.select({ id: schema.user.id }).from(schema.user).limit(1);
  await handle.close();
  if (!anyUser) {
    console.error("SEED_ADMIN_EMAIL is not set and no users exist yet, so nobody could sign in. Set it in .env.");
    process.exit(1);
  }
  console.log("SEED_ADMIN_EMAIL is not set; users already exist. Skipping seed.");
  process.exit(0);
}
const adminName = process.env.SEED_ADMIN_NAME?.trim() || adminEmail.split("@")[0];

await db.transaction(async (tx) => {
  // v1 runs one company per deployment. With more than one, "the" company is ambiguous.
  // The same lock as the TimeOff import's --create-company, taken before the check, so
  // the two cannot both see no company and each create one.
  await tx.execute(sql`LOCK TABLE ${schema.companies} IN SHARE ROW EXCLUSIVE MODE`);
  const companies = await tx.select().from(schema.companies).limit(2);
  if (companies.length > 1) {
    console.log("More than one company exists; the first-run seed doesn't apply. Skipping.");
    return;
  }
  let [company] = companies;
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
  // There is a company and a first admin now: the web setup (/setup) closes for good.
  await tx.insert(schema.installation).values({ method: "seed" }).onConflictDoNothing();
  // Never grant allowances to someone who isn't (or is no longer) this company's admin.
  if (admin.companyId !== company.id || admin.role !== "admin" || !admin.isActive) {
    console.log(`${admin.email} exists but isn't an active admin of this company. Skipping allowances.`);
    return;
  }

  const year = yearInTimeZone(company.timezone);
  const types = await tx
    .select()
    .from(schema.leaveTypes)
    .where(eq(schema.leaveTypes.companyId, company.id));
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

await handle.close();
console.log("Seed complete.");
