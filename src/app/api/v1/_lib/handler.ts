import { z } from "zod";
import { isDomainError } from "@/domain/errors";
import type { ApiClient } from "@/domain/integrations";
import { apiKeyFromAuthorization } from "@/lib/integration-crypto";
import { log } from "@/lib/log";
import type { RateLimiter } from "@/lib/rate-limit";
import type { ServiceContext } from "@/server/context";
import { authenticateApiKey } from "@/server/services/api-keys";

/**
 * The shared body of every `/api/v1` route handler, with its dependencies injected so
 * it can be tested without Next: authentication, per-key rate limiting, the JSON error
 * shape and headers. Route files stay one line: parse the query, call one service.
 */

/** Requests per API key per minute. In process memory: see docs/api.md#rate-limits. */
export const REQUESTS_PER_KEY_PER_MINUTE = 120;
/** Requests per client address per minute that carry no valid key, before 401 turns into 429. */
export const UNAUTHORIZED_PER_CLIENT_PER_MINUTE = 30;
export const RETRY_AFTER_SECONDS = "60";

export interface ApiLimits {
  /** Keyed by the API key's id, after authentication. */
  perKey: RateLimiter;
  /** Keyed by client address; only requests without a valid key spend it. */
  unauthorized: RateLimiter;
}

/** Every `error.code` the API answers with; the OpenAPI document lists exactly these. */
export const API_ERROR_CODES = ["unauthorized", "forbidden", "invalid_request", "rate_limited", "internal_error"] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

const HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

export function apiJson(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...HEADERS, ...headers } });
}

export function apiError(status: number, code: ApiErrorCode, message: string, headers: Record<string, string> = {}): Response {
  return apiJson({ error: { code, message } }, status, headers);
}

const UNAUTHORIZED = () =>
  apiError(401, "unauthorized", "A valid API key is required: send Authorization: Bearer ooohm_...", {
    "WWW-Authenticate": 'Bearer realm="OOOhm API"',
  });
const TOO_MANY = () => apiError(429, "rate_limited", "Too many requests. Wait a minute, then try again.", { "Retry-After": RETRY_AFTER_SECONDS });

/** A query parameter that failed validation; answered with 400 naming it. */
export class InvalidQueryError extends Error {
  constructor(readonly params: string[]) {
    super(`Invalid query parameter${params.length === 1 ? "" : "s"}: ${params.join(", ")}.`);
    this.name = "InvalidQueryError";
  }
}

/** Parses the query string with `schema` (unknown parameters are ignored). @throws InvalidQueryError */
export function parseQuery<S extends z.ZodType>(schema: S, params: URLSearchParams): z.infer<S> {
  const parsed = schema.safeParse(Object.fromEntries(params));
  if (parsed.success) return parsed.data;
  throw new InvalidQueryError([...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "query")))]);
}

/**
 * Answers one API request:
 *
 * 1. No well-formed `Authorization: Bearer ooohm_<key>`, or a key that is unknown or
 *    revoked: 401 with no detail of which (or 429 once the client address has sent
 *    {@link UNAUTHORIZED_PER_CLIENT_PER_MINUTE} of them in a minute). A well-formed key
 *    always costs exactly one index lookup, found or not.
 * 2. More than {@link REQUESTS_PER_KEY_PER_MINUTE} requests from the key this minute: 429
 *    with `Retry-After: 60`.
 * 3. Otherwise `work`'s result as JSON, 200. A bad query is 400 naming the parameter;
 *    `invalid_input` from a service is 400 with its message; `forbidden` (a missing
 *    scope) is 403; anything unexpected is logged and answered 500 without detail.
 *
 * Every response is JSON with `Cache-Control: no-store`. The key is never logged.
 */
export async function handleApiRequest(
  input: { ctx: ServiceContext; headers: Headers; client: string; limits: ApiLimits; route: string },
  work: (client: ApiClient) => Promise<unknown>,
): Promise<Response> {
  const { ctx, limits } = input;
  let client: ApiClient | null = null;
  const key = apiKeyFromAuthorization(input.headers.get("authorization"));
  try {
    if (key) client = await authenticateApiKey(ctx, key);
  } catch (err) {
    log.error({ route: input.route, err }, "api_auth_failed");
    return apiError(500, "internal_error", "Something went wrong. Try again in a moment.");
  }
  if (!client) return limits.unauthorized.take(input.client) ? UNAUTHORIZED() : TOO_MANY();
  if (!limits.perKey.take(client.keyId)) return TOO_MANY();

  try {
    return apiJson(await work(client));
  } catch (err) {
    if (err instanceof InvalidQueryError) return apiError(400, "invalid_request", err.message);
    if (isDomainError(err, "invalid_input")) {
      return apiError(400, "invalid_request", err.message !== err.code ? err.message : "The request is not valid.");
    }
    if (isDomainError(err, "forbidden")) return apiError(403, "forbidden", "This API key may not do that.");
    log.error({ route: input.route, keyId: client.keyId, err }, "api_request_failed");
    return apiError(500, "internal_error", "Something went wrong. Try again in a moment.");
  }
}
