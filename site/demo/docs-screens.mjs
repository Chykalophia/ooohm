/**
 * Takes every screenshot in the product docs (docs/guide/ and the site's /docs pages) from
 * the real app, signed in as the demo people, in the light Classic theme. Each shot is a
 * WebP at 2x in site/docs/images/. Needs the app running on DEMO_URL with demo data, like
 * record.mjs (see site/README.md, "Re-recording the media"), and runs against a local
 * database only: it changes a few demo rows (a department limit, levels, a shutdown) to
 * show every setting in use, and puts the company's own settings back when it ends.
 *
 *   node --env-file=.env site/demo/docs-screens.mjs [shot-name ...]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE, signedInContext } from "./login.mjs";
import { isLocalDatabase } from "./local-db.mjs";

const { chromium } = createRequire(import.meta.url)("playwright");
const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..");
const OUT = join(here, "..", "docs", "images");
const TMP = join(here, ".docs-frames");
const DB = process.env.DATABASE_URL ?? "postgres://ooohm:ooohm@127.0.0.1:5432/ooohm";
if (!isLocalDatabase(DB)) throw new Error("docs-screens only runs against a local database.");

const DESKTOP = { width: 1000, height: 760 };
const PHONE = { width: 390, height: 844 };

const psql = (sql, vars = {}) =>
  execFileSync("psql", [DB, "-qAt", "-v", "ON_ERROR_STOP=1", ...Object.entries(vars).flatMap(([k, v]) => ["-v", `${k}=${v}`])], { input: sql })
    .toString()
    .trim();

/** Saves a PNG buffer as a WebP in site/docs/images. */
function save(name, png) {
  const tmp = join(TMP, `${name}.png`);
  writeFileSync(tmp, png);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", tmp, "-c:v", "libwebp", "-quality", "86", "-compression_level", "6", join(OUT, `${name}.webp`)]);
  rmSync(tmp);
  console.log(`${name}.webp`);
}

const company = psql(`select company_id from "user" where email = 'maya@example.com';`);
if (!company) throw new Error("maya@example.com has no company; run demo-data.mts first");
const idOf = (email) => psql(`select id from "user" where email = :'email';`, { email });
const dept = (name) => psql(`select id from departments where company_id = :'c' and name = :'n';`, { c: company, n: name });
/** The company settings the shots switch; a column name can't be a psql variable, so it's checked against these. */
const COMPANY_COLUMNS = new Set(["theme", "layout", "request_style", "approval_mode", "colleague_visibility"]);
function setCompany(column, value) {
  if (!COMPANY_COLUMNS.has(column)) throw new Error(`setCompany: ${column} isn't a setting the shots change`);
  psql(`update companies set ${column} = :'v' where id = :'c';`, { v: value, c: company });
}

/** Demo rows the docs need on top of demo-data.mts: every one is idempotent. */
function stage() {
  // The audit log starts empty each run (demo-data.mts writes rows without it), so its shot
  // shows only the decisions taken below, not those of earlier runs.
  psql(`delete from audit_log where company_id = :'c';`, { c: company });
  const tomas = idOf("tomas@example.com");
  psql(
    `update departments set max_off = 1 where id = :'design';
     update departments set manager_id = :'tomas' where id = :'eng';
     insert into levels (company_id, name) select :'c', n from (values ('Junior'), ('Senior')) v(n)
       where not exists (select 1 from levels where company_id = :'c' and name = v.n);
     insert into allowance_rules (company_id, leave_type_id, level_id, days)
       select :'c', t.id, l.id, 25 from leave_types t, levels l
       where t.company_id = :'c' and t.code = 'PTO' and l.company_id = :'c' and l.name = 'Senior'
         and not exists (select 1 from allowance_rules r where r.leave_type_id = t.id and r.level_id = l.id and r.department_id is null);
     insert into holidays (company_id, date, name)
       select :'c', d::date, 'End-of-year shutdown' from generate_series('2026-12-28'::date, '2026-12-31'::date, '1 day') d
       on conflict do nothing;`,
    { c: company, design: dept("Design"), eng: dept("Engineering"), tomas },
  );
}

/** A signed approve link for Maya and Lena's pending request, as the request email carries. */
function approvePath() {
  const request = psql(
    `select r.id from leave_requests r join "user" u on u.id = r.user_id where u.email = 'lena@example.com' and r.status = 'pending' order by r.start_date limit 1;`,
  );
  const script = `
    import { deriveLinkKey, signApproveToken } from "./src/lib/email-link-token";
    const key = deriveLinkKey(process.env.BETTER_AUTH_SECRET!);
    console.log(signApproveToken(key, { requestId: ${JSON.stringify(request)}, approverId: ${JSON.stringify(idOf("maya@example.com"))}, expiresAt: Math.floor(Date.now() / 1000) + 86400 }));`;
  const file = join(ROOT, ".docs-token.mts");
  writeFileSync(file, script);
  try {
    return `/approve/${execFileSync("pnpm", ["exec", "tsx", "--conditions=react-server", file], { cwd: ROOT }).toString().trim().split("\n").pop()}`;
  } finally {
    rmSync(file);
  }
}

// Home's dismissible notes come and go with the browser's storage; the shots that are
// about something else hide them, so every run frames the same screen.
const CALM = `main [role="note"] { display: none !important; }`;

async function open(page, path) {
  await page.goto(BASE + path);
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
}

async function full(page, name) {
  save(name, await page.screenshot({ fullPage: true }));
}

/** One element, with a little room around it. */
async function part(page, locator, name, pad = 16) {
  const loc = typeof locator === "string" ? page.locator(locator).first() : locator.first();
  await loc.scrollIntoViewIfNeeded();
  const box = await loc.boundingBox();
  if (!box) throw new Error(`${name}: the element to capture isn't on screen`);
  // The box is in viewport coordinates; a full-page clip takes page coordinates.
  const scroll = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
  const b = { ...box, x: box.x + scroll.x, y: box.y + scroll.y };
  const width = page.viewportSize().width;
  const clip = { x: Math.max(0, b.x - pad), y: Math.max(0, b.y - pad), width: Math.min(width, b.width + pad * 2), height: b.height + pad * 2 };
  save(name, await page.screenshot({ clip, fullPage: true }));
}

/**
 * Every shot: who is signed in, the viewport, and what to do. `calm` hides Home's notes.
 * Names are the image files the docs use; keep them in step with docs/guide.
 */
const SHOTS = {
  "sign-in": { as: null, async run(p) { await open(p, "/sign-in"); await full(p, "sign-in"); } },
  account: { as: "lena", async run(p) { await open(p, "/account"); await full(p, "account"); } },

  home: { as: "lena", async run(p) { await open(p, "/"); await full(p, "home"); } },
  "home-phone": { as: "lena", size: PHONE, calm: true, async run(p) { await open(p, "/"); save("home-phone", await p.screenshot()); } },
  "request-sentence": {
    as: "lena", calm: true,
    async run(p) {
      await open(p, "/");
      await part(p, "#request", "request-sentence");
      await p.getByRole("button", { name: /^First day/ }).click();
      await p.waitForTimeout(300);
      save("request-date-picker", await p.screenshot({ clip: { x: 0, y: 0, width: DESKTOP.width, height: 700 } }));
      await p.keyboard.press("Escape");
      // Type the dates into the picker's own field, as someone with a keyboard would.
      for (const [label, iso] of [["First day", "2026-12-14"], ["Last day", "2026-12-16"]]) {
        await p.getByRole("button", { name: new RegExp(`^${label}`) }).click();
        await p.waitForTimeout(200);
        const typed = p.locator('input[id$="-typed"]').first();
        // A valid typed date is picked as it's typed; Escape closes the picker (Enter would send the form).
        await typed.fill(iso);
        await p.waitForTimeout(250);
        await p.keyboard.press("Escape");
      }
      await p.waitForTimeout(900);
      await part(p, "#request", "request-sentence-range");
    },
  },
  "request-form": {
    as: "lena", calm: true, company: { request_style: "form" },
    async run(p) { await open(p, "/"); await part(p, "#request", "request-form"); },
  },
  "request-heads-up": {
    as: "lena", calm: true, company: { request_style: "form", approval_mode: "heads_up" },
    async run(p) { await open(p, "/"); await part(p, "#request", "request-heads-up"); },
  },
  hints: {
    as: "lena",
    async run(p) {
      await open(p, "/");
      await part(p, p.locator('main [role="note"]'), "home-hint");
    },
  },
  balance: {
    as: "lena", calm: true,
    async run(p) { await open(p, "/"); await part(p, p.locator("section").filter({ has: p.getByRole("heading", { name: /Your balance/ }) }), "balance"); },
  },
  requests: { as: "lena", async run(p) { await open(p, "/requests"); await full(p, "requests"); } },
  "request-detail": {
    as: "lena",
    async run(p) {
      const id = psql(`select r.id from leave_requests r join "user" u on u.id = r.user_id where u.email = 'lena@example.com' and r.status = 'pending' order by r.start_date limit 1;`);
      await open(p, `/requests/${id}`);
      await full(p, "request-detail");
    },
  },

  calendar: { as: "maya", async run(p) { await open(p, "/calendar?month=2026-11&show=everyone"); await full(p, "calendar-month"); } },
  "calendar-drag": {
    as: "lena",
    async run(p) {
      await open(p, "/calendar?month=2026-12");
      // December 2026's grid starts on Monday, Nov 30: the 14th is cell 14, the 16th cell 16.
      const cell = (i) => p.locator("tbody td").nth(i);
      const a = await cell(14).boundingBox();
      const b = await cell(16).boundingBox();
      await p.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
      await p.mouse.down();
      await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
      await p.mouse.up();
      await p.waitForTimeout(900);
      await full(p, "calendar-select");
    },
  },
  "calendar-year": { as: "maya", async run(p) { await open(p, "/calendar?view=year&year=2026"); await full(p, "calendar-year"); } },
  "calendar-shutdown": { as: "maya", async run(p) { await open(p, "/calendar?month=2026-12&show=everyone"); await full(p, "calendar-shutdown"); } },
  "calendar-phone": { as: "maya", size: PHONE, async run(p) { await open(p, "/calendar?month=2026-11&show=everyone"); await full(p, "calendar-phone"); } },
  subscriptions: { as: "lena", async run(p) { await open(p, "/calendar/subscriptions"); await full(p, "calendar-subscriptions"); } },

  team: { as: "maya", async run(p) { await open(p, "/team?month=2026-11"); await full(p, "team"); } },
  person: { as: "maya", async run(p) { await open(p, `/team/${idOf("lena@example.com")}`); await full(p, "team-person"); } },

  approvals: { as: "maya", async run(p) { await open(p, "/approvals"); await full(p, "approvals"); } },
  "approvals-settled": {
    as: "maya",
    async run(p) {
      // Decide two requests through the inbox, so Settled (and the audit log) has something in it.
      await open(p, "/approvals");
      for (const [who, button, reason] of [
        ["Eli Brooks", "Approve", "Enjoy the long weekend!"],
        ["Jonas Berg", "Decline", "It's year-end close that week. Could you move it by a week?"],
      ]) {
        const card = p.locator("li, article").filter({ hasText: who }).filter({ has: p.getByRole("button", { name: button }) }).last();
        if (!(await card.count())) continue;
        await card.getByLabel(/Reason/).fill(reason);
        await card.getByRole("button", { name: button, exact: true }).click();
        await p.waitForLoadState("networkidle");
        await p.waitForTimeout(800);
      }
      await open(p, "/approvals?view=settled");
      await full(p, "approvals-settled");
    },
  },
  "approve-link": { as: "maya", async run(p) { await open(p, approvePath()); await full(p, "approve-from-email"); } },

  reports: { as: "maya", async run(p) { await open(p, "/reports"); await full(p, "reports"); } },

  people: { as: "maya", async run(p) { await open(p, "/admin/people"); await full(p, "admin-people"); } },
  "people-invite": { as: "maya", async run(p) { await open(p, "/admin/people/new"); await full(p, "admin-people-invite"); } },
  "people-edit": { as: "maya", async run(p) { await open(p, `/admin/people/${idOf("lena@example.com")}`); await full(p, "admin-person"); } },
  "people-allowances": {
    as: "maya",
    async run(p) { await open(p, `/admin/people/${idOf("lena@example.com")}/allowances?year=2026`); await full(p, "admin-person-allowances"); },
  },
  "people-import": {
    as: "maya",
    async run(p) {
      await open(p, "/admin/people/import");
      await full(p, "admin-import");
      await p.locator('input[type="file"]').setInputFiles({
        name: "people.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(
          "email,name,role,department,manager_email,can_self_approve\n" +
            "alex.rivera@example.com,Alex Rivera,employee,Engineering,sam.chen@example.com,no\n" +
            "sam.chen@example.com,Sam Chen,manager,Engineering,,no\n" +
            "jordan.lee@example.com,Jordan Lee,employee,Operations,sam.chen@example.com,\n" +
            "lena@example.com,Lena Park,employee,Design,maya@example.com,\n" +
            "casey.morgan,Casey Morgan,boss,,,maybe\n",
        ),
      });
      await p.getByRole("button", { name: "Check file" }).click();
      await p.waitForLoadState("networkidle");
      await p.waitForTimeout(600);
      await full(p, "admin-import-check");
      await p.locator('input[type="file"]').setInputFiles({
        name: "people.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(
          "email,name,role,department,manager_email,can_self_approve\n" +
            "alex.rivera@example.com,Alex Rivera,employee,Engineering,sam.chen@example.com,no\n" +
            "sam.chen@example.com,Sam Chen,manager,Engineering,,no\n" +
            "jordan.lee@example.com,Jordan Lee,employee,Operations,sam.chen@example.com,\n" +
            "lena@example.com,Lena Park,employee,Design,maya@example.com,\n",
        ),
      });
      await p.getByRole("button", { name: "Check file" }).click();
      await p.waitForLoadState("networkidle");
      await p.waitForTimeout(600);
      await full(p, "admin-import-ready");
    },
  },
  departments: { as: "maya", async run(p) { await open(p, "/admin/departments"); await full(p, "admin-departments"); } },
  "departments-limit": {
    as: "maya",
    async run(p) {
      await open(p, "/admin/departments");
      await p.getByRole("button", { name: /Change how many people of Design/ }).click();
      await p.waitForTimeout(300);
      await part(p, p.locator("li").filter({ hasText: "Design" }), "admin-department-limit");
    },
  },
  levels: { as: "maya", async run(p) { await open(p, "/admin/levels"); await full(p, "admin-levels"); } },
  "leave-types": { as: "maya", async run(p) { await open(p, "/admin/leave-types"); await full(p, "admin-leave-types"); } },
  "leave-type": {
    as: "maya",
    async run(p) {
      await open(p, `/admin/leave-types/${psql(`select id from leave_types where company_id = :'c' and code = 'PTO';`, { c: company })}`);
      await full(p, "admin-leave-type");
    },
  },
  holidays: { as: "maya", async run(p) { await open(p, "/admin/holidays?year=2026"); await full(p, "admin-holidays"); } },
  company: { as: "maya", async run(p) { await open(p, "/admin/company"); await full(p, "admin-company"); } },
  appearance: { as: "maya", async run(p) { await open(p, "/admin/appearance"); await full(p, "admin-appearance"); } },
  layouts: {
    as: "lena", calm: true,
    async run(p) {
      for (const layout of ["standard", "tonal", "grouped", "compact", "legible"]) {
        setCompany("layout", layout);
        await open(p, "/");
        save(`layout-${layout}`, await p.screenshot());
      }
    },
  },
  emails: { as: "maya", async run(p) { await open(p, "/admin/emails"); await full(p, "admin-emails"); } },
  "email-editor": { as: "maya", async run(p) { await open(p, "/admin/emails/leave.requested"); await full(p, "admin-email-editor"); } },
  audit: { as: "maya", async run(p) { await open(p, "/admin/audit"); await full(p, "admin-audit"); } },
  webhooks: { as: "maya", async run(p) { await open(p, "/admin/webhooks/new"); await full(p, "admin-webhook-new"); } },
  "api-keys": { as: "maya", async run(p) { await open(p, "/admin/api-keys"); await full(p, "admin-api-keys"); } },
  connectors: { as: "maya", async run(p) { await open(p, "/admin/integrations"); await full(p, "admin-connectors"); } },
};

/** Every email, rendered by docs-emails.mts, at a mail client's width. */
async function emailShots(browser, wanted) {
  if (wanted.length && !wanted.includes("emails-sent")) return;
  const dir = join(TMP, "emails");
  execFileSync("pnpm", ["exec", "tsx", "--conditions=react-server", join(here, "docs-emails.mts"), dir], { cwd: ROOT, stdio: "inherit" });
  const list = JSON.parse(readFileSync(join(dir, "emails.json"), "utf8"));
  const ctx = await browser.newContext({ viewport: { width: 640, height: 120 }, deviceScaleFactor: 2, colorScheme: "light" });
  const page = await ctx.newPage();
  for (const e of list) {
    await page.goto(`file://${join(dir, `${e.id}.html`)}`);
    await page.waitForTimeout(150);
    save(`email-${e.id}`, await page.screenshot({ fullPage: true }));
  }
  await ctx.close();
}

mkdirSync(OUT, { recursive: true });
mkdirSync(TMP, { recursive: true });
const wanted = process.argv.slice(2);
const original = psql(
  `select row_to_json(c) from (select request_style, approval_mode, layout, theme, colleague_visibility from companies where id = :'c') c;`,
  { c: company },
);
stage();
const browser = await chromium.launch();
try {
  for (const [name, shot] of Object.entries(SHOTS)) {
    if (wanted.length && !wanted.includes(name)) continue;
    setCompany("theme", "classic");
    for (const [column, value] of Object.entries(shot.company ?? {})) setCompany(column, value);
    const options = { viewport: shot.size ?? DESKTOP, deviceScaleFactor: 2, colorScheme: "light" };
    const ctx = shot.as ? await signedInContext(browser, `${shot.as}@example.com`, options) : await browser.newContext(options);
    if (shot.calm) await ctx.addInitScript((css) => addEventListener("DOMContentLoaded", () => { const s = document.createElement("style"); s.textContent = css; document.head.append(s); }), CALM);
    const page = await ctx.newPage();
    try {
      await shot.run(page);
    } finally {
      await ctx.close();
      const back = JSON.parse(original);
      for (const [column, value] of Object.entries(back)) setCompany(column, value);
    }
  }
  await emailShots(browser, wanted);
} finally {
  await browser.close();
  rmSync(TMP, { recursive: true, force: true });
}
