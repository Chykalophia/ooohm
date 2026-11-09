/**
 * Renders every email OOOhm sends, with each type's made-up sample (the same one the
 * Admin → Emails preview uses) and OOOhm's own wording, for the product docs. Writes one
 * HTML file per email plus `emails.json` (subject, plain text, who gets it) into the folder
 * given. Sends nothing and reads no database. `docs-screens.mjs` runs it and screenshots
 * the files.
 *
 *   pnpm exec tsx --conditions=react-server site/demo/docs-emails.mts <out dir>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_EMAIL_ACCENT } from "../../src/lib/email-layout";
import { renderSignInEmail } from "../../src/lib/sign-in-email";
import { NOTIFICATION_TYPES, type NotificationKind } from "../../src/server/notifications/catalog";
import { previewNotification } from "../../src/server/notifications/preview";

const out = process.argv[2];
if (!out) throw new Error("Usage: docs-emails.mts <out dir>");
mkdirSync(out, { recursive: true });

const list: { id: string; label: string; description: string; subject: string; text: string }[] = [];
for (const kind of Object.keys(NOTIFICATION_TYPES) as NotificationKind[]) {
  const { label, description } = NOTIFICATION_TYPES[kind].copy;
  const email = await previewNotification(kind, null, DEFAULT_EMAIL_ACCENT);
  const id = kind.replace(/[^a-z]+/g, "-");
  writeFileSync(join(out, `${id}.html`), email.html ?? "");
  list.push({ id, label, description, subject: email.subject, text: email.text });
}
// The sign-in link someone asks for on the sign-in page: not editable, so not in the catalog.
const signIn = renderSignInEmail("https://ooohm.example/api/auth/magic-link/verify?token=preview", DEFAULT_EMAIL_ACCENT);
writeFileSync(join(out, "sign-in.html"), signIn.html);
list.push({ id: "sign-in", label: "Sign-in link", description: "To anyone who asks for a sign-in link on the sign-in page.", subject: signIn.subject, text: signIn.text });

writeFileSync(join(out, "emails.json"), JSON.stringify(list, null, 2));
console.log(`${list.length} emails → ${out}`);
