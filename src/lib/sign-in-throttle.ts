import { eq, sql } from "drizzle-orm";
import { executeRows } from "@/db/rows";
import type { Executor } from "@/db/types";
import { verification } from "@/db/schema";
import { SIGN_IN_LINK_MINUTES } from "./sign-in-email";

/**
 * Sign-in links one address may be sent in {@link SIGN_IN_LINK_MINUTES} minutes, the one
 * being sent included. Better Auth's own limit counts per client address and, on a
 * serverless host, per instance, so on its own it lets someone spread over a few
 * addresses fill a coworker's inbox. This one counts in the database, per recipient,
 * so it holds across instances and restarts. Only links that were sent are counted,
 * since a refused one is deleted ({@link discardSignInLink}): repeated requests past the
 * cap never push the window out. Invites are always sent (an admin chose to), but they
 * count toward the address's allowance.
 */
export const SIGN_IN_EMAILS_PER_ADDRESS = 5;

/**
 * How many sign-in links were issued for `email` at or after `since`, read from the
 * rows Better Auth's magic-link plugin writes (`identifier` `magic-link:<token>`,
 * `value` JSON naming the email). Other verification rows (passkey challenges) are
 * skipped before their value is read, since theirs is not JSON.
 *
 * With `upToToken`, only links stored no later than that token's own row count (ties
 * broken by identifier), so requests checked at the same moment are admitted in the
 * order they were stored, as if one after another, instead of each counting the
 * others and all being refused.
 */
export async function countSignInLinksSince(ex: Executor, email: string, since: Date, upToToken?: string): Promise<number> {
  const upTo = upToToken
    ? sql`and (created_at, identifier) <= (
        select v.created_at, v.identifier from verification v where v.identifier = ${`magic-link:${upToToken}`}
      )`
    : sql``;
  const [row] = await executeRows<{ n: unknown }>(
    ex,
    sql`
    select count(*) as n from verification
    where identifier like 'magic-link:%'
      and created_at >= ${since.toISOString()}::timestamptz
      and lower(case when identifier like 'magic-link:%' then value::jsonb ->> 'email' end) = lower(${email})
      ${upTo}
  `,
  );
  return Number(row?.n ?? 0);
}

/**
 * Whether the link for `token` may be emailed to `email` now: it is among the first
 * {@link SIGN_IN_EMAILS_PER_ADDRESS} stored for the address in the last window, itself
 * included. A token whose row is already gone (used or discarded) is never sent.
 */
export async function mayEmailSignInLink(ex: Executor, email: string, token: string, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - SIGN_IN_LINK_MINUTES * 60_000);
  const position = await countSignInLinksSince(ex, email, since, token);
  return position >= 1 && position <= SIGN_IN_EMAILS_PER_ADDRESS;
}

/**
 * Deletes the link Better Auth just stored for `token` (its plugin keeps it as
 * `magic-link:<token>`, unhashed), for a link that will not be emailed.
 */
export async function discardSignInLink(ex: Executor, token: string): Promise<void> {
  await ex.delete(verification).where(eq(verification.identifier, `magic-link:${token}`));
}
