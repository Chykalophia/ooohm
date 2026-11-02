/**
 * Runs once when a server instance starts, before it takes a request. Everything it does
 * is Node.js-only and needs the real environment, so it is skipped on the Edge runtime
 * and during `next build`.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { startBackground } = await import("./instrumentation-node");
  await startBackground();
}
