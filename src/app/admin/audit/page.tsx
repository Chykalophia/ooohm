import type { Metadata } from "next";
import { z } from "zod";
import { AUDIT_PAGE_SIZE, AUDIT_SEARCH_MAX_LENGTH, getAuditLog, presentAuditLog } from "@/modules/audit";
import { unwrap } from "@/shared/lib/result";
import { AdminShell } from "@/app/admin/admin-shell";
import { readParam } from "@/shared/lib/search-params";
import { requireAdminPage } from "@/app/_lib/page-context";
import { listHref, pagerLinks, readPageParams } from "@/app/_lib/paging";
import { Pager } from "@/components/navigation/pager";
import { AuditLogTable } from "./audit-log-table";

export const metadata: Metadata = { title: "Audit log · Admin · OOOhm" };

const PATH = "/admin/audit";
const param = z.string().max(200).optional().catch(undefined);
/** The search, cut to what the box holds (the service cuts it too), so box and results agree. */
const searchParam = z
  .string()
  .transform((s) => s.slice(0, AUDIT_SEARCH_MAX_LENGTH))
  .optional()
  .catch(undefined);
const sizeParam = z.string().regex(/^\d{1,3}$/);

export default async function AuditPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { actor, ctx, nav } = await requireAdminPage();
  const params = await searchParams;
  const { cursor, number } = readPageParams(params);
  const log = unwrap(
    await getAuditLog(ctx, actor, {
      query: searchParam.parse(params.q),
      action: param.parse(params.action),
      actorId: param.parse(params.actor),
      subjectUserId: param.parse(params.person),
      from: param.parse(params.from),
      to: param.parse(params.to),
      oldestFirst: params.order === "oldest",
      size: Number(readParam(sizeParam, params.size) ?? AUDIT_PAGE_SIZE),
      page: cursor,
    }),
  );
  const view = presentAuditLog(log, (query) => listHref(PATH, query));

  return (
    <AdminShell nav={nav} section="audit" title="Audit log" description={`Every change. Times are in ${log.timezone.replaceAll("_", " ")}.`}>
      <AuditLogTable log={log} view={view} path={PATH} />
      <Pager label="Audit log pages" links={pagerLinks(PATH, log, number, { keep: view.pagerKeep })} />
    </AdminShell>
  );
}
