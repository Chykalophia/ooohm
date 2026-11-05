/**
 * Renders launch.html, the one-minute launch film, or one of the social cuts (social-*.html),
 * frame by frame, then adds the music and writes the captions as .srt and .vtt next to the video.
 * Run record.mjs first: the films play its clips.
 *
 *   node site/demo/render-launch.mjs --music Wallpaper.mp3 [--film social-aha.html] [--out launch.mp4] [--url ooohm.team]
 *
 * A film sets its own size (window.SIZE), clips (window.CLIPS) and poster time (window.POSTER).
 *
 * The music isn't kept in the repository. The film was cut to "Wallpaper" by Kevin MacLeod
 * (incompetech.com, CC BY 4.0, https://creativecommons.org/licenses/by/4.0/); credit it wherever
 * the video is posted.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const { chromium } = createRequire(import.meta.url)("playwright");
const here = dirname(fileURLToPath(import.meta.url));
const MEDIA = join(here, "..", "media");
const FPS = 30;

const { values: args } = parseArgs({ options: { music: { type: "string" }, film: { type: "string" }, out: { type: "string" }, url: { type: "string" } } });
if (!args.music) throw new Error("Pass --music <file>: the film is cut to Wallpaper by Kevin MacLeod.");
if (!existsSync(args.music)) throw new Error(`No music file at ${args.music}.`);
const outFile = resolve(args.out ?? join(MEDIA, "launch.mp4"));
if (!/\.mp4$/i.test(outFile)) throw new Error("--out must name an .mp4 file.");
const stem = outFile.replace(/\.mp4$/i, "");
const film = args.film ?? "launch.html";
const FRAMES = join(here, ".frames", film.replace(/\.html$/, ""));

rmSync(FRAMES, { recursive: true, force: true });
// If a step fails, the browser still closes; the frames stay for a look and the next run clears them.
const browser = await chromium.launch();
const out = join(FRAMES, "out");
let duration, captions, poster, total;
try {
  const filmUrl = pathToFileURL(join(here, film)).href + (args.url ? `?url=${encodeURIComponent(args.url)}` : "");
  const probe = await browser.newPage();
  await probe.goto(filmUrl);
  const meta = await probe.evaluate(() => ({ size: window.SIZE ?? { w: 1920, h: 1080 }, clips: window.CLIPS ?? ["ask", "approve", "calendar", "team"], poster: window.POSTER ?? 57 }));
  await probe.close();
  poster = meta.poster;
  const counts = {};
  for (const clip of meta.clips) {
    const dir = join(FRAMES, clip);
    mkdirSync(dir, { recursive: true });
    execFileSync("ffmpeg", ["-loglevel", "error", "-i", join(MEDIA, `${clip}.mp4`), "-vf", `fps=${FPS},scale=1400:-2`, "-q:v", "3", join(dir, "%05d.jpg")]);
    counts[clip] = readdirSync(dir).length;
  }

  mkdirSync(out, { recursive: true });
  const page = await browser.newPage({ viewport: { width: meta.size.w, height: meta.size.h } });
  await page.goto(filmUrl);
  await page.evaluate(async (c) => { window.CLIP_COUNTS = c; await document.fonts.ready; await window.ready; }, counts);
  ({ duration, captions } = await page.evaluate(() => ({ duration: window.DURATION, captions: window.CAPTIONS })));
  total = Math.round(duration * FPS);
  for (let f = 0; f < total; f++) {
    await page.evaluate((t) => window.seek(t), f / FPS);
    await page.screenshot({ path: join(out, `${String(f).padStart(5, "0")}.jpg`), type: "jpeg", quality: 92 });
    if (f % 300 === 0) console.log(`frame ${f}/${total}`);
  }
} finally {
  await browser.close();
}

// Music: the start of the track, faded out over the end card and levelled for social players.
const fadeAt = duration - 3.5;
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", join(out, "%05d.jpg"), "-i", resolve(args.music),
  "-filter_complex", `[1:a]atrim=0:${duration},asetpts=N/SR/TB,afade=t=in:d=0.4,afade=t=out:st=${fadeAt}:d=3.5,loudnorm=I=-16:TP=-1.5:LRA=11[a]`,
  "-map", "0:v", "-map", "[a]", "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-tune", "animation", "-pix_fmt", "yuv420p",
  "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-t", String(duration), "-movflags", "+faststart", outFile]);
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", join(out, `${String(Math.round(poster * FPS)).padStart(5, "0")}.jpg`), "-q:v", "2", `${stem}.jpg`]);

// Captions as files too, for players that take them separately.
const stamp = (s, sep) => {
  const ms = Math.round(s * 1000);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)}${sep}${p(ms % 1000, 3)}`;
};
writeFileSync(`${stem}.srt`, captions.map((c, i) => `${i + 1}\n${stamp(c.at, ",")} --> ${stamp(c.end, ",")}\n${c.text}\n`).join("\n"));
writeFileSync(`${stem}.vtt`, "WEBVTT\n\n" + captions.map((c) => `${stamp(c.at, ".")} --> ${stamp(c.end, ".")}\n${c.text}\n`).join("\n"));
rmSync(FRAMES, { recursive: true, force: true });
console.log(`${film}: ${total} frames → ${outFile}`);
