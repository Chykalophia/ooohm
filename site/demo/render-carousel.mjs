/**
 * Prints social-carousel.html to a PDF for a LinkedIn document post, plus one PNG per slide.
 *
 *   node site/demo/render-carousel.mjs [--out ooohm-carousel.pdf] [--url ooohm.team]
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const { chromium } = createRequire(import.meta.url)("playwright");
const here = dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({ options: { out: { type: "string" }, url: { type: "string" } } });
// Defaults to the gitignored .frames folder, so a plain run never lands in the deployed site.
const outFile = resolve(args.out ?? join(here, ".frames", "carousel.pdf"));
if (!/\.pdf$/i.test(outFile)) throw new Error("--out must name a .pdf file.");
const pngDir = outFile.replace(/\.pdf$/i, "");
mkdirSync(dirname(outFile), { recursive: true });

const browser = await chromium.launch();
let count;
try {
  const page = await browser.newPage({ viewport: { width: 1080, height: 1350 } });
  await page.goto(pathToFileURL(join(here, "social-carousel.html")).href + (args.url ? `?url=${encodeURIComponent(args.url)}` : ""));
  await page.evaluate(async () => { await document.fonts.ready; await window.ready; });
  await page.pdf({ path: outFile, width: "1080px", height: "1350px", printBackground: true, preferCSSPageSize: true });
  mkdirSync(pngDir, { recursive: true });
  const slides = await page.$$(".slide");
  for (const [i, slide] of slides.entries()) await slide.screenshot({ path: join(pngDir, `${String(i + 1).padStart(2, "0")}.png`) });
  count = slides.length;
} finally {
  await browser.close();
}
console.log(`carousel: ${count} slides → ${outFile} and ${pngDir}/`);
