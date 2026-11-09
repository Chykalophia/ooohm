import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
const BASE = "http://localhost:3123";
const browser = await chromium.launch({ executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-linux64/chrome-headless-shell` });
for (let attempt = 0; attempt < 4; attempt++) {
  const n0 = readFileSync("/tmp/dp-verify/mail.log", "utf8").split("=====END=====").length;
  await fetch(`${BASE}/api/auth/sign-in/magic-link`, { method: "POST", headers: { origin: BASE, "content-type": "application/json" }, body: JSON.stringify({ email: "admin@example.com", callbackURL: "/" }) });
  let mail = "";
  for (let i = 0; i < 30; i++) {
    mail = readFileSync("/tmp/dp-verify/mail.log", "utf8");
    if (mail.split("=====END=====").length > n0) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  mail = mail.replace(/=\r?\n/g, "").replace(/=3D/g, "=");
  const token = [...mail.matchAll(/magic-link\/verify\?token=([A-Za-z0-9_-]+)/g)].at(-1)[1];
  const ctx = await browser.newContext();
  const res = await ctx.request.get(`${BASE}/api/auth/magic-link/verify?token=${token}&callbackURL=/`, { maxRedirects: 0 });
  const s = await (await ctx.request.get(`${BASE}/api/auth/get-session`)).json();
  console.log("attempt", attempt, res.status(), s?.user?.email);
  if (s?.user) { await ctx.storageState({ path: "/tmp/dp-verify/state.json" }); break; }
  await ctx.close();
  await new Promise((r) => setTimeout(r, 15000));
}
await browser.close();
