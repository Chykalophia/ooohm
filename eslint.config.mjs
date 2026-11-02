import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * Layer boundaries from docs/architecture.md, enforced per directory. Dependencies
 * point downward only; each block bans what its layer must not reach for.
 */
const next = [{ name: "next", message: "Keep Next.js in src/app and src/lib." }];
const pool = { name: "@/db", message: "Take an executor (db or tx) as a parameter instead of importing the pool." };
const drizzle = { group: ["drizzle-orm", "drizzle-orm/*", "postgres"], message: "Database access belongs in src/server/repositories." };
const nextSub = { group: ["next/*"], message: "Keep Next.js in src/app and src/lib." };
const upward = (message) => ({ group: ["@/app/*"], message });
// Rules match import specifiers, so a "../" path would slip past every alias ban below.
const relative = { group: ["../*"], message: "Import across directories through the @/ alias, so the layer rules apply." };
const belowServices = (message) => ({ group: ["@/server/services/*", "@/server/repositories/*"], message });

const layers = [
  {
    files: ["src/app/**/*.{ts,tsx}"],
    paths: [pool, { name: "@/db/schema", message: "Pages and actions call services, not the schema." }],
    patterns: [drizzle, relative, { group: ["@/server/repositories/*"], message: "Pages and actions call services, not repositories." }],
  },
  {
    files: ["src/server/services/**/*.ts"],
    paths: [
      ...next,
      pool,
      { name: "@/db/schema", message: "Queries belong in src/server/repositories." },
      { name: "@/lib/env", message: "Read configuration through the ServiceContext." },
      { name: "@/lib/auth", message: "Services take an Actor; the page or action resolves the session." },
      { name: "@/server/runtime", message: "Services take a ServiceContext; only src/app builds one." },
    ],
    patterns: [drizzle, relative, nextSub, upward("Services never import presentation.")],
  },
  {
    files: ["src/server/repositories/**/*.ts"],
    paths: [...next, pool, { name: "@/lib/env", message: "Repositories take everything they need as arguments." }],
    patterns: [
      upward("Repositories never import presentation."),
      { group: ["@/server/services/*", "@/server/email/*", "@/server/runtime", "@/lib/auth"], message: "Repositories sit below services." },
      nextSub,
      relative,
    ],
  },
  {
    // Email templates and the ServiceContext type sit beside services and are pure: no
    // database, configuration, session or framework.
    files: ["src/server/email/**/*.ts", "src/server/context.ts"],
    paths: [
      ...next,
      pool,
      { name: "@/db/schema", message: "Templates and the context type never query." },
      { name: "@/lib/env", message: "Configuration reaches services through the ServiceContext." },
      { name: "@/lib/auth", message: "Templates resolve nothing from the session." },
      { name: "@/server/runtime", message: "Only src/app builds the runtime context." },
    ],
    patterns: [drizzle, nextSub, relative, upward("Nothing in src/server imports presentation."), belowServices("Templates and the context type sit below services.")],
  },
  {
    // The adapter seam sits beside services, like the context type: adapters see envelopes
    // and an AdapterContext, never the database, configuration, session or framework.
    // What they return is written by services (applyInboundSync).
    files: ["src/server/integrations/**/*.ts"],
    paths: [
      ...next,
      pool,
      { name: "@/db/schema", message: "Adapters never query; services write what they return." },
      { name: "@/lib/env", message: "Adapter configuration reaches them through the AdapterContext." },
      { name: "@/lib/auth", message: "Adapters resolve nothing from the session." },
      { name: "@/server/runtime", message: "Only src/app builds the runtime context." },
    ],
    patterns: [drizzle, nextSub, relative, upward("Nothing in src/server imports presentation."), belowServices("Adapters sit below services.")],
  },
  {
    // The composition root wires infrastructure into a ServiceContext; it calls no use case.
    files: ["src/server/runtime.ts"],
    patterns: [relative, upward("Nothing in src/server imports presentation."), belowServices("The runtime builds the context; pages call services.")],
  },
  {
    files: ["src/domain/**/*.ts"],
    paths: next,
    patterns: [
      { group: ["@/*", "!@/domain", "!@/domain/*"], message: "The domain imports only from src/domain." },
      { group: ["../*"], message: "The domain imports only from src/domain." },
      { group: ["next/*", "react", "react-dom", "server-only", "better-auth", "better-auth/*", "nodemailer", "node:*"], message: "The domain is pure: no framework or I/O." },
      drizzle,
    ],
  },
  {
    files: ["src/lib/**/*.ts", "src/db/**/*.ts"],
    patterns: [relative, { group: ["@/app/*", "@/server/*"], message: "Infrastructure never imports the layers built on it." }],
  },
].map(({ files, paths = [], patterns = [] }) => ({
  files,
  rules: { "no-restricted-imports": ["error", { paths, patterns }] },
}));

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  ...layers,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
