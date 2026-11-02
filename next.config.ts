import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Docker image. Embedded mode serves the same build
  // with `next start` from the checkout (`pnpm start:embedded`), which standalone does not.
  output: process.env.OOOHM_DB === "embedded" ? undefined : "standalone",
  // Cache Components is off for v1: almost every page is per-user and per-request,
  // so the simpler fully-dynamic model is easier to reason about. Revisit after v1.
  cacheComponents: false,
  // Production runs behind Caddy (deploy/Caddyfile), which compresses with zstd or gzip;
  // compressing here too would only spend the app's CPU on bytes Caddy then passes through.
  compress: false,
  poweredByHeader: false,
  // Embedded mode loads PGlite and drizzle's PGlite driver at run time from node_modules
  // (src/db/connect.ts, `webpackIgnore`), so neither is bundled nor traced into the
  // Docker image or Vercel functions. drizzle-orm stays external too, so the app and that
  // driver share one copy of it.
  serverExternalPackages: ["drizzle-orm"],
  // No serverActions.allowedOrigins: Caddy forwards the public host (Host and
  // X-Forwarded-Host), so Next's origin check compares like with like. A proxy that
  // rewrites the host would need its public host listed there.
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
