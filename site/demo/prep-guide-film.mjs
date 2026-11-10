/**
 * Gets the guide film (social-guide.html) ready to render: captures the guide page it scrolls
 * through, then lays sound effects over the music where the film's window.HITS says:
 * a whoosh on each scene change, a tick on each card, a pop on each number and a soft ding on the
 * end card. Every effect is synthesised here with ffmpeg, so nothing else needs a license.
 * Writes a WAV to pass to render-launch.mjs as --music.
 *
 *   node site/demo/prep-guide-film.mjs --music Wallpaper.mp3 --out mix.wav
 *   node site/demo/render-launch.mjs --music mix.wav --film social-guide.html --out ooohm-linkedin-guide.mp4
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const { chromium } = createRequire(import.meta.url)("playwright");
const here = dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({ options: { music: { type: "string" }, out: { type: "string" } } });
if (!args.music || !args.out) throw new Error("Pass --music and --out.");
const FILM = "social-guide.html";
const ASSETS = join(here, ".frames", "guide-assets");

const browser = await chromium.launch();
let hits, duration;
try {
  // The guide page the film scrolls through, at a width where its text reads on a phone.
  mkdirSync(ASSETS, { recursive: true });
  const guide = await browser.newPage({ viewport: { width: 900, height: 1000 }, deviceScaleFactor: 1.5, colorScheme: "light" });
  await guide.goto(pathToFileURL(join(here, "..", "docs", "asking-for-time-off.html")).href);
  // The guide lazy-loads its images; load them all before the full-page capture.
  await guide.evaluate(async () => {
    for (const i of document.images) i.loading = "eager";
    await Promise.all([...document.images].map((i) => i.decode().catch(() => {})));
    await document.fonts.ready;
  });
  await guide.screenshot({ path: join(ASSETS, "asking-for-time-off.jpg"), fullPage: true, type: "jpeg", quality: 90 });

  const page = await browser.newPage();
  await page.goto(pathToFileURL(join(here, FILM)).href);
  ({ hits, duration } = await page.evaluate(() => ({ hits: window.HITS, duration: window.DURATION })));
} finally {
  await browser.close();
}

if (!hits || !Number.isFinite(duration)) throw new Error(`${FILM} must set window.HITS and window.DURATION.`);
const tmp = join(here, ".frames", "sfx");
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
const ff = (...a) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...a]);
const SR = "48000";
// Whoosh: pink noise swept through a band-pass, swelling in and dying away.
ff("-f", "lavfi", "-i", `anoisesrc=color=pink:sample_rate=${SR}:duration=0.55:amplitude=0.9`,
  "-af", "highpass=f=300,lowpass=f=5000,afade=t=in:d=0.3:curve=exp,afade=t=out:st=0.3:d=0.25,volume=0.55", join(tmp, "whoosh.wav"));
// Tick: a short, bright click.
ff("-f", "lavfi", "-i", `sine=frequency=2400:sample_rate=${SR}:duration=0.05`, "-af", "afade=t=out:d=0.05:curve=exp,volume=0.35", join(tmp, "tick.wav"));
// Pop: a quick downward pitch drop.
ff("-f", "lavfi", "-i", `aevalsrc=0.6*sin(2*PI*(900*t-3500*t*t))*exp(-t*28):s=${SR}:d=0.14`, join(tmp, "pop.wav"));
// Ding: two soft bell partials.
ff("-f", "lavfi", "-i", `aevalsrc=0.32*(sin(2*PI*1318*t)+0.5*sin(2*PI*1976*t))*exp(-t*4.5):s=${SR}:d=1.2`, join(tmp, "ding.wav"));

const inputs = ["-i", resolve(args.music)];
const parts = [];
let n = 1;
for (const [kind, times] of Object.entries(hits)) {
  for (const at of times) {
    // A whoosh peaks as the cut lands, so it starts a little before.
    const start = Math.max(0, kind === "whoosh" ? at - 0.3 : at);
    inputs.push("-i", join(tmp, `${kind}.wav`));
    parts.push(`[${n}:a]adelay=${Math.round(start * 1000)}:all=1[s${n}]`);
    n++;
  }
}
// The music sits a little under the effects; render-launch.mjs levels the whole mix after.
const labels = Array.from({ length: n - 1 }, (_, i) => `[s${i + 1}]`).join("");
const graph = `[0:a]atrim=0:${duration + 1},asetpts=N/SR/TB,aresample=${SR},volume=0.8[m];${parts.join(";")};[m]${labels}amix=inputs=${n}:normalize=0:duration=first[a]`;
ff(...inputs, "-filter_complex", graph, "-map", "[a]", "-ac", "2", resolve(args.out));
rmSync(tmp, { recursive: true, force: true });
console.log(`${FILM}: ${n - 1} effects over the music → ${args.out}`);
