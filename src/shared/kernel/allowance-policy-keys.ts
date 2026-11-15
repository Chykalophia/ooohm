/**
 * The allowance policy keys a company can be configured with (`companies.allowance_policy`).
 * The balances module's policy registry answers to exactly these
 * (`tests/unit/modules/balances/policy-registry.test.ts` checks it); the company
 * settings form validates against them without depending on balances.
 */

/** The policy key v1 ships, and the column default. */
export const ANNUAL_CALENDAR_YEAR = "annual_calendar_year";

/** Every policy key, for the company settings form and its validation. */
export const ALLOWANCE_POLICY_KEYS: readonly string[] = [ANNUAL_CALENDAR_YEAR];
