// Dependency rules for OOOhm (docs/architecture-plan/04-fitness-functions.md, ADR-0012).
// `pnpm arch` fails on any violation not recorded in .dependency-cruiser-known-violations.json.
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    { name: "no-circular", severity: "error", from: {}, to: { circular: true } },
    {
      name: "domain-is-pure",
      comment: "The shared kernel imports only itself and the shared Result type (reference §2, ADR-0003).",
      severity: "error",
      from: { path: "^src/shared/kernel/" },
      to: { pathNot: ["^src/shared/kernel/", "^src/shared/lib/result\\.ts$"] },
    },
    {
      name: "module-domain-is-pure",
      comment:
        "A module's domain imports only its own domain, the kernel and Result; never another module's domain. $1 is the module the import starts in.",
      severity: "error",
      from: { path: "^src/modules/([^/]+)/domain/" },
      to: { pathNot: ["^src/modules/$1/domain/", "^src/shared/kernel/", "^src/shared/lib/result\\.ts$"] },
    },
    {
      name: "app-not-to-infrastructure",
      comment: "Pages, actions and routes call modules, never the database or the auth SDK (layer skipping).",
      severity: "error",
      from: { path: "^src/app/" },
      to: {
        path: [
          "^src/shared/lib/db/",
          "^src/modules/[^/]+/infrastructure/",
          "^src/db/",
          "node_modules/(drizzle-orm|postgres|@electric-sql|better-auth|nodemailer)/",
        ],
        pathNot: "^src/db/types\\.ts$",
      },
    },
    // F12: pages and actions are thin. They reach the app through module indexes and the
    // presentation helpers, never the services' plumbing (transactions, admin checks,
    // repositories) or the composition root. The two token actions and their pages (the
    // email approval link, the first install) run before or without a session, so they
    // build their own context.
    {
      name: "pages-and-actions-through-modules",
      comment:
        "A page or action imports module indexes, src/app, src/components, the shared kernel, Result and search params, and src/lib's pure helpers; nothing else in src.",
      severity: "error",
      from: {
        path: ["^src/app/page\\.tsx$", "^src/app/.*/page\\.tsx$", "^src/app/.*actions\\.ts$"],
        pathNot: ["^src/app/approve/\\[token\\]/", "^src/app/setup/", "^src/app/sign-in/"],
      },
      to: {
        path: "^src/",
        pathNot: [
          "^src/modules/[^/]+/index\\.ts$",
          "^src/app/",
          "^src/components/",
          "^src/shared/kernel/",
          "^src/shared/lib/(result|search-params)\\.ts$",
          "^src/lib/(format|color|brand-mark|log)\\.ts$",
        ],
      },
    },
    {
      name: "components-not-to-server",
      severity: "error",
      from: { path: "^src/(components|shared/ui)/" },
      to: {
        path: [
          "^src/server/",
          "^src/db/",
          "^src/app/",
          "^src/modules/[^/]+/(application|infrastructure)/",
          "^src/shared/lib/(db/|unit-of-work\\.ts$|admin-access\\.ts$)",
          "^src/lib/(env|auth)\\.ts$",
        ],
      },
    },
    {
      name: "application-not-to-concrete-infrastructure",
      severity: "error",
      from: { path: ["^src/modules/[^/]+/application/", "^src/shared/lib/(unit-of-work|admin-access)\\.ts$"] },
      to: { path: ["^src/db/(index|connect)", "^src/lib/(env|auth|mail)", "node_modules/(nodemailer|better-auth|next|postgres|@electric-sql)/"] },
    },
    {
      name: "vendor-sdk-only-in-infrastructure",
      comment: "Only the named infrastructure files may import a vendor SDK; any other src/lib utility is checked.",
      severity: "error",
      from: {
        path: "^src/",
        pathNot: [
          "^src/db/",
          "^src/lib/(auth|auth-client)\\.ts$",
          "^src/lib/mail/smtp\\.ts$",
          "^src/server/(runtime\\.ts$|admin/|identity/)",
          // The shared repository helpers (recordChange, keyset pages, driver errors) are infrastructure too.
          "^src/shared/lib/db/",
          "^src/modules/[^/]+/infrastructure/",
        ],
      },
      to: { path: "node_modules/(nodemailer|better-auth|@better-auth|postgres|@electric-sql|drizzle-orm)/" },
    },
    {
      name: "admin-db-only-from-scripts",
      comment: "The database owner's connection (src/server/admin) is for migrate, seed and the import scripts; nothing in src imports it (ADR-0006).",
      severity: "error",
      from: { path: "^src/", pathNot: "^src/server/admin/" },
      to: { path: "^src/server/admin/" },
    },
    // Module boundaries (F9). Two rules, because only `from.path` can capture a group: `$1` in `to` is the module
    // the import starts in, so a module's own files stay reachable and every other module only through index.ts.
    {
      name: "no-deep-import-from-outside",
      comment: "Code outside src/modules imports a module only through its index.ts (ADR-0009).",
      severity: "error",
      from: { path: "^src/", pathNot: "^src/modules/" },
      to: { path: "^src/modules/[^/]+/.+", pathNot: "^src/modules/[^/]+/index\\.ts$" },
    },
    {
      name: "no-deep-import-across-modules",
      comment: "A module imports another module only through that module's index.ts (ADR-0009).",
      severity: "error",
      from: { path: "^src/modules/([^/]+)/" },
      to: { path: "^src/modules/[^/]+/.+", pathNot: ["^src/modules/$1/", "^src/modules/[^/]+/index\\.ts$"] },
    },
    // Layers inside a module (F10): one rule name, several shapes; $1 is the module the import starts in.
    // Tier 2 application code calls its own infrastructure (repositories) directly; Tier 3 goes through ports.
    {
      name: "module-layers",
      comment: "A module's domain imports none of its application, infrastructure or ui.",
      severity: "error",
      from: { path: "^src/modules/([^/]+)/domain/" },
      to: { path: "^src/modules/$1/(application|infrastructure|ui)/" },
    },
    {
      name: "module-layers",
      comment: "A module's application and infrastructure never import its ui.",
      severity: "error",
      from: { path: "^src/modules/([^/]+)/(application|infrastructure)/" },
      to: { path: "^src/modules/$1/ui/" },
    },
    {
      name: "module-layers",
      comment: "A module's ui never imports its infrastructure: it renders what application returns.",
      severity: "error",
      from: { path: "^src/modules/([^/]+)/ui/" },
      to: { path: "^src/modules/$1/infrastructure/" },
    },
    {
      name: "module-layers",
      comment: "In a Tier 3 module, application reaches infrastructure only through its ports, wired in the composition root.",
      severity: "error",
      from: { path: "^src/modules/(leave|approvals|balances)/application/" },
      to: { path: "^src/modules/$1/infrastructure/" },
    },
  ],
  options: {
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    doNotFollow: { path: "node_modules" },
    includeOnly: "^(src|node_modules)",
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "require", "node", "default", "types"] },
  },
};
