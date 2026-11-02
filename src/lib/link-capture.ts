import { randomBytes } from "node:crypto";

/**
 * Hands a magic link produced by Better Auth back to server code instead of emailing
 * it, so an invite can carry the link in its own message.
 *
 * `issue` registers a fresh random key (256 bits, held only in this process) for the
 * duration of one request; the request passes it through Better Auth's `metadata`, and
 * `sendMagicLink` calls `intercept` first. The public endpoint lets anyone set
 * `metadata`, but a caller can never guess a live key, so an outside request always
 * falls through to the normal (anti-enumeration) sending path.
 */
export interface LinkCapture {
  /**
   * Runs `request` with a fresh key and returns the link intercepted under it. The key
   * is forgotten when `request` settles, whether it resolved or threw.
   *
   * @throws Error `sign_in_link_not_issued` when nothing was intercepted (for example
   *   if Better Auth stopped calling `sendMagicLink` before answering), or whatever
   *   `request` threw.
   */
  issue(request: (key: string) => Promise<unknown>): Promise<string>;
  /**
   * For `sendMagicLink`: when `metadata.linkCapture` is a live key, hands `url` to its
   * `issue` call and returns true (the caller must then send nothing). Otherwise false.
   */
  intercept(metadata: unknown, url: string): boolean;
}

export function createLinkCapture(newKey: () => string = () => randomBytes(32).toString("base64url")): LinkCapture {
  const pending = new Map<string, (url: string) => void>();
  return {
    async issue(request) {
      const key = newKey();
      let issued: string | undefined;
      pending.set(key, (url) => {
        issued = url;
      });
      try {
        await request(key);
      } finally {
        pending.delete(key);
      }
      if (!issued) throw new Error("sign_in_link_not_issued");
      return issued;
    },
    intercept(metadata, url) {
      const key = metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>).linkCapture : undefined;
      const capture = typeof key === "string" ? pending.get(key) : undefined;
      if (!capture) return false;
      capture(url);
      return true;
    },
  };
}

/**
 * The body of the magic-link request behind an invite. A link that fails (expired,
 * already used) lands on `/sign-in`, which explains it and offers a new one, exactly
 * like links requested from the sign-in page.
 */
export function inviteLinkRequest(email: string, key: string) {
  return { email, callbackURL: "/", errorCallbackURL: "/sign-in", metadata: { linkCapture: key } };
}
