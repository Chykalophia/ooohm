# OOOhm integration API

OOOhm gives other systems three ways in, all scoped to one company:

- **Webhooks**: OOOhm POSTs a signed JSON event to your endpoint when something changes.
- **REST API** (`/api/v1`): read people, leave types, leave requests, balances, holidays, and replay events.
- **Adapters**: built-in connectors that live in OOOhm's code. None ship in v1; the seam is described in
  [architecture.md](architecture.md#integrations-m6).

Every event, whichever way it reaches you, has the same envelope and the same payloads (below). The
machine-readable description of the REST API is served at `GET /api/v1/openapi.json` (OpenAPI 3.1).

## Authentication

An admin creates keys under **Admin → Integrations → API keys**. A key looks like `ooohm_` followed by 43 characters, and is
shown once: OOOhm keeps only its SHA-256, so a lost key cannot be recovered, only revoked and replaced.

```bash
curl -H "Authorization: Bearer ooohm_..." https://ooohm.example.com/api/v1/users
```

- A key can read everything in its company and change nothing (scope `read`; `write` is reserved for later).
- A key belongs to the company, not to the admin who made it. Deactivating that admin does not revoke it, but
  the deactivation result tells you how many live keys (and webhook endpoints) they created, so you can revoke
  or replace them. Revoke keys you no longer use; the list shows who made each and when it was last used.
- No key, a malformed one, an unknown one and a revoked one all get the same `401` with
  `WWW-Authenticate: Bearer realm="OOOhm API"`, so a response never says which.

## Requests and responses

- Every response is JSON with `Cache-Control: no-store`.
- Dates are `YYYY-MM-DD`; instants are ISO 8601 in UTC. Day amounts are numbers with one decimal (a half day
  is `0.5`).
- Unknown query parameters are ignored; a malformed known one is a `400` that names it.

### Errors

```json
{ "error": { "code": "invalid_request", "message": "Invalid query parameter: limit." } }
```

| Status | `code` | When |
| --- | --- | --- |
| 400 | `invalid_request` | A query parameter or cursor is not valid (the message says which) |
| 401 | `unauthorized` | No valid key |
| 403 | `forbidden` | The key lacks the scope the endpoint needs |
| 429 | `rate_limited` | Too many requests; wait `Retry-After` seconds |
| 500 | `internal_error` | Something failed on OOOhm's side; retry |

### Rate limits

Each key may make **120 requests a minute**; beyond that the API answers `429` with `Retry-After: 60` until the
minute is over. Requests without a valid key are limited too: **30 a minute per client address**, after which
they get `429` instead of `401` (a valid key from the same address is unaffected). This limit caps guessing; it
does not save the lookup, which is one index probe either way. Unless the operator has set `TRUSTED_PROXY_HOPS`,
every caller counts as one address, so a burst of bad keys from anyone can turn your `401` into `429` for a
minute: if you get `429` with a key you expect to work, check the key.

The counters live in the app's memory. OOOhm runs as one server process, so they are exact; they reset when the
app restarts, and if you ever run several app instances each counts on its own. Client addresses come from
`X-Forwarded-For` only as far as `TRUSTED_PROXY_HOPS` allows (see the README).

### Pagination

`/users`, `/leave-requests` and `/events` are paged. Pass `limit` (1 to 200, default 100). Lists answer
`{ "data": [...], "nextCursor": "..." }`; pass `nextCursor` back as `cursor` for the next page, until it is
`null`. Cursors are opaque: don't build or edit them. Pages are keyset pages, so rows added while you page are
neither skipped nor repeated. `/events` pages with `after` instead (below).

## Endpoints

| Endpoint | Parameters | Returns |
| --- | --- | --- |
| `GET /api/v1/users` | `cursor`, `limit` | People, active and not, by id: `id, name, email, department {id, name} \| null, managerId, role, isActive, createdAt`. Deleted people are not listed (see `user.deleted`); leave requests they kept still name their id |
| `GET /api/v1/leave-types` | | Every leave type, archived ones flagged: `id, code, name, color, isPaid, countsAgainstAllowance, defaultAllowanceDays, carryoverEnabled, carryoverMaxDays, sortOrder, archived` |
| `GET /api/v1/leave-requests` | `from`, `to`, `userId`, `status`, `cursor`, `limit` | Requests overlapping `[from, to]` (either optional), by start date then id: `id, userId, leaveTypeId, startDate, endDate, dayPortion, days, status, approverId, decidedAt, createdAt, updatedAt` |
| `GET /api/v1/balances` | `year`, `userId` | `{ year, data }`: one balance per person and leave type (below). A person deleted with their records kept still has theirs (`userId` of that tombstone); a scrubbed person has none (no rows) |
| `GET /api/v1/holidays` | `year` | `{ year, data }`: `id, date, name`, by date |
| `GET /api/v1/events` | `after`, `limit` | `{ data, hasMore }`: event envelopes (below) |
| `GET /api/v1/openapi.json` | | The OpenAPI 3.1 document (no key needed) |

`year` defaults to the current year in the company's time zone.

**Notes are never returned.** A request's note and an approver's decision note stay between the person and
their approver, as on every calendar and feed in OOOhm. An API key is a company-wide machine
credential, so it gets the same view as the team calendar plus status and day counts.

**Balances** list every active person (or, with `userId`, that one person, active or not) and every active
leave type, plus an archived type where the person has an allowance or booked days that year. They are computed
exactly as the dashboard computes them:

| Field | Meaning |
| --- | --- |
| `tracked` | `false` for an unlimited type: then only `used` and `pending` are numbers, the rest `null` |
| `allowance` | The year's base allowance |
| `carriedOver`, `adjustment` | Carried in from last year; an admin's correction |
| `total` | `allowance + carriedOver + adjustment` |
| `used`, `pending` | Approved and pending days in the year |
| `carriedOut` | Days already carried into next year |
| `remaining` | `total - used - pending - carriedOut`; negative if an allowance was lowered after booking |

## Events

### Envelope

```json
{
  "id": "6e703ccd-f3ad-4960-b62c-f80dfa6b2b68",
  "type": "leave.approved",
  "version": 1,
  "createdAt": "2026-11-02T15:04:05.123Z",
  "companyId": "e24b2035-464a-41c7-839d-095328689365",
  "data": { "...": "the payload for this type" }
}
```

- `id` is unique per event (the outbox row's id). **Delivery is at least once**: the same event can arrive more
  than once (a retry after a timeout whose request did land, a redelivery). Dedupe on `id`.
- `version` is the envelope and payload version. Fields may be **added** to a payload within version 1; none is
  renamed, removed or retyped. Ignore fields you don't know.
- Order is not guaranteed across webhook deliveries (retries interleave). Use `createdAt` and the payload's own
  fields, such as `status`, to decide what is newest.

### Types and payloads (version 1)

Ids are strings. Every payload says who or what made the change in two fields:

- **`actor`** (added within version 1) names it exactly, as one of:

  ```text
  { "type": "user", "id": "<user id>", "via": "adapter_sync:gusto" }
  { "type": "api_key", "id": "<user id>", "apiKeyId": "<key id>", "via": "timeoff_import" }
  { "type": "system", "process": "year_rollover" }
  { "type": "system", "process": "scheduled_scrub", "requestedBy": "<user id>" }
  ```

  `user` is a person; `via` is present only when they acted through something they started (an integration's
  sync when they pressed **Sync now**, or a one-time import they ran, `timeoff_import`). `api_key` is a change made with an API key: `id` is the person who created
  the key (the v1 API is read-only, so none are sent yet). `system` is a process with no person behind it;
  `requestedBy` (added within version 1) is present when a person asked for that run ahead of time (an admin who
  scheduled a deletion), and is not the actor.
  `via` and `process` are stable identifiers: `year_rollover`, `retention`, `timeoff_import`, `scheduled_scrub`, and
  `adapter_sync:<adapterId>` (a scheduled sync when it is a `process`). Expect more; treat an unknown one as
  opaque.
- **`actorId`** is kept for compatibility: the person, when there is one (`actor.id`), or `null` for a `system`
  change. Prefer `actor`.

For example, the year rollover's `balance.adjusted` carries `"actorId": null, "actor": { "type": "system",
"process": "year_rollover" }`.

**Leave**

| Type | When |
| --- | --- |
| `leave.requested` | A request is submitted (also for self-approved ones, followed by `leave.approved`) |
| `leave.approved` | An approver or admin approves, or a request is self-approved |
| `leave.rejected` | An approver or admin declines |
| `leave.cancelled` | The requester cancels a pending or approved request. Approved leave that ended before the current year (in the company's time zone) cannot be cancelled, so no `leave.cancelled` follows for it |
| `leave.reassigned` | A pending request moves to another approver (adds `previousApproverId`, `approverId`) |

Payload: `requestId, userId, leaveTypeId, startDate, endDate, dayPortion ("full" | "am" | "pm"), days, status, actorId, actor`.

**Balances**

| Type | When |
| --- | --- |
| `balance.adjusted` | An allowance row changed: `reason` is `carryover` or `allowance_created` (year rollover), `admin_edit` (an admin), or `sync` (an adapter) |

Payload: `allowanceId, userId, leaveTypeId, year, days, carriedOverDays, adjustmentDays, reason, actorId, actor` (the
row after the change).

**People**

| Type | When |
| --- | --- |
| `user.created` | An admin invites someone, or an adapter's sync adds them |
| `user.updated` | Name, department, manager, role or self-approval changed |
| `user.deactivated`, `user.reactivated` | |
| `user.invite_resent` | An admin sent a new sign-in link |

Payload: `userId, email, name, role, departmentId, managerId, canSelfApprove, isActive, actorId, actor` (the person
after the change). It never holds a session, token or sign-in link.

**Deleting people** (added in M8)

| Type | When | Payload |
| --- | --- | --- |
| `user.deletion_scheduled` | An admin asked for a full scrub and the company waits 7 days first (its grace option) | `userId, scheduledFor, actorId, actor` |
| `user.deletion_cancelled` | An admin undid a scheduled scrub, or reactivated the person | `userId, scheduledFor, actorId, actor` |
| `user.deleted` | A person was deleted | `userId, mode ("scrubbed" \| "records_kept"), deletedAt, actorId, actor` |

None of these carries a name or email. **The contract for `user.deleted`:**

- **`mode: "scrubbed"`**: OOOhm removed everything about the person: their leave, balances, the audit entries about
  them, and their name and email from every stored event. **Erase your own copy of the person** (and anything you
  derived from OOOhm about them). Events you receive later, and redeliveries, may still name `userId`, which now
  belongs to a tombstone ("Former employee #…", email `deleted+<id>@invalid`); treat it as no one.
- **`mode: "records_kept"`**: their account and email are gone; their history stays in OOOhm under "<Name>
  (deleted)". Any request of theirs still pending is withdrawn as part of the delete (status `cancelled`, with no
  `leave.cancelled` event of its own): treat their pending leave as cancelled. Remove the address and any sign-in or
  contact data you keep for them; keep history if you need it. The same address may come back later in a
  `user.created` for a **new** `userId`: it is a different person record, with no link to the old one.
- Undelivered events about them are redacted before they are sent, so a retry after the delete no longer carries
  their name (scrubbed) or email (either mode). Events you already received are yours to erase, and so is an event
  whose delivery was already in flight when the delete committed: it may reach you twice under the same event `id`,
  first as it was, then redacted.
- `actor` is the admin, or, for a scrub that waited out the grace period, `{ "type": "system", "process":
  "scheduled_scrub", "requestedBy": "<admin id>" }` with `actorId: null`.
- After a delete, `GET /api/v1/users` no longer lists them.

**Company setup**

| Type | Payload |
| --- | --- |
| `department.created`, `.renamed`, `.deleted` | `departmentId, name, actorId, actor` |
| `leave_type.created`, `.updated`, `.archived`, `.unarchived`, `.reordered` | `leaveTypeId, code, name, color, isPaid, countsAgainstAllowance, defaultAllowanceDays, carryoverEnabled, carryoverMaxDays, sortOrder, archived, actorId, actor` |
| `holiday.created`, `.renamed`, `.deleted` | `holidayId, date, name, actorId, actor` |
| `company.updated` | `companyId, name, timezone, workingDays, allowancePolicy, deletionGrace (added within version 1), actorId, actor` |

**Calendar links**

| Type | Payload |
| --- | --- |
| `calendar_feed.issued`, `calendar_feed.revoked` | `feedId, userId, kind ("personal" \| "team"), reason (null, "regenerated", "turned_off", "deactivated"), actorId, actor` |

Never the link or its hash.

**Integrations**

| Type | Payload |
| --- | --- |
| `webhook_endpoint.created`, `.updated`, `.enabled`, `.disabled`, `.secret_rotated`, `.deleted`, `.pinged` | `endpointId, urlOrigin, description, eventTypes, enabled, actorId, actor` |
| `webhook_endpoint.updated` also | `urlChanged` (boolean): the full URL changed, even if `urlOrigin` did not |
| `webhook_delivery.redelivered` | `endpointId, deliveryId, eventId, eventType, actorId, actor` |
| `api_key.created`, `api_key.revoked` | `apiKeyId, name, prefix, scopes, actorId, actor` |

`urlOrigin` is only the scheme and host (`https://hooks.example.com`): endpoint paths often carry a token. A move
to another path on the same host shows as `urlChanged: true` on `webhook_endpoint.updated` (a field added within
version 1, as the versioning rule above allows). Never the path itself, a hash of it, the signing secret, an API
key or its hash.

**Imports** (added in M7)

| Type | When | Payload |
| --- | --- | --- |
| `import.completed` | A one-time import from another leave tracker (v1: TimeOff.Management) committed | `importRunId, source ("timeoff"), sourceSha256, counts {people, departments, leaveTypes, holidays, allowances, leaveRequests}, mismatches, actorId, actor` |

An import does **not** send the history it brings in: no `leave.*`, `user.created` or `balance.adjusted` event
for any imported request, person or allowance, nor for a carried-over amount the import corrects while it runs
(audited inside OOOhm only). That history predates the integration, and replaying thousands of
past events would look like new activity to every receiver. A system that mirrors OOOhm should treat
`import.completed` as "resync": read `/api/v1/users`, `/api/v1/leave-requests` and `/api/v1/balances` again.
Events after the import are sent as usual. The payload holds counts and the source file's SHA-256 only, never a
name or email. `mismatches` is the number of person-years whose balance differed from the source's and was
committed anyway (only with `--accept-mismatch`; normally 0). An import is started by a person, so `actorId` is
the admin who ran it and `actor` is `{ "type": "user", "id": "<that admin>", "via": "timeoff_import" }`.

**Test event**

| Type | Payload |
| --- | --- |
| `ping` | `endpointId, message`. Sent only to the endpoint an admin tested, whatever it subscribes to. Its `id` is generated, not an outbox id, and it never appears in `/events`. |

### Replaying events (`GET /api/v1/events`)

For integrations that poll instead of (or as well as) receiving webhooks. Start without `after`; then pass the
`id` of the last event you processed as `after`, and repeat while `hasMore` is true.

The order is safe to poll: a later call never returns an event that sorts before one you already received. An
event appears once every database transaction that started before it has finished (normally within
milliseconds), so a slow transaction cannot commit an event behind your cursor. Postgres tracks this across
the **whole database server**, not just OOOhm's database: a long-running writing transaction anywhere on the
same server (another application's batch job, or a session left idle in a transaction) holds new events back
until it ends. Webhooks are not affected. If you operate OOOhm, prefer a dedicated Postgres server, or set
`idle_in_transaction_session_timeout` on a shared one. An `after` that is not an
event of your company, or one removed by retention, is a `400`: start again without `after` and dedupe on `id`.
Events are kept **90 days**.

## Webhooks

An admin adds endpoints under **Admin → Integrations → Webhooks**: a URL, an optional description, and the event types to
send (leave, balances and people are ticked by default). Each endpoint gets events written **after** it was
added, never older ones.

### The request

```http
POST /your/path HTTP/1.1
Content-Type: application/json
User-Agent: OOOhm-Webhooks/1
OOOhm-Event-Id: 6e703ccd-f3ad-4960-b62c-f80dfa6b2b68
OOOhm-Event-Type: leave.approved
OOOhm-Timestamp: 1793588645
OOOhm-Signature: v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd

{"id":"6e703ccd-...","type":"leave.approved","version":1,"createdAt":"...","companyId":"...","data":{...}}
```

Answer any `2xx` within **10 seconds** to acknowledge it. Do slow work after answering.

### Retries

Anything else is a failed attempt: a non-2xx status (redirects included: OOOhm never follows them), a timeout, a
refused or unreachable address. OOOhm tries again after 1 minute, 5 minutes, 30 minutes, 2 hours, 6 hours,
12 hours and 24 hours (each moved by up to 10% either way), so **8 attempts over about 45 hours**, then marks the
delivery failed. The endpoint's page lists recent deliveries with their status, attempts, last status code and a
short error, and **Send again** queues a finished one again (same event id and body, a fresh set of attempts).
**Send test event** queues a `ping`.

Turning an endpoint off stops new deliveries to it; queued ones wait and go out when it is turned back on.
Deleting it cancels anything still queued.

### Verifying the signature

Each endpoint has a signing secret (`whsec_...`), shown once when the endpoint is added or the secret is
replaced. OOOhm keeps it encrypted (AES-256-GCM) and never shows it again.

`OOOhm-Signature` is `v1=` followed by the lowercase hex HMAC-SHA256 of `` `${timestamp}.${rawBody}` ``, keyed
with the whole secret string (UTF-8, `whsec_` included), where `timestamp` is the `OOOhm-Timestamp` header (unix
seconds, set fresh on every attempt) and `rawBody` is the request body exactly as received. To verify:

1. Read the **raw** body before any JSON parsing. Re-serialized JSON will not match.
2. Recompute the HMAC and compare it with every `v1=` value in the header (comma-separated; there is one today)
   in **constant time**.
3. Refuse a timestamp more than **5 minutes** from your clock, so a captured request cannot be replayed later.
4. Dedupe on `OOOhm-Event-Id`.

```js
import { createHmac, timingSafeEqual } from "node:crypto";

const TOLERANCE_SECONDS = 5 * 60;

/** @param rawBody the request body exactly as received (a string), before JSON.parse */
export function verifyOoohmWebhook({ secret, rawBody, headers }) {
  const timestamp = headers["ooohm-timestamp"];
  const signature = headers["ooohm-signature"];
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) return false;

  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest();
  return signature
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("v1="))
    .some((part) => {
      const given = Buffer.from(part.slice(3), "hex");
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
}
```

With Express, take the body with `express.raw({ type: "application/json" })` and pass `req.body.toString("utf8")`.

**Replacing the secret** (on the endpoint's page) takes effect at once: every attempt from then on, retries of
older events included, is signed with the new secret only. Update your receiver right after.

### What an endpoint may be

An `https://` URL on the public internet. OOOhm refuses `http://`, and addresses inside a private network:
loopback, private (10/8, 172.16/12, 192.168/16), shared, link-local (including the cloud metadata address
169.254.169.254), multicast and reserved ranges, in IPv4 and IPv6 (including IPv4-mapped forms like
`::ffff:127.0.0.1`, NAT64 and 6to4). When the endpoint is saved, IP literals and obviously local names (`localhost`,
`*.local`, names without a dot) are refused; the host name itself is **resolved at every delivery**, on the
very connection that is made, so a name that points (or later points) inside the network is refused then, and
the delivery list shows `blocked_address`. Responses are read up to 64 KB; only the first 200 characters are kept, for the
delivery list.

For local development only, `WEBHOOK_ALLOW_INSECURE=true` allows `http://` and `WEBHOOK_ALLOW_PRIVATE=true`
allows private addresses. Never set them in production.

### Try it locally

`tests/e2e/webhook-receiver.mts` is a small receiver that verifies every request with the steps above and
prints a line per event:

```bash
tsx tests/e2e/webhook-receiver.mts 4100 ./secret.txt        # answers 200
tsx tests/e2e/webhook-receiver.mts 4101 ./secret.txt fail   # answers 500, to watch the retries
```

Run the app and the worker with `WEBHOOK_ALLOW_INSECURE=true WEBHOOK_ALLOW_PRIVATE=true`, add an endpoint at
`http://127.0.0.1:4100/hook`, put its secret in `secret.txt`, and request some leave.

## Retention

Delivered, failed and cancelled deliveries, and dispatched events, are deleted after **90 days** by the
worker's daily retention job. The audit log is never pruned.
