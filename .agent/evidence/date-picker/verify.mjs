// Throwaway browser checks for the date picker (AC4–AC7). Not committed to the repo.
import { chromium } from "playwright-core";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";

const BASE = "http://localhost:3123";
const OUT = process.argv[2];
const AXE = process.argv[3];
mkdirSync(OUT, { recursive: true });
const lines = [];
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  const line = `${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`;
  lines.push(line);
  console.log(line);
};

const mail = readFileSync(new URL("./mail.log", import.meta.url), "utf8").replace(/=\r?\n/g, "").replace(/=3D/g, "=");
const tokens = [...mail.matchAll(/magic-link\/verify\?token=([A-Za-z0-9_-]+)/g)];
const token = tokens.at(-1)[1];

const browser = await chromium.launch({
  executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-linux64/chrome-headless-shell`,
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: "UTC", storageState: "/tmp/dp-verify/state.json" });
const session = await (await ctx.request.get(`${BASE}/api/auth/get-session`)).json();
check("signed in as the seed admin", session?.user?.email === "admin@example.com", session?.user?.email);

const page = await ctx.newPage();
// Setup: the admin turns on the sentence through Admin → Appearance (the real action).
await page.goto(BASE + "/admin/appearance");
await page.locator('input[name="requestStyle"][value="sentence"]').check();
await page.locator('input[name="requestStyle"][value="sentence"]').evaluate((el) => el.form.requestSubmit());
await page.waitForTimeout(2000);
await page.goto(BASE + "/");
const startTrigger = page.locator('button[aria-haspopup="dialog"]').first();
const endTrigger = page.locator('button[aria-haspopup="dialog"]').nth(1);
const dialog = page.getByRole("dialog");
const startField = page.locator('input[name="startDate"]');
const endField = page.locator('input[name="endDate"]');
const focusedDate = () => page.evaluate(() => document.activeElement?.getAttribute("data-date"));
const today = await page.evaluate(() => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
});
const plusDays = (iso, n) => new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8) + n)).toISOString().slice(0, 10);

// ---- AC4 ----
check("AC3/R2 no native date input in the sentence", (await page.locator('form input[type="date"]').count()) === 0);
const startBefore = await startField.inputValue();
check("R1 startDate field is required, named startDate", await startField.evaluate((el) => el.required));
const triggerName = await startTrigger.getAttribute("aria-label");
check("R2 trigger name is label + long date", /^First day, \w+day, \w+ \d+, \d{4}$/.test(triggerName), triggerName);
check("R2 aria-expanded=false when closed", (await startTrigger.getAttribute("aria-expanded")) === "false");
await startTrigger.click();
await dialog.waitFor();
const dialogName = await dialog.getAttribute("aria-label");
check("AC4(a) dialog's accessible name contains 'first day'", /first day/i.test(dialogName), dialogName);
check("R9 aria-modal=true", (await dialog.getAttribute("aria-modal")) === "true");
check("R2 aria-expanded=true when open", (await startTrigger.getAttribute("aria-expanded")) === "true");
const expectFocus = startBefore || today;
check(
  "AC4(a)/R6 focus on the selected day (today when empty)",
  (await focusedDate()) === expectFocus,
  `value=${startBefore || "(empty)"} today=${today} focused=${await focusedDate()}`,
);
check("R7 roving tabindex: exactly one cell with tabIndex=0", (await dialog.locator('[role="gridcell"][tabindex="0"]').count()) === 1);
check("R4 grid has 42 day cells", (await dialog.locator('[role="gridcell"]').count()) === 42);
const todayCellName = await dialog.locator(`[data-date="${today}"]`).getAttribute("aria-label");
check("R5 today's cell name includes 'today'", /today$/.test(todayCellName ?? ""), todayCellName);
const cellW = await dialog.locator('[role="gridcell"]').first().boundingBox();
check("R12 day cells >= 40x40 at full width", cellW.width >= 40 && cellW.height >= 40, `${cellW.width.toFixed(1)}x${cellW.height.toFixed(1)}`);
const dlgBox = await dialog.boundingBox();
check("R12 popup at most 20rem (320px) wide on desktop", dlgBox.width <= 320.5, `${dlgBox.width}px`);

// R8: Tab cycles typed field -> previous -> next -> grid -> Today -> typed field.
const names = [];
for (let i = 0; i < 5; i++) {
  await page.keyboard.press("Tab");
  names.push(await page.evaluate(() => document.activeElement?.getAttribute("aria-label") || document.activeElement?.id || document.activeElement?.textContent?.trim()));
}
// Starting on the grid: Today, typed field, previous, next, back to the grid.
const cycleOk = /^Today/.test(names[0]) && /typed/.test(names[1]) && /Previous month/.test(names[2]) && /Next month/.test(names[3]) && /^\w+day, /.test(names[4]);
check("R8 Tab cycles typed field, previous, next, grid, Today", cycleOk, names.join(" | "));
// Back to the focused day to continue with keyboard checks.
await dialog.locator('[role="gridcell"][tabindex="0"]').focus();

// R7: keyboard moves inside the grid.
const at = await focusedDate();
await page.keyboard.press("PageDown");
const pd = await focusedDate();
await page.keyboard.press("PageUp");
check("R7 PageDown/PageUp move a month and back", pd !== at && (await focusedDate()) === at, `${at} -> ${pd} -> ${await focusedDate()}`);
await page.keyboard.press("ArrowDown");
check("R7 ArrowDown = +7 days", (await focusedDate()) === plusDays(at, 7));
await page.keyboard.press("ArrowUp");
await page.keyboard.press("Escape");
await dialog.waitFor({ state: "detached" });
check("AC4(e) Escape closes without changing the value", (await startField.inputValue()) === startBefore);
check("R8 Escape returns focus to the trigger", await startTrigger.evaluate((el) => el === document.activeElement));

// AC4(b): open, Right Right Enter.
await startTrigger.press("Enter");
await dialog.waitFor();
const from = await focusedDate();
await page.keyboard.press("ArrowRight");
await page.keyboard.press("ArrowRight");
await page.keyboard.press("Enter");
await dialog.waitFor({ state: "detached" });
const picked = plusDays(from, 2);
check("AC4(b) Right Right Enter closes the dialog", (await dialog.count()) === 0);
check("AC4(b) focus back on the trigger", await startTrigger.evaluate((el) => el === document.activeElement));
const shown = (await startTrigger.textContent()).trim();
check("AC4(b) startDate value is two days after the opening day", (await startField.inputValue()) === picked, `${from} -> ${await startField.inputValue()}, token "${shown}"`);
const expectedShort = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(new Date(picked + "T00:00:00Z"));
check("AC4(b) token shows that date", shown === expectedShort, `"${shown}" vs "${expectedShort}"`);
check("R10 end date pushed to the new start", (await endField.inputValue()) >= picked, await endField.inputValue());

// AC4(d): end date, cells before start disabled; click leaves value unchanged.
const endBefore = await endField.inputValue();
await endTrigger.click();
await dialog.waitFor();
const before = plusDays(picked, -1);
const disabledCell = dialog.locator(`[data-date="${before}"]`);
check("AC4(d) day before the start date is aria-disabled", (await disabledCell.getAttribute("aria-disabled")) === "true", before);
const allBefore = await dialog.locator('[role="gridcell"]').evaluateAll(
  (cells, min) => cells.filter((c) => c.dataset.date < min).every((c) => c.getAttribute("aria-disabled") === "true"),
  picked,
);
check("AC4(d) every visible cell before the start is aria-disabled", allBefore);
await disabledCell.click({ force: true });
check("AC4(d) clicking a disabled day keeps the popup open and the value", (await dialog.count()) === 1 && (await endField.inputValue()) === endBefore);
// AC4(f): pointer-down outside.
await page.mouse.click(5, 5);
await dialog.waitFor({ state: "detached" });
check("AC4(f) pointer-down outside closes without changing the value", (await endField.inputValue()) === endBefore);

// R3: typed entry.
await startTrigger.click();
await dialog.waitFor();
const typed = dialog.getByLabel("First day");
await typed.fill("11/09/2026");
check("R3 invalid typed text sets aria-invalid and keeps the value", (await typed.getAttribute("aria-invalid")) === "true" && (await startField.inputValue()) === picked);
const typedTarget = plusDays(picked, 35);
await typed.fill(typedTarget);
check("R3 a valid typed date updates the value and the grid's month", (await startField.inputValue()) === typedTarget && (await dialog.locator(`[data-date="${typedTarget}"]`).count()) === 1);
await page.keyboard.press("Escape");
await dialog.waitFor({ state: "detached" });

// AC4(c): put the start back to the picked date and submit; read the posted form.
await startTrigger.click();
await dialog.waitFor();
await dialog.getByLabel("First day").fill(picked);
await page.keyboard.press("Escape");
await dialog.waitFor({ state: "detached" });
const posted = new Promise((resolve) => {
  page.on("request", (req) => {
    if (req.method() === "POST" && (req.postData() ?? "").includes("startDate")) resolve(req.postData());
  });
});
await page.locator('form button[type="submit"]').first().click();
const body = await Promise.race([posted, new Promise((r) => setTimeout(() => r(""), 8000))]);
const m = /name="(?:_?\d+_)?startDate"\r?\n\r?\n([^\r\n]*)/.exec(body);
check("AC4(c) the form submits startDate=<picked>", m?.[1] === picked, `posted startDate=${m?.[1]}`);
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/after-submit.png` });

// ---- AC5 / AC7: theme matrix ----
const MATRIX = [
  ...["classic", "cobalt", "marigold", "saffron", "graphite", "plum", "signal", "forest", "frost"].map((t) => ({ id: t, attrs: { "data-ui": t, "data-mode": "light" } })),
  { id: "classic-dark", attrs: { "data-ui": "classic", "data-mode": "dark" } },
  { id: "classic-auto-os-dark", attrs: { "data-ui": "classic", "data-mode": "system" }, scheme: "dark" },
  { id: "custom-accent", attrs: { "data-ui": "classic", "data-mode": "light" }, style: { "--accent": "#7c3aed", "--accent-foreground": "#ffffff", "--accent-ink": "#6d28d9" } },
  { id: "corners-square", attrs: { "data-ui": "classic", "data-mode": "light", "data-corners": "square" } },
];
const axeSource = readFileSync(AXE, "utf8");
await page.goto(BASE + "/");
for (const entry of MATRIX) {
  await page.emulateMedia({ colorScheme: entry.scheme ?? "light" });
  await page.evaluate(({ attrs, style }) => {
    const html = document.documentElement;
    for (const a of ["data-ui", "data-mode", "data-corners"]) html.removeAttribute(a);
    for (const p of ["--accent", "--accent-foreground", "--accent-ink"]) html.style.removeProperty(p);
    for (const [k, v] of Object.entries(attrs)) html.setAttribute(k, v);
    for (const [k, v] of Object.entries(style ?? {})) html.style.setProperty(k, v);
  }, entry);
  await page.locator('button[aria-haspopup="dialog"]').first().click();
  await dialog.waitFor();
  await page.mouse.move(1, 1);
  await page.waitForTimeout(200);
  await dialog.screenshot({ path: `${OUT}/theme-${entry.id}.png` });
  const r = await page.evaluate(() => {
    const probe = (cls) => {
      const el = document.createElement("div");
      el.className = cls;
      document.body.appendChild(el);
      const cs = getComputedStyle(el);
      const out = { bg: cs.backgroundColor, color: cs.color, border: cs.borderTopColor, radius: cs.borderTopLeftRadius };
      el.remove();
      return out;
    };
    const tokenBgs = ["bg-surface", "bg-accent", "bg-accent/10", "bg-accent-ink", "bg-accent-foreground", "bg-transparent"].map((c) => probe(c).bg);
    const tokenText = ["text-foreground", "text-muted", "text-accent-ink", "text-accent-foreground", "text-danger"].map((c) => probe(c).color);
    const tokenBorder = ["border-border", "border-field", "border-accent-ink", "border-danger"].map((c) => probe(`border ${c}`).border);
    const allowedColor = new Set([...tokenText, ...tokenBgs, ...tokenBorder]);
    const allowedBg = new Set([...tokenBgs, "rgba(0, 0, 0, 0)"]);
    const dlg = document.querySelector('[role="dialog"]');
    const off = [];
    for (const el of [dlg, ...dlg.querySelectorAll("*")]) {
      if (el.closest("svg") && el.tagName !== "svg") continue;
      const cs = getComputedStyle(el);
      if (!allowedColor.has(cs.color)) off.push(`${el.tagName}.${el.getAttribute("data-date") ?? ""} color ${cs.color}`);
      if (!allowedBg.has(cs.backgroundColor)) off.push(`${el.tagName}.${el.getAttribute("data-date") ?? ""} bg ${cs.backgroundColor}`);
    }
    const sel = dlg.querySelector('[aria-selected="true"]');
    return {
      dialogBg: getComputedStyle(dlg).backgroundColor,
      surface: probe("bg-surface").bg,
      selectedBg: sel ? getComputedStyle(sel).backgroundColor : null,
      accent: probe("bg-accent").bg,
      dialogRadius: getComputedStyle(dlg).borderTopLeftRadius,
      tokenRadius: probe("rounded-2xl").radius,
      off,
    };
  });
  check(`AC5 ${entry.id}: popup background = surface token`, r.dialogBg === r.surface, r.dialogBg);
  check(`AC5 ${entry.id}: selected day = accent token`, r.selectedBg === r.accent, r.selectedBg);
  check(`AC5 ${entry.id}: corners follow the theme radius`, r.dialogRadius === r.tokenRadius, r.dialogRadius);
  check(`AC5 ${entry.id}: no colour outside the theme tokens`, r.off.length === 0, r.off.slice(0, 4).join("; "));
  if (["classic", "classic-dark"].includes(entry.id)) {
    await page.evaluate(axeSource);
    const res = await page.evaluate(async () => {
      const out = await window.axe.run(document.querySelector('[role="dialog"]'));
      return out.violations.map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length }));
    });
    const bad = res.filter((v) => v.impact === "serious" || v.impact === "critical");
    check(`AC7 ${entry.id}: axe 0 serious/critical in the dialog`, bad.length === 0, JSON.stringify(res));
  }
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
}

// ---- AC6: 320px ----
await page.emulateMedia({ colorScheme: "light" });
await page.setViewportSize({ width: 320, height: 640 });
await page.goto(BASE + "/");
const baseline = await page.evaluate(() => ({
  scroll: document.documentElement.scrollWidth,
  culprit: [...document.querySelectorAll("form *")].filter((e) => e.getBoundingClientRect().right > 320.5).map((e) => e.textContent.trim().slice(0, 40))[0] ?? "",
}));
await page.locator('button[aria-haspopup="dialog"]').first().click();
await dialog.waitFor();
await page.waitForTimeout(200);
const fit = await page.evaluate(() => ({
  scroll: document.documentElement.scrollWidth,
  cells: [...document.querySelectorAll('[role="gridcell"]')].map((c) => c.getBoundingClientRect()).map((b) => Math.min(b.width, b.height)),
  dlg: document.querySelector('[role="dialog"]').getBoundingClientRect().toJSON(),
  card: document.querySelector('[role="dialog"]').closest('section').getBoundingClientRect().toJSON(),
}));
check("AC6 320px: scrollWidth <= 320 with the popup open", fit.scroll <= 320, `closed=${baseline.scroll} open=${fit.scroll} culprit="${baseline.culprit}"`);
check("AC6 320px: phone panel is the sentence card's box", Math.abs(fit.dlg.left - fit.card.left) < 1 && Math.abs(fit.dlg.width - fit.card.width) < 1, `dlg=${fit.dlg.left}/${fit.dlg.width} card=${fit.card.left}/${fit.card.width}`);
check("AC6 320px: every day cell >= 36x36", Math.min(...fit.cells) >= 36, `smallest=${Math.min(...fit.cells).toFixed(1)}px`);
check("AC6 320px: popup inside the viewport", fit.dlg.left >= 0 && fit.dlg.right <= 320, `left=${fit.dlg.left.toFixed(1)} right=${fit.dlg.right.toFixed(1)}`);
await page.screenshot({ path: `${OUT}/phone-320.png`, fullPage: false });

await browser.close();
lines.push("", `${failures === 0 ? "ALL PASS" : `${failures} FAILED`} (${lines.length} checks)`);
writeFileSync(`${OUT}/checks.txt`, lines.join("\n") + "\n");
process.exit(failures ? 1 : 0);
