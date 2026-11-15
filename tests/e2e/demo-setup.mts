/**
 * End-to-end demo setup against a database (DATABASE_ADMIN_URL, else DATABASE_URL, or OOOHM_DB=embedded while the
 * app is stopped), acting as the seeded admin (SEED_ADMIN_EMAIL) through the same services
 * the admin screens call:
 *
 *   tsx --conditions=react-server tests/e2e/demo-setup.mts key
 *   tsx --conditions=react-server tests/e2e/demo-setup.mts endpoint <url> <secret-file>
 *   tsx --conditions=react-server tests/e2e/demo-setup.mts leave <YYYY-MM-DD>
 *
 * `key` prints a new API key; `endpoint` adds a webhook endpoint for leave events and
 * writes its secret to <secret-file>; `leave` submits a one-day request for the admin.
 * For local trials only (it needs WEBHOOK_ENCRYPTION_KEY, and uses the development URL
 * policy); never against production.
 */
import { writeFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { resolveAdminDatabaseConfig, resolveDatabaseConfig } from "../../src/db/config";
import { openDatabase } from "../../src/db/connect";
import * as schema from "../../src/db/schema";
import { toActor } from "../../src/shared/kernel/actor";
import { createSecretBox } from "../../src/lib/integration-crypto";
import type { ServiceContext } from "../../src/server/context";
import { createAdapterRegistry } from "../../src/server/integrations/adapter";
import { submitLeaveRequest as submitLeaveRequestResult } from "../../src/modules/leave";
import { unwrap } from "../../src/shared/lib/result";
import { createApiKey as createApiKeyResult, createWebhookEndpoint as createWebhookEndpointResult } from "../../src/modules/integrations";
import { uuidGenerator } from "../../src/shared/lib/id-generator";
import { wireModules } from "../../src/server/wiring";
import { at, first } from "../support/present";

wireModules();

// The integrations use cases return a ServiceResult; these tests read the value or the thrown DomainError.
const createApiKey = (...args: Parameters<typeof createApiKeyResult>) => createApiKeyResult(...args).then(unwrap);
const createWebhookEndpoint = (...args: Parameters<typeof createWebhookEndpointResult>) => createWebhookEndpointResult(...args).then(unwrap);

const submitLeaveRequest = (...args: Parameters<typeof submitLeaveRequestResult>) => submitLeaveRequestResult(...args).then(unwrap);

const [command, ...args] = process.argv.slice(2);
// On Postgres, as the owner (DATABASE_ADMIN_URL) when it is set: it finds the admin before
// any company is known, which row-level security hides from the app role.
const config = process.env.DATABASE_ADMIN_URL?.trim() ? resolveAdminDatabaseConfig(process.env) : resolveDatabaseConfig(process.env);
const handle = await openDatabase(config, { purpose: "the e2e demo setup", max: 2 });
const { db } = handle;
const ctx: ServiceContext = {
  db,
  mailer: async () => {},
  defer: (task) => void task(),
  appUrl: "http://localhost",
  now: () => new Date(),
  ids: uuidGenerator,
  issueSignInLink: async () => "",
  secrets: createSecretBox(process.env.WEBHOOK_ENCRYPTION_KEY!),
  webhookTargets: { allowInsecure: true, allowPrivate: true },
  adapters: createAdapterRegistry(),
};

try {
  const admin = first(await db.select().from(schema.user).where(eq(schema.user.email, process.env.SEED_ADMIN_EMAIL!.toLowerCase())));
  const actor = toActor(admin)!;
  if (command === "key") {
    const { key } = await createApiKey(ctx, actor, { name: "End-to-end demo" });
    console.log(key);
  } else if (command === "endpoint") {
    const { endpoint, secret } = await createWebhookEndpoint(ctx, actor, {
      url: at(args, 0),
      description: "End-to-end demo receiver",
      eventTypes: ["leave.requested", "leave.approved", "leave.cancelled"],
    });
    writeFileSync(at(args, 1), secret);
    console.log(endpoint.id);
  } else if (command === "leave") {
    const type = first(await db.select().from(schema.leaveTypes).where(eq(schema.leaveTypes.companyId, actor.companyId)).orderBy(schema.leaveTypes.sortOrder));
    const request = await submitLeaveRequest(ctx, actor, { leaveTypeId: type.id, startDate: at(args, 0), endDate: at(args, 0), dayPortion: "full" });
    console.log(request.id);
  } else {
    throw new Error(`Unknown command "${command}"`);
  }
} finally {
  await handle.close();
}
