import "server-only";
import type { Actor } from "@/domain/actor";
import type { ServiceContext } from "@/server/context";
import { map, type ServiceResult } from "@/shared/lib/result";
import { reportCsv } from "../../domain/leave-report";
import type { LeaveReportQuery } from "../schemas";
import { getLeaveReport } from "./get-leave-report";

/** A report's people table as a file to download. */
export interface LeaveReportExport {
  filename: string;
  csv: string;
}

/**
 * {@link getLeaveReport} as a CSV download: one row per person. Fails as
 * {@link getLeaveReport} does.
 */
export async function exportLeaveReport(ctx: ServiceContext, actor: Actor, query: LeaveReportQuery = {}): Promise<ServiceResult<LeaveReportExport>> {
  return map(await getLeaveReport(ctx, actor, query), ({ report, department }) => {
    const slug = department ? `-${department.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}` : "";
    return { filename: `ooohm-leave-report-${report.year}${slug}.csv`, csv: reportCsv(report) };
  });
}
