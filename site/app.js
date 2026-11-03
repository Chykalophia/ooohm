// OOOhm marketing site. Plain modules, no build step. Everything here is progressive:
// without JavaScript the page still reads top to bottom, the videos still show posters.

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs `start` while `el` is on screen and `stop` when it leaves. */
function whileVisible(el, start, stop = () => {}, threshold = 0.3) {
  if (!el) return;
  new IntersectionObserver(([e]) => (e.isIntersecting ? start() : stop()), { threshold }).observe(el);
}

/**
 * Keeps `el` as tall as the tallest of `variants`, so text that changes never moves the page.
 * The variants are hidden copies stacked in the same grid cell, so the space follows the width.
 */
function reserve(el, variants, { html = false } = {}) {
  if (!el) return;
  const stack = document.createElement(el.tagName === "SPAN" ? "span" : "div");
  stack.className = "stack";
  el.replaceWith(stack);
  stack.append(el);
  for (const v of variants) {
    const ghost = typeof v === "string" ? document.createElement(el.tagName) : v;
    if (typeof v === "string") {
      ghost.className = el.className;
      ghost[html ? "innerHTML" : "textContent"] = v;
    }
    ghost.classList.add("ghost");
    ghost.setAttribute("aria-hidden", "true");
    stack.append(ghost);
  }
}

/* ------------------------------------------------------------------------ */
/* Day counting, the same rules as the app: Mon–Fri, minus company holidays. */

const HOLIDAYS = new Map([
  ["2026-01-01", "New Year’s Day"], ["2026-05-25", "Memorial Day"], ["2026-07-03", "Independence Day"],
  ["2026-09-07", "Labor Day"], ["2026-11-26", "Thanksgiving"], ["2026-11-27", "the day after Thanksgiving"],
  ["2026-12-24", "Christmas Eve"], ["2026-12-25", "Christmas Day"], ["2027-01-01", "New Year’s Day"],
]);
const DAY = 86_400_000;
const parse = (iso) => new Date(`${iso}T12:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function label(isoDate, withYear = false) {
  const d = parse(isoDate);
  const y = d.getUTCFullYear();
  return `${WD[d.getUTCDay()]}, ${MO[d.getUTCMonth()]} ${d.getUTCDate()}${withYear || y !== 2026 ? `, ${y}` : ""}`;
}
const days = (n) => `${n === 0.5 ? "half a day" : `${fmt(n)} ${n === 1 ? "day" : "days"}`}`;
const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** Working days per year between two dates, and what was skipped. */
function count(from, to, portion) {
  const byYear = {};
  const skipped = { weekends: 0, holidays: [] };
  const end = parse(to).getTime();
  for (let t = parse(from).getTime(); t <= end; t += DAY) {
    const d = new Date(t);
    const key = iso(d);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) { skipped.weekends++; continue; }
    if (HOLIDAYS.has(key)) { skipped.holidays.push(HOLIDAYS.get(key)); continue; }
    const y = d.getUTCFullYear();
    byYear[y] = (byYear[y] ?? 0) + (portion === "full" ? 1 : 0.5);
  }
  const total = Object.values(byYear).reduce((a, b) => a + b, 0);
  return { byYear, total, skipped };
}

/* ------------------------------------------------------------------------ */
/* The hero sentence: try it, or watch it try a few on its own.              */

const TYPES = {
  pto: { name: "PTO (Scheduled Time Off)", short: "PTO", allowance: 15, used: 6, color: "var(--pto)" },
  sick: { name: "Sick Leave", short: "Sick Leave", allowance: 5, used: 1, color: "var(--sick)" },
  emergency: { name: "Emergency Leave", short: "Emergency Leave", allowance: 3, used: 0, color: "var(--emergency)" },
};
const PORTION = { full: "full days", am: "the morning only", pm: "the afternoon only" };
const SCENES = [
  { type: "pto", from: "2026-12-21", to: "2026-12-23", portion: "full" },
  { type: "pto", from: "2026-11-23", to: "2026-11-27", portion: "full" },
  { type: "sick", from: "2026-11-06", to: "2026-11-06", portion: "am" },
  { type: "pto", from: "2026-12-24", to: "2027-01-01", portion: "full" },
  { type: "pto", from: "2026-12-07", to: "2026-12-18", portion: "full" },
];

function sentence() {
  const form = $("[data-sentence]");
  if (!form) return;
  const f = form.elements;
  const out = (k) => $(`[data-out="${k}"]`, form);
  const preview = $("[data-preview]", form);
  const why = $("[data-why]", form);
  const squares = $("[data-squares]", form);
  const sent = $("[data-sent]", form);
  const note = $("[data-demo-note]");
  let last = {};

  // Reserve room for the longest version of every line that changes, so the card never resizes.
  // The longest sentences a person is likely to make: a range into next year, or one half day.
  const sentenceGhost = (values) => {
    const g = $(".sentence", form).cloneNode(true);
    for (const c of $$("select, input", g)) c.remove();
    for (const [k, v] of Object.entries(values)) $(`[data-out="${k}"]`, g).textContent = v;
    for (const e of $$("[data-out]", g)) e.removeAttribute("data-out");
    return g;
  };
  reserve($(".sentence", form), [
    sentenceGhost({ type: TYPES.pto.name, from: "Wed, Dec 30", to: "Fri, Jan 8, 2027", portion: PORTION.full }),
    sentenceGhost({ type: TYPES.pto.name, from: "Wed, Dec 30", to: "Wed, Dec 30", portion: PORTION.pm }),
  ]);
  reserve(preview, [
    "This request takes <b>6 days</b>. Afterwards you’d have 3 days left for 2026. And 2 days from 2027.",
    "This request takes <b>12 days</b>. That’s 3 days more than you have left for 2026.",
    "Those days are all weekends or holidays, so there’s nothing to take.",
  ], { html: true });
  reserve(why, ["Weekends don’t count, and neither do Thanksgiving and the day after Thanksgiving."]);
  reserve(sent, ["Sent for approval: 12.5 days. (Only in this demo, so nobody got an email.)"]);

  function render() {
    const s = { type: f.type.value, from: f.from.value, to: f.to.value, portion: f.portion.value };
    const single = s.from === s.to;
    for (const o of f.portion.options) if (o.value !== "full") o.disabled = !single;
    if (!single && s.portion !== "full") s.portion = f.portion.value = "full";
    const t = TYPES[s.type];

    for (const k of ["type", "from", "to", "portion"]) {
      const text = k === "type" ? t.name : k === "portion" ? PORTION[s.portion] : s[k] ? label(s[k]) : "pick a day";
      const el = out(k);
      if (el.textContent !== text) {
        el.textContent = text;
        if (last.type !== undefined) flash(el.parentElement);
      }
    }
    $("[data-type-name]", form).textContent = t.short;
    squares.style.setProperty("--c", t.color);

    let request = 0;
    let line = "";
    let reason = "";
    if (!s.from || !s.to) line = "Pick the first and the last day.";
    // A typed year like 20266 passes the string checks but would make count() walk millions of days.
    else if (!f.from.checkValidity() || !f.to.checkValidity()) line = "Pick days in 2026 or 2027.";
    else if (s.to < s.from) line = "The last day is before the first one.";
    else {
      const c = count(s.from, s.to, s.portion);
      request = c.byYear[2026] ?? 0;
      const left = t.allowance - t.used - request;
      if (c.total === 0) line = "Those days are all weekends or holidays, so there’s nothing to take.";
      else {
        line = `This request takes <b>${days(c.total)}</b>.`;
        if (request > 0) line += left >= 0 ? ` Afterwards you’d have ${days(left)} left for 2026.` : ` That’s ${days(-left)} more than you have left for 2026.`;
        if (c.byYear[2027]) line += ` ${request > 0 ? "And" : "It takes"} ${days(c.byYear[2027])} from 2027.`;
      }
      const parts = [];
      if (c.skipped.weekends) parts.push("Weekends don’t count");
      const hol = [...new Set(c.skipped.holidays)];
      const named = c.skipped.holidays.length > 2 ? `${c.skipped.holidays.length} company holidays` : hol.join(" and ");
      if (hol.length) parts.push(`${parts.length ? "and neither do" : "Holidays don’t count:"} ${named}`);
      reason = parts.length ? `${parts.join(", ")}.` : "";
    }
    preview.innerHTML = line;
    why.textContent = reason;
    drawSquares(squares, t.allowance, t.used, request, 0, 20);
    if (last.type !== undefined) sent.textContent = "";
    last = s;
  }

  function flash(el) {
    el.classList.remove("flash");
    void el.offsetWidth;
    el.classList.add("flash");
    setTimeout(() => el.classList.remove("flash"), 500);
  }

  form.addEventListener("input", render);
  form.addEventListener("change", render);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!f.from.value || !f.from.checkValidity() || !f.to.checkValidity() || f.to.value < f.from.value) return;
    const c = count(f.from.value, f.to.value, f.portion.value);
    sent.textContent = c.total ? `Sent for approval: ${days(c.total)}. (Only in this demo, so nobody got an email.)` : "";
  });

  // The demo plays scenes until someone touches the sentence.
  const NOTE_TURN = "Your turn. This demo counts Monday to Friday with US holidays; in the app, each company sets its own working days and holidays.";
  reserve(note, [NOTE_TURN]);
  let playing = !reduceMotion;
  let timer = 0;
  let visible = false;
  let scene = 0;
  const stopDemo = () => {
    if (!playing) return;
    playing = false;
    clearTimeout(timer);
    note.textContent = NOTE_TURN;
  };
  for (const ev of ["pointerdown", "keydown", "focusin"]) form.addEventListener(ev, stopDemo, { once: true });

  // The two dates change together, so no half-changed range flashes up in between.
  async function play(s) {
    for (const keys of [["type"], ["from", "to"], ["portion"]]) {
      if (!playing) return;
      if (keys.every((k) => f[k].value === s[k])) continue;
      for (const k of keys) f[k].value = s[k];
      render();
      await sleep(420);
    }
  }
  function tick() {
    if (!playing) return;
    scene = (scene + 1) % SCENES.length;
    play(SCENES[scene]).then(() => {
      if (!playing || !visible) return;
      clearTimeout(timer);
      timer = setTimeout(tick, 3400);
    });
  }
  render();
  if (!reduceMotion) {
    whileVisible(form, () => { visible = true; clearTimeout(timer); if (playing) timer = setTimeout(tick, 2800); }, () => { visible = false; clearTimeout(timer); });
  } else {
    note.textContent = "Change any part of the sentence. This demo counts Monday to Friday with US holidays; in the app, each company sets its own.";
  }
}

/**
 * Squares: one per day of allowance. Taken, then this request striped, then what's left.
 * At least `slots` squares are laid out; the ones past what's shown are hidden and hold the space.
 */
function drawSquares(root, allowance, used, request, carry = 0, slots = 0) {
  // With `slots`, a very long request is cut off at that many squares; the sentence gives the count.
  const wanted = Math.max(allowance + carry, used + Math.ceil(request));
  const shown = slots ? Math.min(wanted, slots) : wanted;
  const total = Math.max(shown, slots);
  const before = root.children.length;
  while (root.children.length < total) root.append(document.createElement("i"));
  while (root.children.length > total) root.lastElementChild.remove();
  [...root.children].forEach((sq, i) => {
    const next = [];
    if (i >= shown) next.push("ghost");
    else if (i < used) next.push("taken");
    else if (i < used + request) {
      next.push("pending");
      if (used + request - i === 0.5) next.push("half");
      if (i >= allowance + carry) next.push("over");
    } else if (i >= allowance) next.push("carry");
    const cls = next.join(" ");
    if (sq.className.replace(" pop", "") !== cls) {
      sq.className = cls;
      if (before && !reduceMotion) { sq.classList.add("pop"); setTimeout(() => sq.classList.remove("pop"), 400); }
    }
  });
}

/* ------------------------------------------------------------------------ */
/* A year of PTO, played as a timeline, with the carryover switch.          */

function year() {
  const card = $("[data-year]");
  if (!card) return;
  const sq = $("[data-year-squares]", card);
  const line = $("[data-year-line]", card);
  const yearLabel = $("[data-year-label]", card);
  const items = $$("[data-timeline] li", card);
  let carry = 0;
  let timer = 0;
  let started = false;
  const LAST = {
    0: "The 6 unused days end with 2026. 2027 starts with a fresh 15.",
    5: "5 of the 6 unused days carry over, and 1 doesn’t. 2027 starts with 20.",
  };

  const STEPS = [
    { used: 0, req: 0, text: "15 days of PTO for 2026." },
    { used: 0, req: 0, text: "A sick day comes out of Sick Leave. PTO doesn’t move." },
    { used: 3, req: 0, text: "3 days at the lake house. 12 left." },
    { used: 6, req: 0, text: "3 more for a family trip. 9 left." },
    { used: 6, req: 3, text: "Asked for 3 more. They show as waiting until Maya decides." },
    { used: 9, req: 0, text: "Approved. 6 days left of 15." },
  ];

  function show(i) {
    items.forEach((li, j) => { li.classList.toggle("now", j === i); li.classList.toggle("done", j < i); });
    if (i < STEPS.length) {
      const s = STEPS[i];
      yearLabel.textContent = "2026";
      drawSquares(sq, 15, s.used, s.req, 0, 20);
      line.textContent = s.text;
    } else {
      yearLabel.textContent = "2027";
      drawSquares(sq, 15, 0, 0, carry, 20);
      line.textContent = LAST[carry];
    }
  }
  function run(from = 0) {
    clearTimeout(timer);
    const next = (i) => {
      show(i);
      if (i < items.length - 1) timer = setTimeout(() => next(i + 1), i === 0 ? 1400 : 1700);
    };
    next(from);
  }
  reserve(line, [...STEPS.map((x) => x.text), ...Object.values(LAST)]);
  $$("[data-carry]", card).forEach((b) =>
    b.addEventListener("click", () => {
      carry = Number(b.dataset.carry);
      $$("[data-carry]", card).forEach((o) => o.setAttribute("aria-checked", String(o === b)));
      clearTimeout(timer);
      show(items.length - 1);
    }),
  );
  $("[data-year-replay]", card).addEventListener("click", () => run(0));
  if (reduceMotion) return show(items.length - 1);
  show(0);
  whileVisible(card, () => { if (!started) { started = true; run(0); } }, () => {}, 0.5);
}

/* ------------------------------------------------------------------------ */
/* Approve from the email, and watch it land in the audit log.              */

function mail() {
  const btn = $("[data-mail-approve]");
  if (!btn) return;
  btn.addEventListener("click", () => {
    btn.disabled = true;
    btn.textContent = "Approved";
    $("[data-mail-done]").hidden = false;
    const li = document.createElement("li");
    li.className = "fresh";
    li.innerHTML = "<time>Nov 3, 09:41</time><span><b>Maya Chen</b> approved Lena Park’s 3 days, through the email link</span>";
    $("[data-audit]").prepend(li);
  });
}

/* The Needs you list, deciding itself in a loop. */
function triage() {
  const rows = $("[data-triage-rows]");
  if (!rows) return;
  const countEl = $("[data-count-needs]");
  let timer = 0;
  let pool = 0;
  fill(rows, 3);
  if (reduceMotion) return;
  function fill(root, n) { for (let i = 0; i < n; i++) root.append(row()); layout(); }
  function row() {
    const r = POOL[pool++ % POOL.length];
    const el = document.createElement("div");
    el.className = "trow";
    el.innerHTML = `<span>${r[0]}</span><span class="when"><i class="dot" style="background:${r[3]}"></i>${r[1]} · ${r[2]}</span><span class="act"><b>Approve</b></span>`;
    return el;
  }
  function layout() {
    const h = parseFloat(getComputedStyle(rows).getPropertyValue("--row")) || 56;
    [...rows.children].filter((r) => !r.classList.contains("go")).forEach((r, i) => (r.style.transform = `translateY(${i * h}px)`));
  }
  addEventListener("resize", layout, { passive: true });
  // Each step schedules the next once it has finished, so two never overlap.
  async function step() {
    const first = rows.querySelector(".trow:not(.go)");
    if (!first) return;
    first.querySelector(".act b").style.background = "var(--accent-strong)";
    await sleep(350);
    first.querySelector(".act").innerHTML = '<span class="badge">Approved</span>';
    await sleep(700);
    first.classList.add("go");
    countEl.textContent = "2";
    await sleep(450);
    first.remove();
    const fresh = row();
    fresh.style.opacity = "0";
    rows.append(fresh);
    layout();
    await sleep(500);
    fresh.style.opacity = "";
    countEl.textContent = "3";
  }
  // `busy` covers a step still animating when the list leaves and re-enters view: that step
  // schedules the next one itself, so re-entering mustn't start a second.
  let visible = false;
  let busy = false;
  const loop = () => {
    timer = setTimeout(async () => {
      busy = true;
      await step();
      busy = false;
      if (visible) loop();
    }, 1200);
  };
  whileVisible(rows, () => { visible = true; if (!busy) { clearTimeout(timer); loop(); } }, () => { visible = false; clearTimeout(timer); });
}
const POOL = [
  ["Lena Park", "Dec 21 – Dec 23", "3 days", "var(--pto)"],
  ["Jonas Berg", "Dec 14 – Dec 18", "5 days", "var(--pto)"],
  ["Eli Brooks", "Nov 12 – Nov 13", "2 days", "var(--pto)"],
  ["Noor Haddad", "Nov 5, afternoon", "half a day", "var(--emergency)"],
  ["Sam Okafor", "Jan 4 – Jan 8", "5 days", "var(--pto)"],
  ["Priya Nair", "Nov 30", "1 day", "var(--sick)"],
];

/* ------------------------------------------------------------------------ */
/* Webhook deliveries scrolling by.                                         */

const EVENTS = [
  ["leave.requested", { requestId: "8f2c…", userId: "lena", startDate: "2026-12-21", endDate: "2026-12-23", days: 3, status: "pending" }],
  ["leave.approved", { requestId: "8f2c…", days: 3, status: "approved", actor: { type: "user", id: "maya", via: "email_link" } }],
  ["balance.adjusted", { userId: "priya", leaveTypeId: "pto", year: 2026, days: 17, reason: "admin_edit" }],
  ["leave.recounted", { requestId: "41b9…", days: 2, previousDays: 3, actor: { type: "user", id: "maya", via: "holiday_change" } }],
  ["leave.cancelled", { requestId: "c07e…", days: 1, status: "cancelled", actor: { type: "user", id: "jonas" } }],
  ["user.created", { userId: "noor", role: "employee", managerId: "maya" }],
  ["balance.adjusted", { userId: "sam", year: 2027, days: 15, carriedOverDays: 4, actor: { type: "system", process: "year_rollover" } }],
];

function consoleStream() {
  const log = $("[data-console-log]");
  if (!log) return;
  let i = 0;
  let timer = 0;
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  function json(o) {
    return esc(JSON.stringify(o))
      .replace(/"([^"]+)":/g, '<span class="k">"$1"</span>:')
      .replace(/:"([^"]*)"/g, ':<span class="s">"$1"</span>');
  }
  function push() {
    const [type, data] = EVENTS[i++ % EVENTS.length];
    const li = document.createElement("li");
    const ms = 40 + Math.round(Math.random() * 120);
    li.innerHTML = `<div class="ev-head"><span class="ev-type">${type}</span><span class="ev-ok"><b>200</b> · ${ms} ms</span></div><div class="ev-json">${json(data)}</div>`;
    log.append(li);
    while (log.children.length > 7) log.firstElementChild.remove();
  }
  for (let k = 0; k < 6; k++) push();
  if (reduceMotion) return;
  whileVisible(log, () => { clearInterval(timer); timer = setInterval(push, 2200); }, () => clearInterval(timer));
}

/* ------------------------------------------------------------------------ */
/* The terminal: docker compose up, once per visit to the section.          */

const TERM = [
  ["d", "[+] Running 5/5"],
  ["g", " ✔ db        Healthy"],
  ["g", " ✔ migrate   Exited   migrations, seed, year rollover"],
  ["g", " ✔ app       Started  http://localhost:3000"],
  ["g", " ✔ worker    Started  webhooks and daily jobs"],
  ["g", " ✔ mailpit   Started  http://localhost:8025"],
  ["", ""],
  ["d", "app     | ready"],
  ["d", "migrate | Created company \"Northwind Studio\"."],
  ["d", "migrate | Created admin you@company.com."],
  ["d", "worker  | delivering events"],
];

function terminal() {
  const pre = $("[data-term-out]");
  if (!pre) return;
  const full = `<span class="c">$</span> docker compose up\n` + TERM.map(([c, t]) => `<span class="${c}">${t}</span>`).join("\n");
  if (reduceMotion) return (pre.innerHTML = full);
  let running = false;
  async function run() {
    if (running) return;
    running = true;
    pre.innerHTML = `<span class="c">$</span> <span data-typed></span><span class="caret"></span>`;
    const typed = $("[data-typed]", pre);
    await sleep(500);
    for (const ch of "docker compose up") { typed.textContent += ch; await sleep(55 + Math.random() * 50); }
    await sleep(350);
    pre.querySelector(".caret").remove();
    for (const [c, t] of TERM) {
      pre.insertAdjacentHTML("beforeend", `\n<span class="${c}">${t}</span>`);
      await sleep(t ? 260 : 120);
    }
  }
  whileVisible(pre, run, () => {}, 0.4);
}

/* ------------------------------------------------------------------------ */
/* Themes: real screenshots of the app in each look.                        */

function themes() {
  const root = $("[data-themes]");
  if (!root) return;
  const img = $("[data-theme-img]", root);
  const buttons = $$("[data-theme]", root);
  let auto = !reduceMotion;
  let timer = 0;
  let current = 0;
  let swap = 0;
  const preload = new Set();
  function pick(i, user = false) {
    current = i;
    clearTimeout(swap);
    const b = buttons[i];
    buttons.forEach((o) => o.setAttribute("aria-checked", String(o === b)));
    const src = `media/themes/${b.dataset.theme}.jpg`;
    const next = buttons[(i + 1) % buttons.length].dataset.theme;
    if (!preload.has(next)) { preload.add(next); new Image().src = `media/themes/${next}.jpg`; }
    img.classList.add("swap");
    // Only the latest pick lands, even if an automatic one was already on its way.
    swap = setTimeout(() => {
      img.src = src;
      img.alt = `The OOOhm home screen in the ${b.textContent} theme`;
      img.decode().catch(() => {}).finally(() => { if (current === i) img.classList.remove("swap"); });
    }, user ? 120 : 250);
  }
  buttons.forEach((b, i) => b.addEventListener("click", () => { auto = false; clearInterval(timer); pick(i, true); }));
  whileVisible(root, () => { clearInterval(timer); if (auto) timer = setInterval(() => pick((current + 1) % buttons.length), 2600); }, () => clearInterval(timer));
}

/* ------------------------------------------------------------------------ */
/* Recorded clips: play while on screen. The film: in a dialog, on request. */

function clips() {
  for (const v of $$("video[data-autoplay]")) {
    if (reduceMotion) { v.controls = true; continue; }
    // A pause button in the window bar; once someone pauses, scrolling back doesn't restart it.
    let held = false;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "clip-toggle";
    const label = () => { btn.textContent = held ? "Play" : "Pause"; btn.setAttribute("aria-label", `${held ? "Play" : "Pause"} the clip`); };
    label();
    btn.addEventListener("click", () => { held = !held; label(); if (held) v.pause(); else v.play().catch(() => {}); });
    (v.closest(".browser")?.querySelector(".browser-bar") ?? v.parentElement).append(btn);
    whileVisible(v, () => { v.preload = "auto"; if (!held) v.play().catch(() => (v.controls = true)); }, () => v.pause(), 0.35);
  }
  const dialog = $("[data-film]");
  const film = $("[data-film-video]");
  $$("[data-open-film]").forEach((b) =>
    b.addEventListener("click", () => {
      dialog.showModal();
      film.preload = "auto";
      film.currentTime = 0;
      film.play().catch(() => {});
    }),
  );
  dialog.addEventListener("close", () => film.pause());
  dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });
}

/* ------------------------------------------------------------------------ */

function chrome() {
  const nav = $("[data-nav]");
  const onScroll = () => nav.classList.toggle("scrolled", scrollY > 8);
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();
  if (reduceMotion) return;
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
  }, { threshold: 0.12, rootMargin: "0px 0px -40px 0px" });
  for (const el of $$(".section-head, .chapter-copy, .chapter-media, .rules li, .split > div, .mgr-grid > *, .host-grid > *, .themes, .triage, .import-note")) {
    el.classList.add("reveal");
    io.observe(el);
  }
}

chrome();
sentence();
year();
mail();
triage();
consoleStream();
terminal();
themes();
clips();
