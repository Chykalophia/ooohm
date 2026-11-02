/**
 * Result of an action that creates a secret shown exactly once (a webhook signing
 * secret, an API key). `value` lives only in this one response; OOOhm keeps no copy it
 * could show again.
 */
export type RevealState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | {
      status: "revealed";
      /** The secret. */
      value: string;
      message: string;
      /** Changes on every success, so the form's fields can reset. */
      id: string;
      /** Where to go next (e.g. the new endpoint's page), if anywhere. */
      href?: string;
    };

export const REVEAL_IDLE: RevealState = { status: "idle" };
