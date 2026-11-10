/**
 * Builds the site's /docs pages from the product guide in docs/guide/*.md, so the two
 * never drift: edit the Markdown, then run this and commit both. The site has no build
 * step, so the HTML it writes into site/docs/ is committed like the rest of the site.
 * Screenshots live once, in site/docs/images/ (docs-screens.mjs takes them); the Markdown
 * points at them there, so they show on GitHub too.
 *
 *   node site/demo/build-docs.mjs          # write site/docs/*.html
 *   node site/demo/build-docs.mjs --check  # fail if site/docs is out of date
 *
 * The Markdown is the small subset the guide uses: front matter (title, description),
 * headings, paragraphs, lists, tables, images, fenced code, **bold**, *italic*, `code`
 * and links. Anything else is a mistake in the guide, so it fails loudly.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..");
const GUIDE = join(ROOT, "docs", "guide");
const OUT = join(ROOT, "site", "docs");
const REPO = "https://github.com/Chykalophia/ooohm/blob/main/";
const SITE = "https://ooohm.team/docs/";

/** The sidebar, in reading order. Every guide page must be listed. */
const ORDER = [
  ["Overview", ["README"]],
  ["For everyone", ["getting-started", "asking-for-time-off", "calendar", "team"]],
  ["For managers", ["approvals", "reports"]],
  ["For admins", ["admin-people", "admin-organization", "admin-holidays", "admin-company", "admin-appearance", "emails", "admin-audit-integrations"]],
];

const slugOf = (name) => (name === "README" ? "index" : name);
const htmlFile = (name) => `${slugOf(name)}.html`;

const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** GitHub's heading anchors: lower case, punctuation dropped, spaces to hyphens. */
const anchor = (text) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s/g, "-");

/** Width and height of a WebP or JPEG, read from its header. */
function imageSize(file) {
  const b = readFileSync(file);
  if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    const chunk = b.toString("ascii", 12, 16);
    if (chunk === "VP8X") return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (chunk === "VP8L") {
      const bits = b.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i < b.length; ) {
      const marker = b[i + 1];
      const length = b.readUInt16BE(i + 2);
      if (length < 2) break;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      i += 2 + length;
    }
  }
  throw new Error(`Can't read the size of ${file}`);
}

/** Where a guide link or image points from site/docs/. */
function target(href, from) {
  if (/^(https?:|mailto:|#)/.test(href)) return href;
  const [path, hash = ""] = href.split("#");
  const frag = hash ? `#${hash}` : "";
  if (path.startsWith("../../site/docs/")) return path.slice("../../site/docs/".length) + frag;
  if (path.startsWith("../../site/")) return `../${path.slice("../../site/".length)}${frag}`;
  if (path.startsWith("../")) return `${REPO}docs/${path.slice(3)}${frag}`;
  if (path.endsWith(".md")) {
    const name = path.slice(0, -3);
    if (!existsSync(join(GUIDE, path))) throw new Error(`${from}: link to a missing page, ${href}`);
    return htmlFile(name) + frag;
  }
  throw new Error(`${from}: a link the docs can't follow, ${href}`);
}

function image(alt, src, from, attrs = "") {
  if (!src.startsWith("../../site/")) throw new Error(`${from}: images live under site/, not ${src}`);
  const file = join(ROOT, "site", src.slice("../../site/".length));
  if (!existsSync(file)) throw new Error(`${from}: missing image ${src}`);
  const { width, height } = imageSize(file);
  // Screenshots are taken at 2x: show them at their CSS size.
  const scale = src.includes("/docs/images/") ? 2 : 1;
  return `<img src="${escape(target(src, from))}" alt="${escape(alt)}" width="${Math.round(width / scale)}" height="${Math.round(height / scale)}" loading="lazy" decoding="async"${attrs}>`;
}

function inline(text, from) {
  const codes = [];
  let out = text.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(escape(c)) - 1}\u0000`);
  out = escape(out);
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => image(alt, src, from));
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
    const to = target(href.replace(/&amp;/g, "&"), from);
    const external = /^https?:/.test(to) && !to.startsWith(SITE);
    return `<a href="${escape(to)}"${external ? ' rel="noopener"' : ""}>${label}</a>`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}

const cells = (row) => row.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());

/** One guide page: its front matter, its HTML and its headings (for the page's contents). */
function render(name) {
  const from = `docs/guide/${name}.md`;
  const source = readFileSync(join(GUIDE, `${name}.md`), "utf8");
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(source);
  if (!fm) throw new Error(`${from}: front matter (title, description) is missing`);
  const meta = Object.fromEntries(fm[1].split("\n").map((l) => [l.slice(0, l.indexOf(":")).trim(), l.slice(l.indexOf(":") + 1).trim()]));
  const lines = source.slice(fm[0].length).split("\n");
  const html = [];
  const headings = [];
  const seen = new Map();
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }
    let m;
    if ((m = /^(#{1,4}) (.+)$/.exec(line))) {
      const level = m[1].length;
      const text = inline(m[2], from);
      let id = anchor(m[2].replace(/[`*]/g, ""));
      const n = seen.get(id) ?? 0;
      seen.set(id, n + 1);
      if (n) id = `${id}-${n}`;
      if (level === 2) headings.push({ id, text });
      html.push(level === 1 ? `<h1>${text}</h1>` : `<h${level} id="${id}"><a class="anchor" href="#${id}">${text}</a></h${level}>`);
      i++;
    } else if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const body = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) body.push(lines[i]);
      i++;
      html.push(`<pre class="code"${lang ? ` data-lang="${escape(lang)}"` : ""}><code>${escape(body.join("\n"))}</code></pre>`);
    } else if ((m = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(line))) {
      html.push(`<figure>${image(m[1], m[2], from)}<figcaption>${inline(m[1], from)}</figcaption></figure>`);
      i++;
    } else if (line.startsWith("|")) {
      const rows = [];
      for (; i < lines.length && lines[i].startsWith("|"); i++) rows.push(cells(lines[i]));
      const [head, , ...body] = rows;
      // A table of images with an empty header is a gallery.
      if (head.every((c) => c === "")) {
        const pics = body.flat().filter(Boolean).map((c) => {
          const p = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(c);
          if (!p) throw new Error(`${from}: a gallery cell must be one image`);
          return `<figure>${image(p[1], p[2], from)}<figcaption>${inline(p[1], from)}</figcaption></figure>`;
        });
        html.push(`<div class="gallery" style="--cols:${head.length}">${pics.join("")}</div>`);
      } else {
        html.push(
          `<div class="table"><table><thead><tr>${head.map((c) => `<th scope="col">${inline(c, from)}</th>`).join("")}</tr></thead><tbody>` +
            body.map((r) => `<tr>${r.map((c) => `<td>${inline(c, from)}</td>`).join("")}</tr>`).join("") +
            `</tbody></table></div>`,
        );
      }
    } else if (/^(- |\d+\. )/.test(line)) {
      const ordered = /^\d+\. /.test(line);
      const items = [];
      for (; i < lines.length && (/^(- |\d+\. )/.test(lines[i]) || /^ {2,}\S/.test(lines[i])); i++) {
        if (/^ {2,}\S/.test(lines[i])) items[items.length - 1] += ` ${lines[i].trim()}`;
        else items.push(lines[i].replace(/^(- |\d+\. )/, ""));
      }
      const tag = ordered ? "ol" : "ul";
      html.push(`<${tag}>${items.map((it) => `<li>${inline(it, from)}</li>`).join("")}</${tag}>`);
    } else if (line.startsWith("> ")) {
      const quote = [];
      for (; i < lines.length && lines[i].startsWith("> "); i++) quote.push(lines[i].slice(2));
      html.push(`<blockquote><p>${inline(quote.join(" "), from)}</p></blockquote>`);
    } else {
      const para = [];
      for (; i < lines.length && lines[i].trim() !== "" && !/^(#|```|\||- |\d+\. |!\[|> )/.test(lines[i]); i++) para.push(lines[i].trim());
      if (para.length === 0) throw new Error(`${from}:${i + 1}: Markdown the docs builder doesn't know: ${line}`);
      html.push(`<p>${inline(para.join(" "), from)}</p>`);
    }
  }
  return { name, title: meta.title, description: meta.description, html: html.join("\n"), headings };
}

const LOGO = `<svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7"/><g transform="translate(3.52 3.52) scale(0.78)"><path d="M7.5 24.5H12.6V21.2A7.5 7.5 0 1 1 19.4 21.2V24.5H24.5"/></g></svg>`;

function page(doc, pages, flat) {
  const at = flat.indexOf(doc.name);
  const prev = flat[at - 1] && pages.get(flat[at - 1]);
  const next = flat[at + 1] && pages.get(flat[at + 1]);
  const url = `${SITE}${doc.name === "README" ? "" : htmlFile(doc.name)}`;
  const title = doc.name === "README" ? "OOOhm guide" : `${doc.title} · OOOhm guide`;
  const sidebar = ORDER.map(
    ([group, names]) =>
      `<p class="side-group">${group}</p><ul>${names
        .map((n) => `<li><a href="${htmlFile(n)}"${n === doc.name ? ' aria-current="page"' : ""}>${escape(pages.get(n).title)}</a></li>`)
        .join("")}</ul>`,
  ).join("");
  const onThisPage =
    doc.headings.length > 1
      ? `<nav class="toc" aria-label="On this page"><p class="side-group">On this page</p><ul>${doc.headings.map((h) => `<li><a href="#${h.id}">${h.text.replace(/<a [^>]*>|<\/a>/g, "")}</a></li>`).join("")}</ul></nav>`
      : "";
  return `<!doctype html>
<!-- Built by site/demo/build-docs.mjs from docs/guide/${doc.name}.md. Edit the Markdown, not this file. -->
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escape(title)}</title>
  <meta name="description" content="${escape(doc.description)}">
  <meta name="theme-color" content="#fafaf9">
  <meta property="og:title" content="${escape(title)}">
  <meta property="og:description" content="${escape(doc.description)}">
  <meta property="og:image" content="https://ooohm.team/media/og.png">
  <meta property="og:url" content="${url}">
  <link rel="canonical" href="${url}">
  <link rel="icon" href="../favicon.svg" type="image/svg+xml">
  <link rel="preload" href="../fonts/instrument-sans.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="../styles.css">
  <link rel="stylesheet" href="docs.css">
</head>
<body class="docs">
  <a class="skip" href="#main">Skip to content</a>
  <header class="docs-nav">
    <div class="wrap docs-nav-row">
      <a class="logo" href="../" aria-label="OOOhm home">${LOGO}<span><b>OOO</b>hm</span></a>
      <a class="docs-home" href="index.html">Guide</a>
      <a class="btn btn-quiet nav-cta" href="https://github.com/Chykalophia/ooohm">GitHub</a>
    </div>
  </header>
  <div class="wrap docs-grid">
    <details class="side" data-side>
      <summary>Contents</summary>
      <nav aria-label="Guide">${sidebar}</nav>
    </details>
    <main id="main" class="prose">
${doc.html}
      <nav class="pager" aria-label="Next and previous">
        ${prev ? `<a class="prev" href="${htmlFile(prev.name)}"><span>Previous</span>${escape(prev.title)}</a>` : "<span></span>"}
        ${next ? `<a class="next" href="${htmlFile(next.name)}"><span>Next</span>${escape(next.title)}</a>` : ""}
      </nav>
      <p class="edit"><a href="${REPO}docs/guide/${doc.name}.md" rel="noopener">This page on GitHub</a></p>
    </main>
    ${onThisPage}
  </div>
  <footer class="footer">
    <div class="wrap footer-row">
      <a class="logo" href="../" aria-label="OOOhm home">${LOGO}<span><b>OOO</b>hm</span></a>
      <nav aria-label="Footer" class="footer-links">
        <a href="index.html">Guide</a>
        <a href="https://github.com/Chykalophia/ooohm">GitHub</a>
        <a href="${REPO}docs/hosting.md">Hosting</a>
        <a href="${REPO}docs/api.md">API</a>
        <a href="${REPO}LICENSE.md">License</a>
      </nav>
      <p class="fine">© 2026 Chykalophia Group, LLC. Source-available under FSL-1.1-ALv2.</p>
    </div>
  </footer>
  <script>
    // The contents stay open beside the page on wide screens and fold away on narrow ones.
    const side = document.querySelector("[data-side]");
    const wide = matchMedia("(min-width: 1001px)");
    const fit = () => (side.open = wide.matches);
    fit();
    wide.addEventListener("change", fit);
  </script>
</body>
</html>
`;
}

const flat = ORDER.flatMap(([, names]) => names);
const files = readdirSync(GUIDE).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3));
const unlisted = files.filter((f) => !flat.includes(f));
if (unlisted.length) throw new Error(`Add these guide pages to ORDER in build-docs.mjs: ${unlisted.join(", ")}`);
const pages = new Map(flat.map((n) => [n, render(n)]));

const check = process.argv.includes("--check");
let stale = 0;
for (const doc of pages.values()) {
  const file = join(OUT, htmlFile(doc.name));
  const html = page(doc, pages, flat);
  if (check) {
    if (!existsSync(file) || readFileSync(file, "utf8") !== html) {
      console.error(`out of date: site/docs/${htmlFile(doc.name)}`);
      stale++;
    }
  } else {
    writeFileSync(file, html);
  }
}
if (check && stale) {
  console.error("Run node site/demo/build-docs.mjs and commit site/docs.");
  process.exit(1);
}
console.log(check ? "site/docs is up to date." : `${pages.size} pages → site/docs`);
