/**
 * Renders film.html into site/media/tour.mp4 (and tour.jpg, the poster), frame by frame,
 * so the result is the same on any machine. Run record.mjs first: the film plays its clips.
 *
 *   node site/demo/render-film.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const { chromium } = createRequire(import.meta.url)("playwright");
const here = dirname(fileURLToPath(import.meta.url));
const MEDIA = join(here, "..", "media");
const FRAMES = join(here, ".frames", "film");
const FPS = 30;

rmSync(FRAMES, { recursive: true, force: true });
const counts = {};
for (const clip of ["ask", "approve", "calendar", "team"]) {
  const dir = join(FRAMES, clip);
  mkdirSync(dir, { recursive: true });
  execFileSync("ffmpeg", ["-loglevel", "error", "-i", join(MEDIA, `${clip}.mp4`), "-vf", `fps=${FPS},scale=1400:-2`, "-q:v", "3", join(dir, "%05d.jpg")]);
  counts[clip] = readdirSync(dir).length;
}

const out = join(FRAMES, "out");
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto(pathToFileURL(join(here, "film.html")).href);
await page.evaluate(async (c) => { window.CLIP_COUNTS = c; await document.fonts.ready; }, counts);
const duration = await page.evaluate(() => window.DURATION);
const total = Math.round(duration * FPS);
for (let f = 0; f < total; f++) {
  await page.evaluate((t) => window.seek(t), f / FPS);
  await page.screenshot({ path: join(out, `${String(f).padStart(5, "0")}.jpg`), type: "jpeg", quality: 92 });
  if (f % 150 === 0) console.log(`frame ${f}/${total}`);
}
await browser.close();

execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", join(out, "%05d.jpg"),
  "-c:v", "libx264", "-preset", "slow", "-crf", "23", "-tune", "animation", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(MEDIA, "tour.mp4")]);
// The poster is the first chapter, with the app on screen.
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", join(out, `${String(Math.round(11.5 * FPS)).padStart(5, "0")}.jpg`), "-vf", "scale=1600:-2", "-q:v", "3", join(MEDIA, "tour.jpg")]);
rmSync(FRAMES, { recursive: true, force: true });
console.log(`tour: ${total} frames → ${join(MEDIA, "tour.mp4")}`);
