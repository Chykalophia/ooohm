import type { EmailCopy } from "@/domain/email-template";
import type { EmailAccent } from "@/lib/email-layout";
import type { EmailContent } from "./templates/content";
import type { CopyTemplate, CopyVariable } from "./templates/copy";

export type { EmailContent } from "./templates/content";

/** What a notification type may use to build its email, at send time (after commit). */
export interface BuildEnv {
  /** The recipient's address, for a type that issues something for them (a sign-in link). */
  to: string;
  /** The company's accent, read once for every email of one change. */
  accent: EmailAccent;
  /** Issues a one-time sign-in link for an existing account. May throw. */
  issueSignInLink: (email: string) => Promise<string>;
  /** The company's own words for this type (Admin → Emails), if it saved any. */
  copy?: EmailCopy | null;
}

/** How a type appears in the email editor, and the words an admin can change. */
export interface EditableCopy<D> {
  /** The email's name in the editor: "Time off request". */
  label: string;
  /** Who gets it and when: "To the approver, when someone asks for time off." */
  description: string;
  defaults: CopyTemplate;
  /** The variables its subject and message may use. */
  variables: readonly CopyVariable[];
  /** Made-up data the editor's preview renders. */
  sample: D;
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
  copy: EditableCopy<D>;
  /** The email. Runs after commit, so it may do I/O (`env.issueSignInLink`); it may throw. */
  build: (data: D, env: BuildEnv) => EmailContent | Promise<EmailContent>;
}

/** Declares a notification type, checking it against {@link NotificationType} while keeping its data type. */
export function notificationType<D>(type: NotificationType<D>): NotificationType<D> {
  return type;
}
