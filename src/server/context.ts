import type { Database } from "@/db/types";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Sends one email. May throw; callers that must not fail wrap it (see `notify`). */
export type Mailer = (message: MailMessage) => Promise<void>;

/**
 * The infrastructure a service call runs against, injected so services stay free of
 * Next.js and of the app's environment. The app builds one per request in
 * `@/server/runtime`; integration tests build their own against a throwaway database.
 */
export interface ServiceContext {
  db: Database;
  mailer: Mailer;
  /**
   * Schedules work to run after the current transaction has committed and, in the
   * app, after the response is sent (`after()` from `next/server`). Tasks must not
   * throw.
   */
  defer: (task: () => Promise<void>) => void;
  /** Public base URL for links in emails, without a trailing slash. */
  appUrl: string;
  /** Current instant; injectable so tests can pin `decided_at`. */
  now: () => Date;
}
