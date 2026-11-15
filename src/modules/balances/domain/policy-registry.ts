import { DomainError } from "@/shared/kernel/errors";
import type { AllowancePolicy } from "./allowance-policy";
import { AnnualCalendarYearPolicy } from "./annual-calendar-year-policy";

/**
 * The allowance policies a company can be configured with, by key. A new policy is a
 * new {@link AllowancePolicy} registered here; nothing else branches on the key.
 */
export class AllowancePolicyRegistry {
  private readonly policies = new Map<string, AllowancePolicy>();

  constructor(policies: readonly AllowancePolicy[] = []) {
    for (const policy of policies) this.register(policy);
  }

  /** Adds `policy` under its key. Two policies cannot share a key. */
  register(policy: AllowancePolicy): this {
    if (this.policies.has(policy.key)) throw new Error(`Allowance policy "${policy.key}" is already registered.`);
    this.policies.set(policy.key, policy);
    return this;
  }

  /** Every registered key, in registration order. */
  keys(): string[] {
    return [...this.policies.keys()];
  }

  /**
   * The policy for `key`.
   *
   * @throws DomainError `policy_unavailable` for a key no policy answers to. Falling
   *   back to a default would quietly compute wrong balances, so this fails instead.
   */
  resolve(key: string): AllowancePolicy {
    const policy = this.policies.get(key);
    if (!policy) throw new DomainError("policy_unavailable", `Unknown allowance policy "${key}".`);
    return policy;
  }
}

/** The policies OOOhm ships: `annual_calendar_year` only, in v1. */
export const allowancePolicies = new AllowancePolicyRegistry([new AnnualCalendarYearPolicy()]);

/** The policy a company is configured with; see {@link AllowancePolicyRegistry.resolve}. */
export function resolveAllowancePolicy(key: string): AllowancePolicy {
  return allowancePolicies.resolve(key);
}
