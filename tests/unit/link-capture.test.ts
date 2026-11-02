import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { magicLink } from "better-auth/plugins";
import { createLinkCapture, inviteLinkRequest } from "@/lib/link-capture";

const URL_A = "https://ooohm.test/api/auth/magic-link/verify?token=a";

describe("link capture", () => {
  test("a key registered by issue is intercepted and its URL handed back", async () => {
    const capture = createLinkCapture();
    let intercepted: boolean | undefined;
    const url = await capture.issue(async (key) => {
      intercepted = capture.intercept({ linkCapture: key }, URL_A);
    });
    assert.equal(intercepted, true);
    assert.equal(url, URL_A);
  });

  test("unknown, non-string or missing keys are not intercepted (the normal send path runs)", async () => {
    const capture = createLinkCapture();
    await capture.issue(async (key) => {
      assert.equal(capture.intercept({ linkCapture: `${key}x` }, URL_A), false);
      assert.equal(capture.intercept({ linkCapture: 42 }, URL_A), false);
      assert.equal(capture.intercept({}, URL_A), false);
      assert.equal(capture.intercept(undefined, URL_A), false);
      assert.equal(capture.intercept("linkCapture", URL_A), false);
      capture.intercept({ linkCapture: key }, URL_A);
    });
  });

  test("the key is forgotten once issue resolves or throws", async () => {
    const capture = createLinkCapture();
    let seen = "";
    await capture.issue(async (key) => {
      seen = key;
      capture.intercept({ linkCapture: key }, URL_A);
    });
    assert.equal(capture.intercept({ linkCapture: seen }, URL_A), false, "a resolved key is gone");

    await assert.rejects(
      capture.issue(async (key) => {
        seen = key;
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.equal(capture.intercept({ linkCapture: seen }, URL_A), false, "a thrown key is gone");
  });

  test("issue throws sign_in_link_not_issued when nothing was intercepted", async () => {
    const capture = createLinkCapture();
    await assert.rejects(
      capture.issue(async () => undefined),
      /sign_in_link_not_issued/,
    );
  });

  test("keys are fresh per call, so one capture never answers another", async () => {
    const capture = createLinkCapture();
    const keys: string[] = [];
    await capture.issue(async (key) => {
      keys.push(key);
      capture.intercept({ linkCapture: key }, URL_A);
    });
    await capture.issue(async (key) => {
      keys.push(key);
      capture.intercept({ linkCapture: key }, URL_A);
    });
    assert.notEqual(keys[0], keys[1]);
    assert.ok(keys[0].length >= 43, "256 random bits, base64url");
  });
});

describe("link capture with Better Auth's real magic-link endpoint", () => {
  function setup() {
    const capture = createLinkCapture();
    const mailed: string[] = [];
    const auth = betterAuth({
      baseURL: "https://ooohm.test",
      secret: "unit-test-placeholder-not-a-real-secret-00",
      database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
      logger: { disabled: true },
      plugins: [
        magicLink({
          disableSignUp: true,
          sendMagicLink: async ({ url, metadata }) => {
            if (capture.intercept(metadata, url)) return;
            mailed.push(url);
          },
        }),
      ],
    });
    return { auth, capture, mailed };
  }

  test("an invite link is captured (never mailed), returns to / and fails over to /sign-in", async () => {
    const { auth, capture, mailed } = setup();
    const link = await capture.issue((key) =>
      auth.api.signInMagicLink({ body: inviteLinkRequest("ana@example.com", key), headers: new Headers() }),
    );
    const url = new URL(link);
    assert.equal(url.pathname, "/api/auth/magic-link/verify");
    assert.ok(url.searchParams.get("token"));
    assert.equal(url.searchParams.get("callbackURL"), "/");
    assert.equal(url.searchParams.get("errorCallbackURL"), "/sign-in");
    assert.ok(link.includes("errorCallbackURL=%2Fsign-in"));
    assert.deepEqual(mailed, [], "a captured link is not also sent");
  });

  test("an outside request with a guessed key goes down the normal send path", async () => {
    const { auth, mailed } = setup();
    await auth.api.signInMagicLink({
      body: { email: "ana@example.com", callbackURL: "/", metadata: { linkCapture: "guess" } },
      headers: new Headers(),
    });
    assert.equal(mailed.length, 1);
  });
});
