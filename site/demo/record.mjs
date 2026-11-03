/**
 * Records the marketing site's demo clips from the real app.
 *
 * Each clip drives a signed-in browser through one flow, captures the page with
 * Chrome's screencast at 2x, and encodes an H.264 MP4 plus a poster frame into
 * site/media/. A drawn cursor stands in for the pointer, which headless Chrome
 * doesn't paint. Needs the app running on DEMO_URL with demo data (see README.md).
 *
 *   node site/demo/record.mjs [clip ...]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE, signedInContext } from "./login.mjs";

const { chromium } = createRequire(import.meta.url)("playwright");
const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", "media");
const TMP = join(here, ".frames");
const FPS = 30;

const CURSOR = `
  addEventListener("DOMContentLoaded", () => {
    const c = document.createElement("div");
    c.id = "demo-cursor";
    c.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2l15 8.2-6.6 1.6L8.3 18z" fill="#1c1917" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    Object.assign(c.style, { position: "fixed", left: "0", top: "0", zIndex: 2147483647, pointerEvents: "none",
      transform: "translate(var(--x, -40px), var(--y, -40px))", transition: "scale .12s", transformOrigin: "3px 2px" });
    document.body.append(c);
    const pos = sessionStorage.getItem("demo-cursor");
    if (pos) { const [x, y] = JSON.parse(pos); c.style.setProperty("--x", x + "px"); c.style.setProperty("--y", y + "px"); }
    addEventListener("mousemove", (e) => { c.style.setProperty("--x", e.clientX + "px"); c.style.setProperty("--y", e.clientY + "px");
      sessionStorage.setItem("demo-cursor", JSON.stringify([e.clientX, e.clientY])); }, true);
    addEventListener("mousedown", () => (c.style.scale = "0.82"), true);
    addEventListener("mouseup", () => (c.style.scale = "1"), true);
  });
`;

// Native menus and date pickers never reach a screencast, so the clips draw their own: a list
// for a <select> and a month for a date input, styled like the app, under the field they open
// from. A clear shield covers the page while one is open, so the real control never opens.
const PICKERS = `
  (() => {
    const css = \`
      #demo-shield { position: fixed; inset: 0; z-index: 2147483000; }
      .demo-pop { position: fixed; z-index: 2147483001; background: #fff; border: 1px solid #e7e5e4; border-radius: 12px;
        box-shadow: 0 1px 2px rgba(28,25,23,.06), 0 16px 40px -12px rgba(28,25,23,.22); padding: 6px; font: 500 15px/1.2 "Instrument Sans", ui-sans-serif, system-ui, sans-serif;
        color: #1c1917; opacity: 0; transform: translateY(-4px) scale(.98); transform-origin: top left; transition: opacity .14s ease-out, transform .14s ease-out; }
      .demo-pop.in { opacity: 1; transform: none; }
      .demo-opt { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-radius: 8px; white-space: nowrap; }
      .demo-opt.cur { color: #0f766e; }
      .demo-opt.cur::after { content: ""; width: 9px; height: 5px; margin-left: auto; border-left: 2px solid currentColor; border-bottom: 2px solid currentColor; transform: translateY(-2px) rotate(-45deg); }
      .demo-opt:hover, .demo-day:hover { background: #e5f1ef; }
      .demo-opt.pick, .demo-day.pick { background: #0f766e !important; color: #fff !important; }
      .demo-cal { padding: 12px; }
      .demo-cal header { font-weight: 600; padding: 2px 4px 10px; }
      .demo-cal .g { display: grid; grid-template-columns: repeat(7, 36px); gap: 2px; }
      .demo-cal .wd { font-size: 12px; color: #78716c; text-align: center; padding-bottom: 4px; }
      .demo-day { height: 34px; display: grid; place-items: center; border-radius: 8px; font-variant-numeric: tabular-nums; }
      .demo-day.off { color: #a8a29e; }
      .demo-day.cur { box-shadow: inset 0 0 0 1.5px #0f766e; }
      .demo-day.span { background: #e5f1ef; }
    \`;
    let pop = null, shield = null;
    function place(el, anchor) {
      const r = anchor.getBoundingClientRect();
      document.body.append(el);
      const w = el.offsetWidth, h = el.offsetHeight;
      el.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + "px";
      el.style.top = (r.bottom + h + 8 < innerHeight ? r.bottom + 6 : r.top - h - 6) + "px";
      requestAnimationFrame(() => el.classList.add("in"));
    }
    function open(el, anchor) {
      close();
      if (!document.getElementById("demo-css")) { const st = document.createElement("style"); st.id = "demo-css"; st.textContent = css; document.head.append(st); }
      shield = document.createElement("div"); shield.id = "demo-shield"; document.body.append(shield);
      pop = el; place(el, anchor);
    }
    function close() { pop?.remove(); shield?.remove(); pop = shield = null; }
    window.__demoPick = {
      close,
      /** A list of the select's options under its chip. */
      select(sel) {
        const el = document.createElement("div"); el.className = "demo-pop";
        for (const o of sel.options) {
          const d = document.createElement("div");
          d.className = "demo-opt" + (o.value === sel.value ? " cur" : "");
          d.dataset.v = o.value; d.textContent = o.textContent; el.append(d);
        }
        el.style.minWidth = sel.closest("span").getBoundingClientRect().width + "px";
        open(el, sel.closest("span"));
      },
      /** The month around \`value\`, Monday first; \`from\` shades the range picked so far. */
      date(input, month, from) {
        const [y, m] = month.split("-").map(Number);
        const first = new Date(Date.UTC(y, m - 1, 1));
        const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
        const el = document.createElement("div"); el.className = "demo-pop demo-cal";
        const name = first.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
        el.innerHTML = "<header>" + name + "</header>";
        const g = document.createElement("div"); g.className = "g";
        for (const w of ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]) g.insertAdjacentHTML("beforeend", '<div class="wd">' + w + "</div>");
        for (let i = 0; i < (first.getUTCDay() + 6) % 7; i++) g.append(document.createElement("div"));
        for (let d = 1; d <= days; d++) {
          const iso = y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
          const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
          const c = document.createElement("div");
          c.className = "demo-day" + (dow === 0 || dow === 6 ? " off" : "") + (iso === input.value ? " cur" : "") + (from && iso === from ? " span" : "");
          c.dataset.v = iso; c.textContent = d; g.append(c);
        }
        el.append(g);
        open(el, input.closest("span"));
        if (from) g.addEventListener("mouseover", (e) => {
          const t = e.target.closest(".demo-day"); if (!t) return;
          for (const c of g.querySelectorAll(".demo-day")) c.classList.toggle("span", c.dataset.v >= from && c.dataset.v <= t.dataset.v);
        });
      },
    };
  })();
`;

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function director(page, start) {
  let at = start;
  const wait = (ms) => page.waitForTimeout(ms);
  async function moveTo(x, y, ms = 700) {
    const from = { ...at };
    const steps = Math.max(8, Math.round(ms / 16));
    for (let i = 1; i <= steps; i++) {
      const k = ease(i / steps);
      await page.mouse.move(from.x + (x - from.x) * k, from.y + (y - from.y) * k);
      await wait(ms / steps);
    }
    at = { x, y };
  }
  async function center(target) {
    const loc = typeof target === "string" ? page.locator(target).first() : target;
    await loc.scrollIntoViewIfNeeded();
    const b = await loc.boundingBox();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  }
  return {
    wait,
    moveTo,
    async hover(target, ms) { const p = await center(target); await moveTo(p.x, p.y, ms); },
    async click(target, ms) {
      const p = await center(target);
      await moveTo(p.x, p.y, ms);
      await wait(120);
      await page.mouse.down(); await wait(90); await page.mouse.up();
    },
    async drag(from, to, ms = 1100) {
      const a = await center(from), b = await center(to);
      await moveTo(a.x, a.y);
      await wait(150);
      await page.mouse.down();
      await moveTo(b.x, b.y, ms);
      await wait(120);
      await page.mouse.up();
    },
    /** Opens a drawn menu for a <select>, moves to `value` and picks it. */
    async choose(select, value) {
      // Press on the chip with the shield already down, so the real control never opens.
      await this.hover(select);
      await wait(120);
      await select.evaluate((el) => window.__demoPick.select(el));
      await page.mouse.down(); await wait(90); await page.mouse.up();
      await wait(420);
      const opt = page.locator(`.demo-pop [data-v="${value}"]`);
      await this.hover(opt, 650);
      await wait(260);
      await opt.evaluate((el) => el.classList.add("pick"));
      await page.mouse.down(); await wait(90); await page.mouse.up();
      await wait(160);
      await page.evaluate(() => window.__demoPick.close());
      await select.selectOption(value);
    },
    /** Opens a drawn month for a date input, moves to `iso` and picks it. */
    async pickDate(input, iso, from) {
      await this.hover(input);
      await wait(120);
      await input.evaluate((el, [m, f]) => window.__demoPick.date(el, m, f), [iso.slice(0, 7), from ?? null]);
      await page.mouse.down(); await wait(90); await page.mouse.up();
      await wait(420);
      const day = page.locator(`.demo-pop [data-v="${iso}"]`);
      await this.hover(day, 750);
      await wait(260);
      await day.evaluate((el) => el.classList.add("pick"));
      await page.mouse.down(); await wait(90); await page.mouse.up();
      await wait(160);
      await page.evaluate(() => window.__demoPick.close());
      await input.fill(iso);
    },
    async type(text, delay = 70) { await page.keyboard.type(text, { delay }); },
    async scrollBy(dy, ms = 900) {
      if (typeof dy !== "number") dy = (await dy.first().boundingBox()).y - 24;
      const steps = Math.round(ms / 16);
      let done = 0;
      for (let i = 1; i <= steps; i++) {
        const next = Math.round(dy * ease(i / steps));
        await page.mouse.wheel(0, next - done); done = next;
        await wait(ms / steps);
      }
    },
  };
}

/** The clips. `as` is who is signed in; `size` is the CSS viewport. */
const CLIPS = {
  // Lena asks for three days in one sentence and sees what she'll have left.
  ask: {
    as: "lena@example.com", size: { width: 860, height: 640 }, path: "/",
    async run(page, d) {
      await d.wait(700);
      const type = page.locator('select[aria-label="Type of leave"]');
      // Open the type menu and keep PTO, so the clip shows the choices without changing them.
      await d.choose(type, await type.inputValue());
      await d.wait(500);
      const from = page.locator('input[type="date"]').nth(0);
      const to = page.locator('input[type="date"]').nth(1);
      await d.pickDate(from, "2026-12-21");
      await d.wait(700);
      await d.pickDate(to, "2026-12-23", "2026-12-21");
      await d.wait(1600);
      await d.click(page.getByText("Add a note for your approver"));
      await d.wait(200);
      await page.getByLabel("Note for your approver").focus();
      await d.wait(300);
      await d.type("Visiting my parents in Busan", 55);
      await d.wait(700);
      await d.click(page.getByRole("button", { name: "Send request" }));
      await d.wait(1400);
      await d.scrollBy(page.getByText("Your latest requests"), 1400);
      await d.wait(1800);
    },
  },
  // Maya sees the overlap, approves, and the request settles.
  approve: {
    as: "maya@example.com", size: { width: 860, height: 640 }, path: "/approvals",
    async run(page, d) {
      await d.wait(900);
      const card = page.locator("article, li, section").filter({ hasText: "Lena Park" }).filter({ hasText: "Dec 21" }).filter({ has: page.getByRole("button", { name: "Approve" }) }).last();
      await d.hover(card.getByText(/off then too|Nobody else/).first(), 900);
      await d.wait(1300);
      await d.click(card.getByRole("button", { name: "Approve" }));
      await d.wait(1800);
      await d.click(page.getByRole("tab", { name: /Settled/ }).or(page.getByRole("link", { name: /Settled/ })).first());
      await d.wait(2200);
    },
  },
  // Maya drags across three days on her calendar; weekends and Thanksgiving don't count.
  calendar: {
    as: "maya@example.com", size: { width: 1040, height: 800 }, path: "/calendar?month=2026-11",
    async run(page, d) {
      await d.wait(800);
      // November 2026's grid starts on Monday, Oct 26: the 23rd is cell 28, the 27th cell 32.
      const cell = (i) => page.locator("tbody td").nth(i);
      await d.drag(cell(28), cell(32), 1500);
      await d.wait(900);
      await d.scrollBy(240, 900);
      await d.wait(1500);
      const send = page.getByRole("button", { name: "Request", exact: true });
      await d.click(send);
      await d.wait(1200);
      await d.scrollBy(-240, 900);
      await d.wait(1600);
    },
  },
  // Who's out this month, then just Design, then the year at a glance.
  team: {
    as: "maya@example.com", size: { width: 860, height: 640 }, path: "/team?month=2026-11",
    async run(page, d) {
      await d.wait(800);
      await d.scrollBy(420, 1500);
      await d.wait(500);
      await d.scrollBy(-420, 1000);
      await d.click(page.getByRole("link", { name: "Design", exact: true }).or(page.getByRole("button", { name: "Design", exact: true })).first());
      await d.wait(1500);
      await d.click(page.getByRole("link", { name: "Calendar" }).first());
      await d.wait(900);
      await d.click(page.getByRole("link", { name: "Year" }).or(page.getByRole("button", { name: "Year" })).first());
      await d.wait(1200);
      await d.scrollBy(380, 1300);
      await d.wait(1800);
    },
  },
};

async function record(name, clip, browser) {
  const ctx = await signedInContext(browser, clip.as, { viewport: clip.size, deviceScaleFactor: 2 });
  await ctx.addInitScript(CURSOR);
  await ctx.addInitScript(PICKERS);
  const page = await ctx.newPage();
  await page.goto(BASE + clip.path);
  await page.waitForLoadState("networkidle");
  // The cursor starts resting in the lower right, out of the way.
  const rest = { x: clip.size.width * 0.82, y: clip.size.height * 0.78 };
  await page.mouse.move(rest.x, rest.y);

  const dir = join(TMP, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const cdp = await ctx.newCDPSession(page);
  const frames = [];
  cdp.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
    const file = join(dir, `${String(frames.length).padStart(5, "0")}.jpg`);
    writeFileSync(file, Buffer.from(data, "base64"));
    frames.push({ file, t: metadata.timestamp });
    await cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  // Navigations inside a clip restart the screencast in Chrome; keep it running.
  const start = () => cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, everyNthFrame: 1 }).catch(() => {});
  page.on("framenavigated", (f) => f === page.mainFrame() && start());
  await start();
  await page.waitForTimeout(300);
  await clip.run(page, director(page, rest));
  const end = Date.now() / 1000;
  await cdp.send("Page.stopScreencast").catch(() => {});
  await ctx.close();
  if (frames.length === 0) throw new Error(`${name}: Chrome sent no screencast frames.`);

  // Hold each frame until the next one arrived, then resample to a constant frame rate.
  const list = frames.map((f, i) => `file '${f.file}'\nduration ${((frames[i + 1]?.t ?? end) - f.t).toFixed(4)}`).join("\n");
  writeFileSync(join(dir, "list.txt"), `${list}\nfile '${frames.at(-1).file}'\n`);
  const { width, height } = clip.size;
  const mp4 = join(OUT, `${name}.mp4`);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(dir, "list.txt"),
    "-vf", `fps=${FPS},scale=${width * 2}:${height * 2}:flags=lanczos,format=yuv420p`,
    "-c:v", "libx264", "-preset", "slow", "-crf", "24", "-tune", "animation", "-movflags", "+faststart", "-an", mp4]);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", frames[0].file, "-vf", `scale=${width * 2}:-2`, "-q:v", "4", join(OUT, `${name}.jpg`)]);
  rmSync(dir, { recursive: true, force: true });
  console.log(`${name}: ${frames.length} frames → ${mp4}`);
}

/** A still of Home in each company theme, for the theme picker. */
async function themeStills(browser) {
  const DB = process.env.DATABASE_URL ?? "postgres://ooohm:ooohm@127.0.0.1:5432/ooohm";
  const themes = ["classic", "cobalt", "marigold", "saffron", "graphite", "plum", "signal", "forest", "frost"];
  mkdirSync(join(OUT, "themes"), { recursive: true });
  const ctx = await signedInContext(browser, "maya@example.com", { viewport: { width: 840, height: 560 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  // Only the demo company (the one Maya belongs to) changes, and it gets its own theme back after.
  const psql = (sql, vars = {}) =>
    execFileSync("psql", [DB, "-qAt", "-v", "ON_ERROR_STOP=1", ...Object.entries(vars).flatMap(([k, v]) => ["-v", `${k}=${v}`])], { input: sql }).toString().trim();
  const company = psql(`select company_id from "user" where email = :'email';`, { email: "maya@example.com" });
  if (!company) throw new Error("maya@example.com has no company; run demo-data.mts first");
  const original = psql(`select theme from companies where id = :'company';`, { company });
  try {
    for (const theme of themes) {
      psql(`update companies set theme = :'theme' where id = :'company';`, { theme, company });
      await page.goto(`${BASE}/`);
      await page.waitForLoadState("networkidle");
      await page.screenshot({ path: join(TMP, "theme.png") });
      execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", join(TMP, "theme.png"), "-vf", "scale=1260:-2", "-q:v", "5", join(OUT, "themes", `${theme}.jpg`)]);
    }
  } finally {
    try {
      psql(`update companies set theme = :'theme' where id = :'company';`, { theme: original, company });
    } finally {
      await ctx.close();
    }
  }
  console.log("themes: done");
}

mkdirSync(OUT, { recursive: true });
mkdirSync(TMP, { recursive: true });
const wanted = process.argv.slice(2);
const browser = await chromium.launch();
for (const [name, clip] of Object.entries(CLIPS)) {
  if (wanted.length && !wanted.includes(name)) continue;
  await record(name, clip, browser);
}
if (!wanted.length || wanted.includes("themes")) await themeStills(browser);
await browser.close();
