/**
 * The `ServiceContext` for a command-line process (the rollover job, the importer, the
 * worker). None of them sends email or signs anyone in, so those refuse loudly rather
 * than drop anything silently; there is no app URL, and `defer` runs its task at once.
 */
import type { Database } from "../src/db/types";
import { STRICT_TARGET_POLICY, type TargetPolicy } from "../src/domain/webhook-target";
import { type SecretBox, unavailableSecretBox } from "../src/lib/integration-crypto";
import type { ServiceContext } from "../src/server/context";
import { type AdapterRegistry, createAdapterRegistry } from "../src/server/integrations/adapter";

/**
 * @param name The process as it reads in an error, e.g. "rollover job" gives "The rollover
 *   job does not send email."
 * @param options.secrets Default: a box that refuses, for processes without the key.
 * @param options.webhookTargets Default: {@link STRICT_TARGET_POLICY}.
 * @param options.adapters Default: an empty registry.
 */
export function scriptContext(
  db: Database,
  name: string,
  options: { secrets?: SecretBox; webhookTargets?: TargetPolicy; adapters?: AdapterRegistry } = {},
): ServiceContext {
  const refuse = (what: string) => async (): Promise<never> => {
    throw new Error(`The ${name} does not ${what}.`);
  };
  return {
    db,
    mailer: refuse("send email"),
    defer: (task) => void task(),
    appUrl: "",
    now: () => new Date(),
    issueSignInLink: refuse("sign anyone in"),
    secrets: options.secrets ?? unavailableSecretBox(`The ${name} holds no webhook encryption key.`),
    webhookTargets: options.webhookTargets ?? STRICT_TARGET_POLICY,
    adapters: options.adapters ?? createAdapterRegistry(),
  };
}
