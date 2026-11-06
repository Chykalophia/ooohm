import type { EmailAccent } from "@/lib/email-layout";
import type { EmailContent } from "./templates/content";

export type { EmailContent } from "./templates/content";

/** What a notification type may use to build its email, at send time (after commit). */
export interface BuildEnv {
  /** The recipient's address, for a type that issues something for them (a sign-in link). */
  to: string;
  /** The company's accent, read once for every email of one change. */
  accent: EmailAccent;
  /** Issues a one-time sign-in link for an existing account. May throw. */
  issueSignInLink: (email: string) => Promise<string>;
}

/**
 * One kind of email the app sends: how to build it from its data, and what to log when
 * it cannot be sent. Services never build emails themselves; they hand a notification
 * (a type, a recipient and the data) to `commitThenNotify`, which looks the type up in
 * the catalog (`./catalog.ts`) and sends after commit.
 */
export interface NotificationType<D> {
  /** The log event of a failed build or send, e.g. `leave_email_failed`. */
  failureEvent: string;
  /** Logged with a failure, to find what it was about. Ids only: never an address or typed text. */
  logFields: (data: D) => Record<string, unknown>;
  /** The email. Runs after commit, so it may do I/O (`env.issueSignInLink`); it may throw. */
  build: (data: D, env: BuildEnv) => EmailContent | Promise<EmailContent>;
}

/** Declares a notification type, checking it against {@link NotificationType} while keeping its data type. */
export function notificationType<D>(type: NotificationType<D>): NotificationType<D> {
  return type;
}
