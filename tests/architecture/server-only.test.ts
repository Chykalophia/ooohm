import assert from "node:assert/strict";
import { test } from "node:test";
import { hasDirective, listFiles, read } from "./files";

/**
 * F5 (docs/architecture-plan/04-fitness-functions.md): every server file imports
 * `server-only`, so the build fails if client code ever pulls one in.
 *
 * Files under src/lib that client components import, and so cannot be server-only.
 * Each is checked by the client-boundary rules instead.
 */
const CLIENT_SAFE = new Set(["src/lib/auth-client.ts", "src/lib/color.ts", "src/lib/format.ts"]);

/**
 * Baseline: server files that do not import `server-only` yet. A1 empties it. A file
 * may leave the list (add the import, then delete its line) but never join it.
 */
export const MISSING_SERVER_ONLY = new Set<string>([
  "src/server/context.ts",
  "src/server/importers/timeoff/sqlite-reader.ts",
  "src/server/integrations/adapter.ts",
  "src/server/integrations/installed.ts",
  "src/server/notifications/accent.ts",
  "src/server/notifications/catalog.ts",
  "src/server/notifications/copy.ts",
  "src/server/notifications/preview.ts",
  "src/server/notifications/send.ts",
  "src/server/notifications/templates/content.ts",
  "src/server/notifications/templates/copy.ts",
  "src/server/notifications/templates/invite.ts",
  "src/server/notifications/templates/leave.ts",
  "src/server/notifications/types.ts",
  "src/server/repositories/adapter-deliveries.ts",
  "src/server/repositories/allowance-rules.ts",
  "src/server/repositories/api-keys.ts",
  "src/server/repositories/api-reads.ts",
  "src/server/repositories/audit-log.ts",
  "src/server/repositories/balances.ts",
  "src/server/repositories/calendar-feeds.ts",
  "src/server/repositories/calendar.ts",
  "src/server/repositories/change-log.ts",
  "src/server/repositories/companies.ts",
  "src/server/repositories/departments.ts",
  "src/server/repositories/email-templates.ts",
  "src/server/repositories/errors.ts",
  "src/server/repositories/health.ts",
  "src/server/repositories/holidays.ts",
  "src/server/repositories/imports.ts",
  "src/server/repositories/installation.ts",
  "src/server/repositories/keyset.ts",
  "src/server/repositories/leave-requests.ts",
  "src/server/repositories/leave-types.ts",
  "src/server/repositories/levels.ts",
  "src/server/repositories/outbox.ts",
  "src/server/repositories/passkeys.ts",
  "src/server/repositories/person-deletion.ts",
  "src/server/repositories/reports.ts",
  "src/server/repositories/retention.ts",
  "src/server/repositories/scheduled-jobs.ts",
  "src/server/repositories/users.ts",
  "src/server/repositories/webhooks.ts",
  "src/server/services/account.ts",
  "src/server/services/adapter-delivery.ts",
  "src/server/services/admin-access.ts",
  "src/server/services/admin-allowance-rules.ts",
  "src/server/services/admin-allowances.ts",
  "src/server/services/admin-company.ts",
  "src/server/services/admin-departments.ts",
  "src/server/services/admin-emails.ts",
  "src/server/services/admin-holidays.ts",
  "src/server/services/admin-leave-types.ts",
  "src/server/services/admin-levels.ts",
  "src/server/services/admin-people-deletion.ts",
  "src/server/services/admin-people-import.ts",
  "src/server/services/admin-people.ts",
  "src/server/services/allowance-changes.ts",
  "src/server/services/also-off.ts",
  "src/server/services/api-keys.ts",
  "src/server/services/api-v1.ts",
  "src/server/services/appearance.ts",
  "src/server/services/approval-routing.ts",
  "src/server/services/approvals.ts",
  "src/server/services/audit-log.ts",
  "src/server/services/background-tick.ts",
  "src/server/services/balances.ts",
  "src/server/services/calendar-feeds.ts",
  "src/server/services/calendar-scope.ts",
  "src/server/services/calendar.ts",
  "src/server/services/email-approval.ts",
  "src/server/services/health.ts",
  "src/server/services/inbound-sync.ts",
  "src/server/services/install.ts",
  "src/server/services/integrations.ts",
  "src/server/services/leave-changes.ts",
  "src/server/services/leave-on-behalf.ts",
  "src/server/services/leave-recount.ts",
  "src/server/services/leave-requests.ts",
  "src/server/services/notify.ts",
  "src/server/services/outbox-dispatch.ts",
  "src/server/services/reports.ts",
  "src/server/services/retention.ts",
  "src/server/services/rollover.ts",
  "src/server/services/scheduled-jobs.ts",
  "src/server/services/team-member.ts",
  "src/server/services/timeoff-import.ts",
  "src/server/services/webhook-delivery.ts",
  "src/server/services/webhooks.ts",
  "src/db/config.ts",
  "src/db/connect.ts",
  "src/db/embedded-lock.ts",
  "src/db/index.ts",
  "src/db/rows.ts",
  "src/db/schema.ts",
  "src/db/types.ts",
  "src/lib/appearance.ts",
  "src/lib/background-mode.ts",
  "src/lib/brand-mark.ts",
  "src/lib/client-address.ts",
  "src/lib/cron-auth.ts",
  "src/lib/dates.ts",
  "src/lib/email-layout.ts",
  "src/lib/email-link-token.ts",
  "src/lib/env.ts",
  "src/lib/feed-token.ts",
  "src/lib/fetch-site.ts",
  "src/lib/integration-crypto.ts",
  "src/lib/integration-env.ts",
  "src/lib/link-capture.ts",
  "src/lib/mail/names.ts",
  "src/lib/mail/registry.ts",
  "src/lib/mail/sendgrid.ts",
  "src/lib/mail/smtp-options.ts",
  "src/lib/mail/smtp.ts",
  "src/lib/mail/transport.ts",
  "src/lib/passkey-rp.ts",
  "src/lib/rate-limit.ts",
  "src/lib/safe-fetch.ts",
  "src/lib/setup-token.ts",
  "src/lib/sign-in-email.ts",
  "src/lib/token-hash.ts",
  "src/lib/worker-env.ts",
]);

function serverFiles(): string[] {
  return ["src/server", "src/db", "src/lib"]
    .flatMap((dir) => listFiles(dir, /\.tsx?$/))
    .filter((path) => !CLIENT_SAFE.has(path) && !path.endsWith(".d.ts"));
}

const importsServerOnly = (source: string) => /^import\s+["']server-only["'];?$/m.test(source);

test("every server file imports server-only, apart from the recorded baseline", () => {
  const missing = serverFiles().filter((path) => !importsServerOnly(read(path)) && !hasDirective(read(path), "use server"));
  const unexpected = missing.filter((path) => !MISSING_SERVER_ONLY.has(path));
  assert.deepEqual(unexpected, [], `Add import "server-only" to these new server files:\n${unexpected.join("\n")}`);
});

test("the server-only baseline only shrinks", () => {
  const files = new Set(serverFiles());
  const stale = [...MISSING_SERVER_ONLY].filter((path) => !files.has(path) || importsServerOnly(read(path)));
  assert.deepEqual(stale, [], `Remove these from MISSING_SERVER_ONLY; they are fixed or gone:\n${stale.join("\n")}`);
});
