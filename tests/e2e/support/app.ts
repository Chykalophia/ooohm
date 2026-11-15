/**
 * Starts the built app the way a single-machine install runs it: `pnpm start:embedded`
 * (migrate, seed, `next start` on embedded PGlite), in a fresh data directory, sending
 * mail to a {@link MailSink}. Needs `pnpm build` first. Every setting is the app's own
 * production configuration; there is no test-only switch or sign-in path.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MailSink } from "./mail-sink";

const ROOT = resolve(import.meta.dirname, "..", "..", "..");

export const ADMIN_EMAIL = "admin@e2e.example.com";

export interface RunningApp {
  url: string;
  mail: MailSink;
  /** What the app printed, for a failure's message. */
  output(): string;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  await new Promise<void>((r) => server.close(() => r()));
  return typeof address === "object" && address ? address.port : 0;
}

export async function startApp(): Promise<RunningApp> {
  const mail = new MailSink();
  await mail.start();
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const dataDir = mkdtempSync(join(tmpdir(), "ooohm-e2e-"));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: "production",
    OOOHM_DB: "embedded",
    OOOHM_DATA_DIR: join(dataDir, "pglite"),
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    BETTER_AUTH_URL: url,
    BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
    WEBHOOK_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    SEED_ADMIN_EMAIL: ADMIN_EMAIL,
    SEED_ADMIN_NAME: "Ada Admin",
    SEED_COMPANY_NAME: "E2E Company",
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: String(mail.port),
    SMTP_SECURE: "false",
    SMTP_REQUIRE_TLS: "false",
    MAIL_FROM: "OOOhm <no-reply@e2e.example.com>",
    LOG_LEVEL: "warn",
    NEXT_TELEMETRY_DISABLED: "1",
  };
  let output = "";
  const child: ChildProcess = spawn("pnpm", ["start:embedded"], { cwd: ROOT, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (d: Buffer) => (output += d.toString()));
  child.stderr?.on("data", (d: Buffer) => (output += d.toString()));

  const stop = async () => {
    if (child.exitCode === null && child.pid) {
      const exited = new Promise<void>((r) => child.once("exit", () => r()));
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
      await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
      if (child.exitCode === null) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
    await mail.stop();
    rmSync(dataDir, { recursive: true, force: true });
  };

  const deadline = Date.now() + 120_000;
  for (;;) {
    if (child.exitCode !== null) {
      await stop();
      throw new Error(`pnpm start:embedded exited with ${child.exitCode}. Did you run pnpm build?\n${output}`);
    }
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`The app did not answer /api/health within 120 s.\n${output}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { url, mail, output: () => output, stop };
}
