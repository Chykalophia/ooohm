// Shared timing helpers for the social cuts. Each film sets window.CAPTIONS and calls
// drawCaption(t) from its seek(t); render-launch.mjs renders it frame by frame.
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const out = (x) => 1 - Math.pow(1 - x, 3);
/** 0 before a, 1 after b, eased between. */
const ramp = (t, a, b, f = ease) => f(clamp((t - a) / (b - a)));
/** Visible from a to b, with short fades at both ends. A window starting at 0 is on from the first frame. */
const shown = (t, a, b, f = 0.35) => (a <= 0 ? 1 : ramp(t, a, a + f)) * (1 - ramp(t, b - f, b));
const $ = (id) => document.getElementById(id);
const set = (el, o, y = 0, s = 1) => { el.style.opacity = o; el.style.transform = `translateY(${y}px) scale(${s})`; };
const FPS = 30;
const URL_TEXT = new URLSearchParams(location.search).get("url") || "ooohm.team";
window.CLIP_COUNTS = {};
const FILM = location.pathname.split("/").pop().replace(/\.html$/, "");

/** Shows a recording in `img` at `local` seconds into its chapter. */
async function drawClip(img, clip, from, rate, local) {
  const n = window.CLIP_COUNTS[clip] ?? 1;
  const frame = Math.min(n, Math.max(1, Math.round((from + local * rate) * FPS) + 1));
  const src = `.frames/${FILM}/${clip}/${String(frame).padStart(5, "0")}.jpg`;
  if (!img.src.endsWith(src)) { img.src = src; await img.decode(); }
}

function drawCaption(t) {
  const line = window.CAPTIONS.find((l) => t >= l.at && t < l.end);
  const cap = $("caption");
  if (line) { cap.textContent = line.text; cap.style.opacity = line.at <= 0 ? 1 * (1 - ramp(t, line.end - 0.15, line.end)) : shown(t, line.at, line.end, 0.15); } else cap.style.opacity = 0;
}

const readyAll = () => Promise.all([...document.images].filter((i) => i.hasAttribute("src")).map((i) => i.decode()));
