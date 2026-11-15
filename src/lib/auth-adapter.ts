import "server-only";
import type { BetterAuthOptions, DBAdapter, DBTransactionAdapter, Where } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { tenantDatabase } from "@/db/tenant";
import type { Database } from "@/db/types";
import { findAuthAccountCompany, findAuthPasskeyCompany, findAuthPerson, findAuthSessionCompany } from "@/shared/lib/db/pre-tenant";

/**
 * Better Auth's database adapter under row-level security (ADR-0004). Better Auth looks
 * people up before any company is known (a person by email, a session by its token, an
 * account, a passkey), and its tables (`user`, `session`, `account`, `passkey`) show a
 * transaction only its company's rows. So each operation first finds the company its keys
 * belong to, through the narrow pre-tenant lookups (`ooohm_auth_*`, drizzle/0032), then
 * runs on the tables themselves in that company (`tenantDatabase`), held to the same
 * policies as everything else: an operation can never reach another company's rows.
 *
 * `verification` (sign-in tokens, keyed by email) has no company and is used as is. An
 * operation whose keys name no company runs with none, so it finds nothing and writes
 * nothing: a person without a company cannot sign in, and nothing can create a user
 * (invite-only, as Better Auth's own settings already say).
 */

type AdapterConfig = Parameters<typeof drizzleAdapter>[1];

/** The models whose rows belong to a company, through the person they are of. */
const PERSON_MODELS = new Set(["user", "session", "account", "passkey"]);

/** The plain values a where clause gives `field` (`eq` or `in`), or none. */
function valuesOf(where: readonly Where[] | undefined, field: string): string[] {
  return (where ?? []).flatMap((w) => {
    if (w.field !== field || !(w.operator === undefined || w.operator === "eq" || w.operator === "in")) return [];
    const values = Array.isArray(w.value) ? w.value : [w.value];
    return values.filter((v): v is string => typeof v === "string");
  });
}

function single(where: readonly Where[] | undefined, field: string): string | undefined {
  const values = valuesOf(where, field);
  return values.length === 1 ? values[0] : undefined;
}

/** The lookups that find the companies an operation's keys belong to (none for an OR of conditions, which could span them). */
function lookupsFor(base: Database, model: string, where: readonly Where[] | undefined, data: Record<string, unknown> | undefined): Promise<string | null>[] {
  if ((where ?? []).some((w) => w.connector === "OR")) return [];
  const person = (by: { userId: string } | { email: string }) => findAuthPerson(base, by).then((p) => p?.companyId ?? null);
  const dataUserId = typeof data?.userId === "string" ? [data.userId] : [];
  switch (model) {
    case "user":
      return [...valuesOf(where, "id").map((userId) => person({ userId })), ...valuesOf(where, "email").map((email) => person({ email }))];
    case "session":
      return [...valuesOf(where, "token").map((token) => findAuthSessionCompany(base, token)), ...[...valuesOf(where, "userId"), ...dataUserId].map((userId) => person({ userId }))];
    case "account": {
      const providerId = single(where, "providerId");
      const accountId = single(where, "accountId");
      return [
        ...valuesOf(where, "id").map((id) => findAuthAccountCompany(base, { id })),
        ...(providerId && accountId ? [findAuthAccountCompany(base, { providerId, accountId })] : []),
        ...[...valuesOf(where, "userId"), ...dataUserId].map((userId) => person({ userId })),
      ];
    }
    case "passkey":
      return [
        ...valuesOf(where, "id").map((id) => findAuthPasskeyCompany(base, { id })),
        ...valuesOf(where, "credentialID").map((credentialId) => findAuthPasskeyCompany(base, { credentialId })),
        ...[...valuesOf(where, "userId"), ...dataUserId].map((userId) => person({ userId })),
      ];
    default:
      return [];
  }
}

async function companiesFor(base: Database, model: string, where: readonly Where[] | undefined, data?: Record<string, unknown>): Promise<string[]> {
  const found = await Promise.all(lookupsFor(base, model, where, data));
  return [...new Set(found.filter((c): c is string => c !== null))];
}

/**
 * Better Auth's drizzle adapter over `base` (the app's handle), with every operation on a
 * person's rows run in that person's company. See the module comment.
 */
export function tenantRoutedAdapter(base: Database, config: AdapterConfig): (options: BetterAuthOptions) => DBAdapter<BetterAuthOptions> {
  return (options) => {
    const unscoped = drizzleAdapter(base, config)(options);
    const byCompany = new Map<string, DBAdapter<BetterAuthOptions>>();
    const scoped = (companyId: string) => {
      let adapter = byCompany.get(companyId);
      if (!adapter) byCompany.set(companyId, (adapter = drizzleAdapter(tenantDatabase(base, companyId), config)(options)));
      return adapter;
    };

    /** The adapters an operation runs on: its one company's, or the company-less one (which sees no person's rows). */
    async function targets(model: string, where: readonly Where[] | undefined, data?: Record<string, unknown>) {
      if (!PERSON_MODELS.has(model)) return [unscoped];
      const companies = await companiesFor(base, model, where, data);
      return companies.length === 0 ? [unscoped] : companies.map(scoped);
    }
    /** One row's operation: ambiguous keys (two companies) find nothing. */
    async function one(model: string, where: readonly Where[] | undefined, data?: Record<string, unknown>) {
      const found = await targets(model, where, data);
      return found.length === 1 ? found[0]! : unscoped;
    }
    const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);

    const routed: DBTransactionAdapter<BetterAuthOptions> = {
      ...unscoped,
      create: (async (args) => (await one(args.model, undefined, args.data)).create(args)) as DBAdapter["create"],
      findOne: (async (args) => (await one(args.model, args.where)).findOne(args)) as DBAdapter["findOne"],
      findMany: (async (args) => {
        const rows = (await Promise.all((await targets(args.model, args.where)).map((a) => a.findMany(args)))).flat();
        return args.limit === undefined ? rows : rows.slice(0, args.limit);
      }) as DBAdapter["findMany"],
      count: async (args) => sum(await Promise.all((await targets(args.model, args.where)).map((a) => a.count(args)))),
      update: (async (args) => (await one(args.model, args.where)).update(args)) as DBAdapter["update"],
      updateMany: async (args) => sum(await Promise.all((await targets(args.model, args.where)).map((a) => a.updateMany(args)))),
      delete: (async (args) => (await one(args.model, args.where)).delete(args)) as DBAdapter["delete"],
      deleteMany: async (args) => sum(await Promise.all((await targets(args.model, args.where)).map((a) => a.deleteMany(args)))),
      consumeOne: (async (args) => (await one(args.model, args.where)).consumeOne(args)) as DBAdapter["consumeOne"],
      incrementOne: (async (args) => (await one(args.model, args.where)).incrementOne(args)) as DBAdapter["incrementOne"],
    };
    // Each operation runs in its company's own transaction, so a Better Auth "transaction"
    // runs its operations one after another (as the drizzle adapter does by default).
    return { ...routed, transaction: (callback) => callback(routed) };
  };
}
