/**
 * End-to-end journeys on the built app (`pnpm build`, then `pnpm test:e2e`): the app runs
 * with `pnpm start:embedded` on a fresh embedded database, and Chromium drives it as
 * people would. Everyone signs in through the real magic-link flow: the sign-in page
 * sends the email, a local SMTP sink receives it (tests/e2e/support/mail-sink.ts), and
 * the browser opens the link. There is no test-only sign-in.
 *
 * The journeys run in order and build on each other: someone not yet invited gets no
 * sign-in email; the admin invites a manager and an employee; the employee asks for a day
 * off; the manager approves it and the employee's balance counts it as used; the
 * employee cancels it and the day is back.
 *
 * Playwright is loaded from the machine (`require("playwright")`, NODE_PATH in CI) with
 * Chromium already installed; nothing here records a trace.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, describe, test } from "node:test";
import { ADMIN_EMAIL, type RunningApp, startApp } from "./support/app";
import { MailSink } from "./support/mail-sink";

// The slice of Playwright's API the journeys use (its types are not a dependency of the repo).
interface Locator {
  click(): Promise<void>;
  fill(value: string): Promise<void>;
  selectOption(value: { value?: string; label?: string }): Promise<unknown>;
  waitFor(options?: { state?: "visible" | "hidden" | "detached"; timeout?: number }): Promise<void>;
  textContent(): Promise<string | null>;
  innerText(): Promise<string>;
  count(): Promise<number>;
  getByRole(role: string, options?: { name?: string | RegExp; exact?: boolean }): Locator;
  locator(selector: string, options?: { hasText?: string | RegExp }): Locator;
  filter(options: { hasText?: string | RegExp }): Locator;
  first(): Locator;
}
interface Page extends Pick<Locator, "getByRole" | "locator"> {
  goto(url: string): Promise<unknown>;
  getByLabel(text: string | RegExp, options?: { exact?: boolean }): Locator;
  waitForURL(test: (url: URL) => boolean, options?: { timeout?: number }): Promise<void>;
  url(): string;
  reload(): Promise<unknown>;
}
interface BrowserContext {
  newPage(): Promise<Page>;
  close(): Promise<void>;
}
interface Browser {
  newContext(): Promise<BrowserContext>;
  close(): Promise<void>;
}
const { chromium } = createRequire(import.meta.url)("playwright") as { chromium: { launch(options: { headless: boolean }): Promise<Browser> } };

const MANAGER = { email: "mona@e2e.example.com", name: "Mona Manager" };
const EMPLOYEE = { email: "eve@e2e.example.com", name: "Eve Employee" };

describe("journeys", { timeout: 300_000 }, () => {
  let app: RunningApp;
  let browser: Browser;
  const contexts: BrowserContext[] = [];

  before(async () => {
    app = await startApp();
    browser = await chromium.launch({ headless: true });
  });
  after(async () => {
    for (const c of contexts) await c.close().catch(() => {});
    await browser?.close();
    await app?.stop();
  });

  /** A browser signed in as `email` through the sign-in page and the emailed link. */
  async function signIn(email: string): Promise<Page> {
    const context = await browser.newContext();
    contexts.push(context);
    const page = await context.newPage();
    const since = app.mail.mails.length;
    await page.goto(`${app.url}/sign-in`);
    await page.getByLabel("Work email").fill(email);
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();
    await page.getByRole("heading", { name: "Check your email" }).waitFor();
    const mail = await app.mail.waitFor(email, { since, match: /magic-link\/verify/ });
    await page.goto(MailSink.link(mail, "/api/auth/magic-link/verify"));
    await page.waitForURL((u) => !u.pathname.startsWith("/sign-in") && !u.pathname.startsWith("/api/"));
    return page;
  }

  /** The text of the PTO card in "Your balance" on the dashboard. */
  async function ptoBalance(page: Page): Promise<string> {
    await page.goto(`${app.url}/`);
    const card = page.locator("li", { hasText: "PTO (Scheduled Time Off)" }).first();
    await card.waitFor();
    return (await card.innerText()).replace(/\s+/g, " ");
  }

  async function invite(admin: Page, person: { email: string; name: string }, role: string, manager?: string) {
    const since = app.mail.mails.length;
    await admin.goto(`${app.url}/admin/people/new`);
    await admin.getByLabel("Email", { exact: true }).fill(person.email);
    await admin.getByLabel("Name", { exact: true }).fill(person.name);
    await admin.getByRole("combobox", { name: /^Role/ }).selectOption({ value: role });
    if (manager) {
      const select = admin.getByRole("combobox", { name: /^Manager/ });
      const label = await select.locator("option", { hasText: manager }).textContent();
      await select.selectOption({ label: label ?? manager });
    }
    await admin.getByRole("button", { name: "Send invite" }).click();
    // The invite is the person's first email: a sign-in link to their new account.
    await app.mail.waitFor(person.email, { since, match: /magic-link\/verify/ });
  }

  let admin: Page;
  let employee: Page;
  let manager: Page;

  test("access is invite-only: someone nobody invited gets no sign-in email", async () => {
    const context = await browser.newContext();
    contexts.push(context);
    const page = await context.newPage();
    await page.goto(`${app.url}/sign-in`);
    await page.getByLabel("Work email").fill(EMPLOYEE.email);
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();
    // The page answers the same for everyone, so it can't be used to find who works here.
    await page.getByRole("heading", { name: "Check your email" }).waitFor();
    admin = await signIn(ADMIN_EMAIL);
    await new Promise((r) => setTimeout(r, 1_000));
    assert.deepEqual(app.mail.mails.filter((m) => m.to.includes(EMPLOYEE.email)), []);
  });

  test("an admin creates people: a manager, and an employee who reports to them", async () => {
    await invite(admin, MANAGER, "manager");
    await invite(admin, EMPLOYEE, "employee", MANAGER.name);
    await admin.goto(`${app.url}/admin/people`);
    for (const p of [MANAGER, EMPLOYEE]) await admin.getByRole("link", { name: p.name }).waitFor();
  });

  test("an employee requests leave, and it waits for their manager", async () => {
    employee = await signIn(EMPLOYEE.email);
    assert.match(await ptoBalance(employee), /15 days left/);
    const since = app.mail.mails.length;
    await employee.getByRole("button", { name: "Request time off" }).click();
    await employee.locator("li", { hasText: /pending/i }).first().waitFor();
    assert.match(await ptoBalance(employee), /14 days left.*1 pending/);
    // The manager is told, with an Approve link of their own.
    await app.mail.waitFor(MANAGER.email, { since, match: /\/approve\// });
  });

  test("the manager approves it from Approvals, and the employee's balance counts it as used", async () => {
    manager = await signIn(MANAGER.email);
    await manager.goto(`${app.url}/approvals`);
    const item = manager.getByRole("group", { name: new RegExp(EMPLOYEE.name.split(" ")[0]) }).first();
    await item.getByRole("button", { name: "Approve" }).click();
    await item.getByRole("status").filter({ hasText: /approved/i }).waitFor();
    const balance = await ptoBalance(employee);
    assert.match(balance, /14 days left.*1 used/);
    assert.doesNotMatch(balance, /pending/);
    await app.mail.waitFor(EMPLOYEE.email, { match: /approved/i });
  });

  test("the employee cancels the approved day, and it is back in their balance", async () => {
    await employee.goto(`${app.url}/requests`);
    await employee.getByRole("button", { name: /^Cancel request for / }).first().click();
    // The countdown to undo (UNDO_SECONDS, 20), then the cancel goes out.
    await employee.getByRole("button", { name: "Undo" }).waitFor();
    await employee.getByRole("button", { name: "Undo" }).waitFor({ state: "detached", timeout: 40_000 });
    await employee.locator("li", { hasText: /cancelled/i }).first().waitFor({ timeout: 15_000 });
    const balance = await ptoBalance(employee);
    assert.match(balance, /15 days left/);
    assert.doesNotMatch(balance, /used|pending/);
  });
});
