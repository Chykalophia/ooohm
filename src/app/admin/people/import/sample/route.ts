import { toActor } from "@/domain/actor";
import { canAdminister } from "@/domain/admin-permissions";
import { peopleImportSampleCsv } from "@/domain/people-import";
import { currentUser } from "@/lib/auth";

/**
 * `GET /admin/people/import/sample`: the sample people import file, to fill in and
 * upload on the import page. Admins only (anyone else gets a bare 404, as the admin
 * pages do); it holds made-up people only.
 */
export async function GET(): Promise<Response> {
  const user = await currentUser();
  if (!user) return new Response(null, { status: 401 });
  const actor = toActor(user);
  if (!actor || !canAdminister(actor)) return new Response(null, { status: 404 });
  return new Response(peopleImportSampleCsv(), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="ooohm-people-import-sample.csv"',
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
