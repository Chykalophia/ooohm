import { openApiDocument } from "@/app/api/v1/_lib/openapi";

/** `GET /api/v1/openapi.json`: the API's OpenAPI 3.1 document. Public: it describes the API and holds no data. */
export function GET(): Response {
  return Response.json(openApiDocument, { headers: { "Cache-Control": "public, max-age=300" } });
}
