import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * Layer boundaries from docs/architecture.md, enforced per directory. Dependencies
 * point downward only; each block bans what its layer must not reach for.
 */
const next = [{ name: "next", message: "Keep Next.js in src/app and src/lib." }];
const pool = { name: "@/db", message: "Take an executor (db or tx) as a parameter instead of importing the pool." };
const drizzle = { group: ["drizzle-orm", "drizzle-orm/*", "postgres"], message: "Database access belongs in a repository: a module's infrastructure/ or src/shared/lib/db." };
const nextSub = { group: ["next/*"], message: "Keep Next.js in src/app and src/lib." };
const upward = (message) => ({ group: ["@/app/*"], message });
// Rules match import specifiers, so a "../" path would slip past every alias ban below.
const relative = { group: ["../*"], message: "Import across directories through the @/ alias, so the layer rules apply." };
const belowUseCases = (message) => ({ group: ["@/shared/lib/db/*", "@/shared/lib/unit-of-work", "@/shared/lib/admin-access"], message });

const layers = [
  {
    files: ["src/app/**/*.{ts,tsx}"],
    paths: [pool, { name: "@/db/schema", message: "Pages and actions call services, not the schema." }],
    patterns: [
      drizzle,
      relative,
      { group: ["@/shared/lib/db/*"], message: "Pages and actions call modules, not repositories." },
      {
        group: ["@/modules/import", "@/modules/import/*", "@/modules/import/**"],
        message: "The TimeOff import is CLI-only: it has no actor or authorization.",
      },
    ],
  },
  {
    // Shared UI: building blocks that render what a page passes in. They hold no data
    // access or session logic of their own, so any page (or a future app) can reuse them.
    files: ["src/components/**/*.{ts,tsx}"],
    // @/lib/auth-client stays allowed: it is the browser's own sign-in client (Sign out).
    paths: [
      pool,
      { name: "@/lib/env", message: "Components take configuration as props." },
      { name: "@/lib/worker-env", message: "Components take configuration as props." },
      { name: "@/lib/auth", message: "Components take the person as props; the page resolves the session." },
      { name: "@/lib/log", message: "The server logger cannot run in a browser; components report through props or state." },
      { name: "server-only", message: "Components are shared by server and client code." },
    ],
    patterns: [
      { group: ["@/db/*"], message: "Components render props; the page loads the data." },
      drizzle,
      relative,
      upward("Pages import components, never the reverse."),
      { group: ["@/server/*", "@/server/**"], message: "Components render props; the page calls services." },
    ],
  },
  {
    // Use cases: the shared unit of work and admin checks, and the application layer of
    // the Tier 2 modules.
    files: [
      "src/shared/lib/unit-of-work.ts",
      "src/shared/lib/admin-access.ts",
      "src/modules/audit/application/**/*.ts",
      "src/modules/import/application/**/*.ts",
      "src/modules/organisation/application/**/*.ts",
      "src/modules/integrations/application/**/*.ts",
    ],
    paths: [
      ...next,
      pool,
      { name: "@/db/schema", message: "Queries belong in a repository: a module's infrastructure/ or src/shared/lib/db." },
      { name: "@/lib/env", message: "Read configuration through the ServiceContext." },
      { name: "@/lib/auth", message: "Services take an Actor; the page or action resolves the session." },
      { name: "@/server/runtime", message: "Services take a ServiceContext; only src/app builds one." },
    ],
    patterns: [drizzle, relative, nextSub, upward("Services never import presentation.")],
  },
  {
    files: [
      "src/shared/lib/db/**/*.ts",
      "src/modules/import/infrastructure/drizzle-*.ts",
      "src/modules/notifications/infrastructure/**/*.ts",
      "src/modules/audit/infrastructure/**/*.ts",
      "src/modules/organisation/infrastructure/**/*.ts",
      "src/modules/integrations/infrastructure/**/*.ts",
    ],
    paths: [...next, pool, { name: "@/lib/env", message: "Repositories take everything they need as arguments." }],
    patterns: [
      upward("Repositories never import presentation."),
      {
        group: ["@/modules/*", "@/shared/lib/unit-of-work", "@/shared/lib/admin-access", "@/server/runtime", "@/lib/auth"],
        message: "Repositories sit below services and module use cases.",
      },
      nextSub,
      relative,
    ],
  },
  {
    // Email templates and the ServiceContext type sit beside services and are pure: no
    // database, configuration, session or framework.
    files: ["src/modules/notifications/application/templates/**/*.ts", "src/server/context.ts"],
    paths: [
      ...next,
      pool,
      { name: "@/db/schema", message: "Templates and the context type never query." },
      { name: "@/lib/env", message: "Configuration reaches services through the ServiceContext." },
      { name: "@/lib/auth", message: "Templates resolve nothing from the session." },
      { name: "@/server/runtime", message: "Only src/app builds the runtime context." },
    ],
    patterns: [
      drizzle,
      nextSub,
      relative,
      upward("Nothing in src/server imports presentation."),
      // Templates import each other as ./x; every module path (the catalog, the sender, use cases) is above them.
      { group: ["@/modules/*", "@/shared/lib/unit-of-work", "@/shared/lib/admin-access", "@/shared/lib/db/*"], message: "Templates and the context type sit below services and modules." },
    ],
  },
  {
    // The notifications module: the catalog of email types, how they are sent after
    // commit, and the email editor's use cases. Services call it through
    // `commitThenNotify`; it reads through repositories, and never calls a service.
    files: ["src/modules/notifications/**/*.ts"],
    ignores: ["src/modules/notifications/application/templates/**", "src/modules/notifications/infrastructure/**"],
    paths: [
      ...next,
      pool,
      { name: "@/db/schema", message: "Queries belong in a repository: a module's infrastructure/ or src/shared/lib/db." },
      { name: "@/lib/env", message: "Configuration reaches it through the ServiceContext." },
      { name: "@/lib/auth", message: "Notifications resolve nothing from the session." },
      { name: "@/server/runtime", message: "Only src/app builds the runtime context." },
    ],
    patterns: [
      drizzle,
      nextSub,
      relative,
      upward("Nothing in src/server imports presentation."),
    ],
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
    patterns: [drizzle, nextSub, relative, upward("Nothing in src/server imports presentation."), belowUseCases("Adapters sit below use cases and repositories.")],
  },
  {
    // Source readers for one-time imports turn another system's files into plain domain
    // records. They read files only: never OOOhm's database, configuration or session.
    files: ["src/modules/import/infrastructure/timeoff-*.ts"],
    paths: [
      ...next,
      pool,
      { name: "@/db/schema", message: "Importers read the source; the import service writes OOOhm." },
      { name: "@/lib/env", message: "Importers take what they need as arguments." },
      { name: "@/lib/auth", message: "Importers resolve nothing from the session." },
      { name: "@/server/runtime", message: "Only src/app builds the runtime context." },
    ],
    patterns: [drizzle, nextSub, relative, upward("Nothing in src/server imports presentation."), belowUseCases("Importers sit below use cases and repositories.")],
  },
  {
    // The composition root wires infrastructure into a ServiceContext; it calls no use case.
    files: ["src/server/runtime.ts"],
    patterns: [relative, upward("Nothing in src/server imports presentation."), belowUseCases("The runtime builds the context; pages call modules.")],
  },
  {
    files: ["src/domain/**/*.ts"],
    paths: next,
    patterns: [
      // The shared kernel is the domain every module shares (domain-is-pure in .dependency-cruiser.cjs allows it).
      { group: ["@/*", "!@/domain", "!@/domain/*", "!@/shared"], message: "The domain imports only from src/domain and src/shared/kernel." },
      { group: ["@/shared/*", "!@/shared/kernel"], message: "The domain imports only from src/domain and src/shared/kernel." },
      { group: ["../*"], message: "The domain imports only from src/domain." },
      { group: ["next/*", "react", "react-dom", "server-only", "better-auth", "better-auth/*", "nodemailer", "node:*"], message: "The domain is pure: no framework or I/O." },
      drizzle,
    ],
  },
  {
    files: ["src/lib/**/*.ts", "src/db/**/*.ts"],
    patterns: [relative, { group: ["@/app/*", "@/server/*"], message: "Infrastructure never imports the layers built on it." }],
  },
].map(({ files, ignores, paths = [], patterns = [] }) => ({
  files,
  ...(ignores ? { ignores } : {}),
  rules: { "no-restricted-imports": ["error", { paths, patterns }] },
}));

/**
 * Colours come from the theme tokens in src/app/globals.css (`bg-surface`, `text-danger`),
 * which hold a light and a dark value each. A palette class (`text-red-700`) or a `dark:`
 * variant in a component would be right in one theme only.
 */
const paletteClass =
  "(?:^|[\\s:])(?:bg|text|border(?:-[xytrblse])?|ring(?:-offset)?|outline|fill|stroke|divide|decoration|from|via|to|shadow|caret|placeholder|accent)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\\d|(?:^|[\\s:])dark:";
const paletteMessage = "Use a theme token from src/app/globals.css (bg-surface, text-muted, text-accent-ink, text-danger…), not a palette colour or dark: variant.";
const themeTokens = {
  files: ["src/app/**/*.{ts,tsx}", "src/components/**/*.{ts,tsx}"],
  rules: {
    "no-restricted-syntax": [
      "error",
      { selector: `Literal[value=/${paletteClass}/]`, message: paletteMessage },
      { selector: `TemplateElement[value.raw=/${paletteClass}/]`, message: paletteMessage },
    ],
  },
};


/**
 * Size limits (F8, docs/architecture-plan/04-fitness-functions.md). Warnings until A7,
 * when they become errors: thin actions and routes, short functions in logic layers.
 */
const sizeLimits = [
  {
    files: ["src/app/**/actions.ts", "src/app/**/*-actions.ts", "src/app/**/route.ts"],
    rules: { "max-lines": ["warn", { max: 100, skipBlankLines: true, skipComments: true }] },
  },
  {
    files: ["src/server/**/*.ts", "src/domain/**/*.ts", "src/modules/**/*.ts", "src/app/**/actions.ts", "src/app/**/route.ts"],
    rules: { "max-lines-per-function": ["warn", { max: 50, skipBlankLines: true, skipComments: true, IIFEs: true }] },
  },
  {
    files: ["src/modules/*/application/**/*.ts"],
    rules: { "max-lines": ["warn", { max: 500, skipBlankLines: true, skipComments: true }] },
  },
  {
    files: ["src/**/*.tsx"],
    rules: { "max-lines-per-function": ["warn", { max: 150, skipBlankLines: true, skipComments: true }] },
  },
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  ...layers,
  themeTokens,
  ...sizeLimits,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Local agent worktrees (gitignored), each a full copy of the repo.
    ".claude/**",
  ]),
]);

export default eslintConfig;
