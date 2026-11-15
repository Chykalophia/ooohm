// Dependency rules for OOOhm (docs/architecture-plan/04-fitness-functions.md, ADR-0012).
// `pnpm arch` fails on any violation not recorded in .dependency-cruiser-known-violations.json.
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    { name: "no-circular", severity: "error", from: {}, to: { circular: true } },
    {
      name: "domain-is-pure",
      comment: "Today's domain and the shared kernel import only each other and the shared Result type (reference §2, ADR-0003).",
      severity: "error",
      from: { path: "^src/(domain|shared/kernel)/" },
      to: { pathNot: ["^src/(domain|shared/kernel)/", "^src/shared/lib/result\\.ts$"] },
    },
    {
      name: "module-domain-is-pure",
      comment: "A module's domain imports only its own domain, the kernel and Result; never another module's domain. $1 is the module the import starts in.",
      severity: "error",
      from: { path: "^src/modules/([^/]+)/domain/" },
      to: { pathNot: ["^src/modules/$1/domain/", "^src/shared/kernel/", "^src/shared/lib/result\\.ts$"] },
    },
    {
      name: "app-not-to-infrastructure",
      comment: "Pages, actions and routes call services/modules, never the database or the auth SDK (layer skipping).",
      severity: "error",
      from: { path: "^src/app/" },
      to: {
        path: ["^src/server/repositories/", "^src/modules/[^/]+/infrastructure/", "^src/db/", "node_modules/(drizzle-orm|postgres|@electric-sql|better-auth|nodemailer)/"],
        pathNot: "^src/db/types\\.ts$",
      },
    },
    {
      name: "components-not-to-server",
      severity: "error",
      from: { path: "^src/(components|shared/ui)/" },
      to: { path: ["^src/server/", "^src/db/", "^src/app/", "^src/modules/[^/]+/(application|infrastructure)/", "^src/lib/(env|auth)\\.ts$"] },
    },
    {
      name: "application-not-to-concrete-infrastructure",
      severity: "error",
      from: { path: "^src/(server/services|modules/[^/]+/application)/" },
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
          "^src/server/(repositories/|runtime\\.ts$|admin/|identity/)",
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
    // Added in A2. Two rules, because only `from.path` can capture a group: `$1` in `to` refers to the module the
    // import starts in, so a module's own layers stay reachable and every other module only through index.ts.
    // (Checked on a fixture tree with dependency-cruiser 16 before this plan was written.)
    // { name: "no-deep-import-from-outside", severity: "error",
    //   from: { path: "^src/", pathNot: "^src/modules/" },
    //   to: { path: "^src/modules/[^/]+/.+", pathNot: "^src/modules/[^/]+/index\\.ts$" } },
    // { name: "no-deep-import-across-modules", severity: "error",
    //   from: { path: "^src/modules/([^/]+)/" },
    //   to: { path: "^src/modules/[^/]+/.+", pathNot: ["^src/modules/$1/", "^src/modules/[^/]+/index\\.ts$"] } },
    // { name: "module-layers", ... }
  ],
  options: {
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    doNotFollow: { path: "node_modules" },
    includeOnly: "^(src|node_modules)",
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "require", "node", "default", "types"] },
  },
};
