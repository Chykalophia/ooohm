/**
 * End-to-end demo setup against a running database (DATABASE_URL), acting as the seeded
 * admin (SEED_ADMIN_EMAIL) through the same services the admin screens call:
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
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../src/db/schema";
import { toActor } from "../../src/domain/actor";
import { createSecretBox } from "../../src/lib/integration-crypto";
import type { ServiceContext } from "../../src/server/context";
import { createAdapterRegistry } from "../../src/server/integrations/adapter";
import { createApiKey } from "../../src/server/services/api-keys";
import { submitLeaveRequest } from "../../src/server/services/leave-requests";
import { createWebhookEndpoint } from "../../src/server/services/webhooks";

const [command, ...args] = process.argv.slice(2);
const client = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => {} });
const db = drizzle(client, { schema, casing: "snake_case" });
const ctx: ServiceContext = {
  db,
  mailer: async () => {},
  defer: (task) => void task(),
  appUrl: "http://localhost",
  now: () => new Date(),
  issueSignInLink: async () => "",
  secrets: createSecretBox(process.env.WEBHOOK_ENCRYPTION_KEY!),
  webhookTargets: { allowInsecure: true, allowPrivate: true },
  adapters: createAdapterRegistry(),
};

try {
  const [admin] = await db.select().from(schema.user).where(eq(schema.user.email, process.env.SEED_ADMIN_EMAIL!.toLowerCase()));
  const actor = toActor(admin)!;
  if (command === "key") {
    const { key } = await createApiKey(ctx, actor, { name: "End-to-end demo" });
    console.log(key);
  } else if (command === "endpoint") {
    const { endpoint, secret } = await createWebhookEndpoint(ctx, actor, {
      url: args[0],
      description: "End-to-end demo receiver",
      eventTypes: ["leave.requested", "leave.approved", "leave.cancelled"],
    });
    writeFileSync(args[1], secret);
    console.log(endpoint.id);
  } else if (command === "leave") {
    const [type] = await db.select().from(schema.leaveTypes).where(eq(schema.leaveTypes.companyId, actor.companyId)).orderBy(schema.leaveTypes.sortOrder);
    const request = await submitLeaveRequest(ctx, actor, { leaveTypeId: type.id, startDate: args[0], endDate: args[0], dayPortion: "full" });
    console.log(request.id);
  } else {
    throw new Error(`Unknown command "${command}"`);
  }
} finally {
  await client.end();
}
