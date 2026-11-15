# ADR-0005: Server-side identity verification with Better Auth

- **Status:** Proposed
- **Date:** 2026-11-15

## Context

The reference forbids trusting Supabase `getSession()` on the server and asks for `getClaims()`/`getUser()`, auth
inside every action and route handler, and no middleware-only auth. OOOhm uses Better Auth (magic link, optional
Google, passkeys). `currentUser()` calls `auth.api.getSession()`, which with the cookie cache **off** (Better Auth's
default, and OOOhm's setting) reads the `session` table on every request: it is a server-verified lookup, the
equivalent of `getUser()`. There is no Next.js proxy/middleware. The auth mount route
`src/app/api/auth/[...all]/route.ts` imports `better-auth/next-js`, and `src/lib/auth.ts` imports Drizzle for the
Better Auth adapter and the session hook.

## Decision

- `requireActor()` / `currentUser()` stay the only identity entry points; they move to `src/server/identity/`.
- Better Auth's `session.cookieCache` stays **off**. Turning it on needs a new ADR (it would make `getSession` trust a
  signed cookie for its lifetime, as Supabase's `getSession` does). A unit test pins the setting.
- Every server action goes through the authenticated pipeline; the two token-credentialed actions (email approve,
  first-install setup) are allow-listed with the service that verifies their token.
- If a Next.js proxy is ever added it does optimistic redirects only; authorization stays in the use case.
- The auth mount route and the Better Auth adapter are accepted vendor edges in the dependency-cruiser config.

## Consequences

- One database read per request for the session (already the case).
- Deactivated people lose access immediately (the session hook refuses them; no stale cookie window).
