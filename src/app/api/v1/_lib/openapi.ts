import { API_GUIDE_URL } from "@/domain/integrations";
import { LEAVE_STATUSES } from "@/domain/leave-request";
import { API_DEFAULT_PAGE_SIZE, API_MAX_PAGE_SIZE } from "@/server/services/api-v1";
import { API_ERROR_CODES, REQUESTS_PER_KEY_PER_MINUTE } from "./handler";

/**
 * The OpenAPI 3.1 description of `/api/v1`, served at `/api/v1/openapi.json`. Written by
 * hand next to the routes; `tests/integration/api.test.ts` fails when a route file has a
 * method this document does not describe, or the reverse.
 */

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const nullable = (type: string, extra: object = {}) => ({ type: [type, "null"], ...extra });
const date = { type: "string", format: "date", examples: ["2026-11-27"] };
const dateTime = { type: "string", format: "date-time" };
const days = { type: "number", multipleOf: 0.5, description: "Working days; half days are 0.5." };

const errors = {
  "401": { $ref: "#/components/responses/Unauthorized" },
  "403": { $ref: "#/components/responses/Forbidden" },
  "429": { $ref: "#/components/responses/RateLimited" },
  "500": { $ref: "#/components/responses/InternalError" },
};
const withBadRequest = { "400": { $ref: "#/components/responses/BadRequest" }, ...errors };

const limitParam = {
  name: "limit",
  in: "query",
  description: `Items per page, 1 to ${API_MAX_PAGE_SIZE}.`,
  schema: { type: "integer", minimum: 1, maximum: API_MAX_PAGE_SIZE, default: API_DEFAULT_PAGE_SIZE },
};
const cursorParam = {
  name: "cursor",
  in: "query",
  description: "The `nextCursor` of the previous page. Opaque; do not build one.",
  schema: { type: "string", maxLength: 500 },
};
const yearParam = {
  name: "year",
  in: "query",
  description: "Calendar year. Defaults to the current year in the company's time zone.",
  schema: { type: "integer", minimum: 2000, maximum: 2100 },
};

function ok(description: string, schema: object) {
  return { "200": { description, content: { "application/json": { schema } } } };
}

function list(item: string, paged: boolean, extra: Record<string, object> = {}) {
  const properties: Record<string, object> = { data: { type: "array", items: ref(item) }, ...extra };
  if (paged) properties.nextCursor = nullable("string", { description: "Pass as `cursor` for the next page; `null` on the last one." });
  return { type: "object", required: Object.keys(properties), properties };
}

export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "OOOhm API",
    version: "1.0.0",
    summary: "Read-only access to one company's people, leave and balances, and its event stream.",
    description:
      "Authenticate with an API key an admin creates under Admin → Integrations → API keys: `Authorization: Bearer ooohm_...`. " +
      `Every response is JSON and \`Cache-Control: no-store\`. Each key may make ${REQUESTS_PER_KEY_PER_MINUTE} requests a minute. ` +
      "Errors share one shape: `{ \"error\": { \"code\", \"message\" } }`. The API guide (externalDocs) covers events, webhooks and signature verification.",
    license: { name: "FSL-1.1-ALv2", url: "https://fsl.software/FSL-1.1-ALv2.template.md" },
  },
  externalDocs: { description: "The OOOhm API guide", url: API_GUIDE_URL },
  servers: [{ url: "/" }],
  security: [{ apiKey: [] }],
  paths: {
    "/api/v1/users": {
      get: {
        operationId: "listUsers",
        summary: "People of the company, active and not, by id.",
        parameters: [cursorParam, limitParam],
        responses: { ...ok("A page of people.", list("User", true)), ...withBadRequest },
      },
    },
    "/api/v1/leave-types": {
      get: {
        operationId: "listLeaveTypes",
        summary: "Every leave type, archived ones flagged, in display order.",
        responses: { ...ok("All leave types.", list("LeaveType", false)), ...errors },
      },
    },
    "/api/v1/leave-requests": {
      get: {
        operationId: "listLeaveRequests",
        summary: "Leave requests overlapping a date range, by start date then id. Notes are never included.",
        parameters: [
          { name: "from", in: "query", description: "Only requests ending on or after this date.", schema: date },
          { name: "to", in: "query", description: "Only requests starting on or before this date.", schema: date },
          { name: "userId", in: "query", description: "Only this person's requests.", schema: { type: "string", maxLength: 100 } },
          { name: "status", in: "query", schema: { type: "string", enum: [...LEAVE_STATUSES] } },
          cursorParam,
          limitParam,
        ],
        responses: { ...ok("A page of leave requests.", list("LeaveRequest", true)), ...withBadRequest },
      },
    },
    "/api/v1/balances": {
      get: {
        operationId: "listBalances",
        summary: "Balances per person and leave type for one year, as the dashboard computes them.",
        description:
          "Every active person (or the one `userId`, active or not) and every active leave type, plus archived types where the person has an allowance or booked days that year.",
        parameters: [yearParam, { name: "userId", in: "query", schema: { type: "string", maxLength: 100 } }],
        responses: { ...ok("Balances for the year.", list("Balance", false, { year: { type: "integer" } })), ...withBadRequest },
      },
    },
    "/api/v1/holidays": {
      get: {
        operationId: "listHolidays",
        summary: "The company's holidays in one year, by date.",
        parameters: [yearParam],
        responses: { ...ok("Holidays for the year.", list("Holiday", false, { year: { type: "integer" } })), ...withBadRequest },
      },
    },
    "/api/v1/events": {
      get: {
        operationId: "listEvents",
        summary: "Replay the event outbox, for integrations that poll instead of receiving webhooks.",
        description:
          "Events in an order a poller can rely on: a later call never returns an event that sorts before one already returned. " +
          "Pass the `id` of the last event you processed as `after`. Delivery is at least once; dedupe on `id`. Events are kept 90 days.",
        parameters: [
          { name: "after", in: "query", description: "The id of the last event you processed.", schema: { type: "string", format: "uuid" } },
          limitParam,
        ],
        responses: {
          ...ok("A page of events.", {
            type: "object",
            required: ["data", "hasMore"],
            properties: { data: { type: "array", items: ref("EventEnvelope") }, hasMore: { type: "boolean" } },
          }),
          ...withBadRequest,
        },
      },
    },
    "/api/v1/openapi.json": {
      get: {
        operationId: "getOpenApiDocument",
        summary: "This document.",
        security: [],
        responses: ok("The OpenAPI 3.1 document.", { type: "object" }),
      },
    },
  },
  components: {
    securitySchemes: {
      apiKey: { type: "http", scheme: "bearer", description: "An API key, `ooohm_` and 43 characters." },
    },
    responses: {
      BadRequest: { description: "A query parameter or cursor is not valid.", content: { "application/json": { schema: ref("Error") } } },
      Unauthorized: {
        description: "No API key, or an unknown or revoked one. The response does not say which.",
        headers: { "WWW-Authenticate": { schema: { type: "string" } } },
        content: { "application/json": { schema: ref("Error") } },
      },
      RateLimited: {
        description: "Too many requests from this key (or, without a valid key, from this address).",
        headers: { "Retry-After": { description: "Seconds to wait.", schema: { type: "integer" } } },
        content: { "application/json": { schema: ref("Error") } },
      },
      Forbidden: { description: "The key lacks the scope this endpoint needs.", content: { "application/json": { schema: ref("Error") } } },
      InternalError: { description: "Something failed on our side; try again.", content: { "application/json": { schema: ref("Error") } } },
    },
    schemas: {
      Error: {
        type: "object",
        required: ["error"],
        properties: {
          error: {
            type: "object",
            required: ["code", "message"],
            properties: {
              code: { type: "string", enum: [...API_ERROR_CODES] },
              message: { type: "string" },
            },
          },
        },
      },
      User: {
        type: "object",
        required: ["id", "name", "email", "department", "managerId", "role", "isActive", "createdAt"],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          email: { type: "string", format: "email" },
          department: { oneOf: [{ type: "null" }, { type: "object", required: ["id", "name"], properties: { id: { type: "string", format: "uuid" }, name: { type: "string" } } }] },
          managerId: nullable("string"),
          role: { type: "string", enum: ["employee", "manager", "admin"] },
          isActive: { type: "boolean" },
          createdAt: dateTime,
        },
      },
      LeaveType: {
        type: "object",
        required: ["id", "code", "name", "color", "isPaid", "countsAgainstAllowance", "defaultAllowanceDays", "carryoverEnabled", "carryoverMaxDays", "sortOrder", "archived"],
        properties: {
          id: { type: "string", format: "uuid" },
          code: { type: "string", examples: ["PTO"] },
          name: { type: "string" },
          color: { type: "string", pattern: "^#[0-9a-f]{6}$" },
          isPaid: { type: "boolean" },
          countsAgainstAllowance: { type: "boolean" },
          defaultAllowanceDays: nullable("number", { description: "`null`: no default; set per person." }),
          carryoverEnabled: { type: "boolean" },
          carryoverMaxDays: nullable("number", { description: "`null`: no cap." }),
          sortOrder: { type: "integer" },
          archived: { type: "boolean" },
        },
      },
      LeaveRequest: {
        type: "object",
        required: ["id", "userId", "leaveTypeId", "startDate", "endDate", "dayPortion", "days", "status", "approverId", "decidedAt", "createdAt", "updatedAt"],
        properties: {
          id: { type: "string", format: "uuid" },
          userId: { type: "string" },
          leaveTypeId: { type: "string", format: "uuid" },
          startDate: date,
          endDate: date,
          dayPortion: { type: "string", enum: ["full", "am", "pm"] },
          days,
          status: { type: "string", enum: [...LEAVE_STATUSES] },
          approverId: nullable("string"),
          decidedAt: nullable("string", { format: "date-time" }),
          createdAt: dateTime,
          updatedAt: dateTime,
        },
      },
      Balance: {
        type: "object",
        required: ["userId", "leaveTypeId", "year", "tracked", "allowance", "carriedOver", "adjustment", "total", "used", "pending", "carriedOut", "remaining"],
        description: "For an untracked (unlimited) type, `tracked` is false and only `used` and `pending` are numbers.",
        properties: {
          userId: { type: "string" },
          leaveTypeId: { type: "string", format: "uuid" },
          year: { type: "integer" },
          tracked: { type: "boolean" },
          allowance: nullable("number"),
          carriedOver: nullable("number"),
          adjustment: nullable("number"),
          total: nullable("number", { description: "allowance + carriedOver + adjustment" }),
          used: { type: "number", description: "Approved days." },
          pending: { type: "number" },
          carriedOut: nullable("number", { description: "Days already carried into next year." }),
          remaining: nullable("number", { description: "total - used - pending - carriedOut; negative after an allowance was lowered." }),
        },
      },
      Holiday: {
        type: "object",
        required: ["id", "date", "name"],
        properties: { id: { type: "string", format: "uuid" }, date, name: { type: "string" } },
      },
      EventEnvelope: {
        type: "object",
        required: ["id", "type", "version", "createdAt", "companyId", "data"],
        description: "The same envelope webhooks deliver. `data` is the payload documented for `type` in the API guide (externalDocs).",
        properties: {
          id: { type: "string", format: "uuid" },
          type: { type: "string", examples: ["leave.approved"] },
          version: { type: "integer", const: 1 },
          createdAt: dateTime,
          companyId: { type: "string", format: "uuid" },
          data: { type: "object" },
        },
      },
    },
  },
} as const;
