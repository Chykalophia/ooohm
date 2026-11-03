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
      await d.click('select[aria-label="Type of leave"]');
      await d.wait(250);
      await page.keyboard.press("Escape");
      await d.wait(500);
      const from = page.locator('input[type="date"]').nth(0);
      const to = page.locator('input[type="date"]').nth(1);
      // Native date pickers don't show in a screencast: click for the gesture, then set the date.
      await d.click(from); await d.wait(250);
      await page.keyboard.press("Escape");
      await from.fill("2026-12-21");
      await d.wait(700);
      await d.click(to); await d.wait(250);
      await page.keyboard.press("Escape");
      await to.fill("2026-12-23");
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
    as: "maya@example.com", size: { width: 1040, height: 800 }, path: "/calendar",
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
    as: "maya@example.com", size: { width: 860, height: 640 }, path: "/team",
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
  for (const theme of themes) {
    // A psql variable, quoted by psql, rather than text pasted into the SQL.
    execFileSync("psql", [DB, "-q", "-v", `theme=${theme}`], { input: "update companies set theme = :'theme';" });
    await page.goto(`${BASE}/`);
    await page.waitForLoadState("networkidle");
    await page.screenshot({ path: join(TMP, "theme.png") });
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", join(TMP, "theme.png"), "-vf", "scale=1260:-2", "-q:v", "5", join(OUT, "themes", `${theme}.jpg`)]);
  }
  execFileSync("psql", [DB, "-qc", "update companies set theme = 'classic'"]);
  await ctx.close();
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
