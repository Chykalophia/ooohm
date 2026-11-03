/**
 * The WebAuthn relying party for passkeys: the domain a passkey is bound to (`rpID`) and
 * the origin sign-ins must come from.
 *
 * A passkey only works on its `rpID` and that domain's subdomains. By default that is the
 * app's own host (`BETTER_AUTH_URL`). Set `PASSKEY_RP_ID` to a parent domain when the app
 * will move between subdomains of it (from a temporary address to the final one, say), so
 * passkeys made before the move keep working after it.
 *
 * @throws Error when `rpId` is set but is not the app's host or a parent domain of it:
 *   browsers would refuse every passkey, so fail at start instead.
 */
export function passkeyRelyingParty(baseUrl: string, rpId?: string): { rpID: string; origin: string } {
  const url = new URL(baseUrl);
  const host = url.hostname.toLowerCase();
  const wanted = rpId?.trim().toLowerCase().replace(/\.$/, "");
  if (wanted && host !== wanted && !host.endsWith(`.${wanted}`)) {
    throw new Error(`PASSKEY_RP_ID "${wanted}" must be ${host} or a parent domain of it.`);
  }
  return { rpID: wanted || host, origin: url.origin };
}
