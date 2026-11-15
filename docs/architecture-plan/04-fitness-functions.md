# 4. Fitness functions and CI

Every rule in the reference becomes an automated check. Each starts with a **baseline** of today's violations and
fails CI only on new ones (reference §28, the Packwerk approach). The baseline shrinks phase by phase until it is
empty at A8.

## 4.1 The checks

| # | Check | Tool | Added | Strict (empty baseline) by |
| --- | --- | --- | --- | --- |
| F1 | Domain imports nothing outside its domain (no `next/*`, `drizzle-orm`, `better-auth`, `node:*`) | dependency-cruiser + existing ESLint zone | A0 | A0 (0 today) |
| F2 | `src/app` never imports repositories, `src/db` runtime, Drizzle or a module's `infrastructure/` | dependency-cruiser | A0 | A0 (0 today) |
| F3 | Vendor SDKs only in infrastructure (`src/db`, repositories / `modules/*/infrastructure`, `server/identity`, `server/admin`, runtime) | dependency-cruiser | A0 | A0 (2 accepted edges, ADR-0005) |
| F4 | `no-circular: error` | dependency-cruiser + `madge --circular` | A0 | A1 (5 today) |
| F5 | `import "server-only"` in every server file | `tests/architecture/server-only.test.ts` | A0 | A1 (~120 files today) |
| F6 | Every exported server action goes through the authenticated pipeline | `tests/architecture/actions-are-guarded.test.ts` | A0 | A0 (2 allow-listed token actions) |
| F7 | Every route handler authenticates or is on the public list | `tests/architecture/routes-are-guarded.test.ts` | A0 | A0 |
| F8 | Size limits: action/route file ≤ 100 lines; function ≤ 50 (server, domain, actions, routes); use-case file ≤ 500; `.tsx` function ≤ 150 | ESLint `max-lines`, `max-lines-per-function` | A0 (warn) | A7 (error) |
| F9 | Cross-module imports only through `@/modules/<m>` (`index.ts`) | dependency-cruiser `no-deep-import-from-outside`, `no-deep-import-across-modules` | A2 | A6 |
| F10 | Layers inside a module (`ui → application → domain`, `infrastructure → application/domain`) | dependency-cruiser `module-layers` | A2 | A6 |
| F11 | No `Row` / `$inferSelect` type exported from a module's `index.ts` | `tests/architecture/no-rows-exported.test.ts` (TypeScript compiler API) | A2 | A7 |
| F12 | `actions.ts` imports only `@/modules/*`, `@/app/_lib/*`, `zod` | dependency-cruiser | A7 | A7 |
| F13 | Event payloads match their recorded contracts | `tests/contracts/*` | A3 / A6 | A6 |
| F14 | Tenant isolation for every repository function | `tests/integration/tenancy.test.ts` | A8 | A8 |
| F15 | No schema drift (`drizzle-kit generate` produces nothing) | integration test + CI step | A8 | A8 |
| F16 | No secret reaches the client bundle (`grep` `.next/static` for `BETTER_AUTH_SECRET`, `WEBHOOK_ENCRYPTION_KEY`, `CRON_SECRET` values set to sentinels in the CI build) | CI step | A0 | A0 |
| F17 | `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` in `src` | `tsc -p tsconfig.src.json` | A8 | A8 |
| F18 | Better Auth `cookieCache` stays off unless an ADR says otherwise | `tests/unit/auth-config.test.ts` | A0 | A0 |

## 4.2 CI pipeline (A0)

`.github/workflows/ci.yml`, required on `main`:

1. `pnpm install --frozen-lockfile`
2. `pnpm typecheck`
3. `pnpm lint` (includes the size warnings; errors from A7)
4. `pnpm arch` (dependency-cruiser with `--ignore-known`) and `pnpm madge` (cycles)
5. `pnpm test` (unit + `tests/architecture`)
6. `pnpm test:integration:embedded` (PGlite)
7. `pnpm test:integration` against a `postgres:16` service container
8. `pnpm build` with sentinel secrets, then the bundle-secret grep (F16)
9. From A7: component tests; from A8: Playwright on `pnpm start:embedded`, drift check

Vercel keeps deploying on merge; CI gates the merge.

## 4.3 Draft dependency-cruiser config

The A0 config, written against today's paths. A2 adds the module rules (F9, F10) and A6 removes the
`src/server/services` paths once they are gone.

```js
// .dependency-cruiser.cjs (draft)
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    { name: "no-circular", severity: "error", from: {}, to: { circular: true } },
    {
      name: "domain-is-pure",
      comment: "Domain code imports only domain code and the shared Result type (reference §2, ADR-0003).",
      severity: "error",
      from: { path: "^src/(domain|modules/[^/]+/domain|shared/kernel)/" },
      to: { pathNot: ["^src/(domain|modules/[^/]+/domain|shared/kernel)/", "^src/shared/lib/result\\.ts$"] },
    },
    {
      name: "app-not-to-infrastructure",
      comment: "Pages, actions and routes call services/modules, never the database (layer skipping).",
      severity: "error",
      from: { path: "^src/app/" },
      to: { path: ["^src/server/repositories/", "^src/modules/[^/]+/infrastructure/", "^src/db/(index|connect|schema)", "node_modules/(drizzle-orm|postgres)/"] },
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
      severity: "error",
      from: { path: "^src/", pathNot: "^src/(lib|db|server/(repositories|runtime\\.ts|admin|identity)|modules/[^/]+/infrastructure)" },
      to: { path: "node_modules/(nodemailer|better-auth|postgres|@electric-sql|drizzle-orm)/" },
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
```

## 4.4 Baseline measured on 2026-11-15

| Rule | Violations |
| --- | ---: |
| `no-circular` | 5 cycles (6 edges reported) |
| `domain-is-pure` | 0 |
| `app-not-to-infrastructure` | 1 (`api/auth/[...all]` → `better-auth/next-js`, accepted) |
| `components-not-to-server` | 0 |
| `application-not-to-concrete-infrastructure` | 0 |
| `vendor-sdk-only-in-infrastructure` | 1 (`lib/auth.ts` → `drizzle-orm`, accepted: it is infrastructure) |
| Informational: service → repository edges | 165 |
| Informational: service → service edges | 101 |
| Files without `server-only` under `src/server`, `src/db`, server `src/lib` | ~120 |
| Service functions > 50 lines | 25 |
| Action/route files > 100 lines | 2 |

### How the baseline was measured

```bash
pnpm install --frozen-lockfile
npx dependency-cruiser@16 src -c .dependency-cruiser.cjs -T err      # rule counts
npx madge@8 --circular --extensions ts,tsx --ts-config tsconfig.json src
npx tsc --noEmit --noUncheckedIndexedAccess | grep -c "error TS"      # per flag
npx tsc --noEmit --exactOptionalPropertyTypes | grep -c "error TS"
# function lengths: TypeScript compiler API walk over src (function, arrow, method nodes), > 50 lines
for f in $(find src/server src/db src/lib -name '*.ts'); do grep -q server-only "$f" || echo "$f"; done
```

## 4.5 Keeping tooling light

Shopify's own retrospective warns boundary tooling can become the burden. So: one config file, no custom plugins,
every allow-list entry carries a one-line reason and an ADR or phase that removes it, and the architecture tests
are ordinary `node:test` files a person can read.
