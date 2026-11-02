import { serviceContext } from "@/server/runtime";
import { isDatabaseReachable } from "@/server/services/health";

export async function GET() {
  if (await isDatabaseReachable(serviceContext())) return Response.json({ status: "ok" });
  return Response.json({ status: "error", db: "unreachable" }, { status: 503 });
}
