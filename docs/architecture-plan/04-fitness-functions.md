# 4. Fitness functions and CI

Every rule in the reference becomes an automated check. Each starts with a **baseline** of today's violations and
fails CI only on new ones (reference §28, the Packwerk approach). The baseline shrinks phase by phase until it is
empty at A8.

**Status after A8:** every baseline is empty and gone. There is no `.dependency-cruiser-known-violations.json` and
no `pnpm arch:baseline`; `pnpm arch` runs without `--ignore-known`, so any violation fails it
(`tests/architecture/baselines.test.ts`). The server-only check (F5) has no allow-list. F17 is part of
`pnpm typecheck` (the base `tsconfig.json`, `tests/architecture/strict-typescript.test.ts`), for tests and scripts
as well as `src`.

## 4.1 The checks

| # | Check | Tool | Added | Strict (empty baseline) by |
| --- | --- | --- | --- | --- |
| F1 | Domain imports nothing outside its domain (no `next/*`, `drizzle-orm`, `better-auth`, `node:*`) | dependency-cruiser + existing ESLint zone | A0 | A0 (0 today) |
| F2 | `src/app` never imports repositories, anything in `src/db` but its types, a database or auth SDK, or a module's `infrastructure/` | dependency-cruiser | A0 | A0 (1 accepted edge: the Better Auth mount route, ADR-0005) |
| F3 | Vendor SDKs only in infrastructure (`src/db`, `lib/auth`, `lib/auth-client`, `lib/mail/smtp`, repositories / `modules/*/infrastructure`, `server/identity`, `server/admin`, runtime; no blanket `src/lib` exemption) | dependency-cruiser | A0 | A0 (1 accepted edge, ADR-0005) |
| F4 | `no-circular: error` | dependency-cruiser (A0, baselined); `madge --circular` joins in A1, once it reports 0 | A0 | A1 (5 today) |
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
| F15 | No drift between `schema.ts` and committed migrations (`drizzle-kit generate` produces nothing); live Neon drift by a scheduled `pg_dump --schema-only` comparison | integration test + CI step; scheduled job | A8 | A8 |
| F16 | No secret reaches the client bundle (`grep` `.next/static` for `BETTER_AUTH_SECRET`, `WEBHOOK_ENCRYPTION_KEY`, `CRON_SECRET` values set to sentinels in the CI build) | CI step | A0 | A0 |
| F17 | `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` across the repository | `tsc --noEmit` (`tsconfig.json`) | A8 | A8 |
| F18 | Better Auth `cookieCache` stays off unless an ADR says otherwise | `tests/unit/auth-config.test.ts` | A0 | A0 |

## 4.2 CI pipeline (A0)

`.github/workflows/ci.yml`, required on `main`:

1. `pnpm install --frozen-lockfile`
2. `pnpm typecheck` (with the strict flags for the whole repository from A8, F17)
3. `pnpm lint` (includes the size warnings; errors from A7)
4. `pnpm arch` (dependency-cruiser; with `--ignore-known` until A8 emptied the baseline, without it since) (cycles are enforced here); from A1 also `pnpm madge`, which has no baseline and runs once the cycles are gone
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

Measured with **exactly** the draft config above (dependency-cruiser 16, 395 modules, 2,111 dependencies, 8 reported
violations: 6 cycle edges and the one accepted auth-route edge, which two rules report).

| Rule | Violations |
| --- | ---: |
| `no-circular` | 5 cycles (6 edges reported) |
| `domain-is-pure` | 0 |
| `app-not-to-infrastructure` | 1 (`api/auth/[...all]` → `better-auth/next-js`, accepted, ADR-0005) |
| `components-not-to-server` | 0 |
| `application-not-to-concrete-infrastructure` | 0 |
| `vendor-sdk-only-in-infrastructure` | 1 (the same `api/auth/[...all]` edge; `lib/auth.ts` → `drizzle-orm` is allowed because the rule names `lib/auth.ts` as infrastructure) |
| `module-domain-is-pure` | 0 (no modules yet; checked on a fixture: `leave/domain` → `approvals/domain` is reported) |
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
