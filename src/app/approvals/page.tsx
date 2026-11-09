import type { Metadata } from "next";
import { formatDays, formatInstantDate, formatLeaveDates } from "@/lib/format";
import { type ApprovalsView, getApprovalTriage } from "@/server/services/approvals";
import { AppPage } from "@/components/layout/app-page";
import { NoCompany } from "@/components/layout/no-company";
import { StatusBadge } from "@/components/leave/status-badge";
import { Pager } from "@/components/navigation/pager";
import { TabNav } from "@/components/navigation/tab-nav";
import { ColorLabel } from "@/components/ui/color-label";
import { cx, surface } from "@/components/ui/styles";
import { requireMemberPage } from "@/app/_lib/page-context";
import { listHref, pagerLinks, readPageParams } from "@/app/_lib/paging";
import { ApprovalItem } from "./approval-item";
import { ApprovalKeys } from "./approval-keys";

export const metadata: Metadata = { title: "Approvals · OOOhm" };

const PATH = "/approvals";

/** The `?view=` of each tab; Needs you is the page itself. */
const VIEW_PARAM: Record<ApprovalsView, string | undefined> = { mine: undefined, others: "waiting", settled: "settled" };

function readView(value: string | string[] | undefined): ApprovalsView {
  const v = Array.isArray(value) ? value[0] : value;
  return v === "waiting" ? "others" : v === "settled" ? "settled" : "mine";
}

/**
 * Approvals, sorted by whose move it is: Needs you, Waiting on others (admins, when
 * anything is), and Settled (what the person decided lately). Each tab pages ten at a
 * time; each request says who else in the requester's department is off then.
 */
export default async function ApprovalsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const page = await requireMemberPage();
  if (!page.actor) return <NoCompany nav={page.nav} current="approvals" />;

  const { actor } = page;
  const params = await searchParams;
  const { cursor, number } = readPageParams(params);
  const triage = await getApprovalTriage(page.ctx, actor, { view: readView(params.view), page: cursor });
  // Waiting on others shows only when something is there; a link to an empty tab adds noise.
  const view = triage.view === "others" && triage.waitingTotal === 0 && !triage.previous ? "mine" : triage.view;
  const href = (v: ApprovalsView) => listHref(PATH, { view: VIEW_PARAM[v] });
  const pager = pagerLinks(PATH, triage, number, { keep: { view: VIEW_PARAM[view] } });

  const tabs = [
    { href: href("mine"), label: "Needs you", count: triage.needsYouTotal, current: view === "mine" },
    ...(triage.waitingTotal > 0 || view === "others"
      ? [{ href: href("others"), label: "Waiting on others", count: triage.waitingTotal, current: view === "others" }]
      : []),
    { href: href("settled"), label: "Settled", current: view === "settled" },
  ];

  return (
    <AppPage nav={page.nav} current="approvals" title="Approvals">
      <TabNav label="Approvals" items={tabs} />

      {view === "settled" ? (
        <>
          <Settled decisions={triage.settled} days={triage.settledDays} timeZone={triage.timeZone} firstPage={!triage.previous} />
          <Pager label="Settled pages" links={pager} />
        </>
      ) : (
        <>
          {view === "others" && <p className="text-sm text-muted">Assigned to someone else. As an admin you can still decide them.</p>}
          {triage.items.length === 0 ? (
            <p className="text-muted">
              {triage.previous
                ? "Nothing on this page is waiting for you now."
                : view === "others"
                  ? "Nothing is waiting on anyone else."
                  : triage.waitingTotal > 0
                    ? `Nothing needs you right now. ${triage.waitingTotal === 1 ? "One request is" : `${triage.waitingTotal} requests are`} waiting on someone else.`
                    : "Nothing needs you right now."}
            </p>
          ) : (
            <>
              {/* J and K move between these, A approves, D starts a decline, once turned on. */}
              <ApprovalKeys userId={actor.id} />
              <ul className="space-y-4">
                {triage.items.map((r) => (
                  <ApprovalItem
                    key={r.id}
                    requestId={r.id}
                    label={`Request from ${r.requesterName || r.requesterEmail}, ${formatLeaveDates(r.startDate, r.endDate, r.dayPortion)}`}
                    who={r.requesterName || r.requesterEmail}
                    dates={formatLeaveDates(r.startDate, r.endDate, r.dayPortion)}
                  >
                    <div className="space-y-1">
                      <p className="font-medium break-words">
                        {r.requesterName || r.requesterEmail}
                        {/* A real space, so a screen reader doesn't run the name into the email. */}
                        {r.requesterName && " "}
                        {r.requesterName && <span className="ml-1 text-sm font-normal text-muted">{r.requesterEmail}</span>}
                      </p>
                      <ColorLabel color={r.leaveTypeColor}>{formatLeaveDates(r.startDate, r.endDate, r.dayPortion)}</ColorLabel>
                      <p className="text-sm text-muted">
                        {r.leaveTypeName} · {formatDays(r.days)}
                        {r.approverId && r.approverId !== actor.id && ` · Assigned to ${r.approverName || "someone else"}`}
                      </p>
                      {r.note && <p className="text-sm break-words">{r.note}</p>}
                      {r.alsoOff?.coverage && <p className="text-sm font-medium break-words">{r.alsoOff.coverage}</p>}
                      {r.alsoOff && (
                        <p className={cx("text-sm break-words", r.alsoOff.others > 0 ? "font-medium" : "text-muted")}>{r.alsoOff.line}</p>
                      )}
                    </div>
                  </ApprovalItem>
                ))}
              </ul>
            </>
          )}
          <Pager label="Approvals pages" links={pager} />
        </>
      )}
    </AppPage>
  );
}

type Decision = Awaited<ReturnType<typeof getApprovalTriage>>["settled"][number];

/** What the person approved or declined in the last `days` days, newest first, each with its status now. */
function Settled({
  decisions,
  days,
  timeZone,
  firstPage,
}: {
  decisions: readonly Decision[];
  days: number;
  timeZone: string;
  firstPage: boolean;
}) {
  if (decisions.length === 0) {
    return (
      <p className="text-muted">{firstPage ? `You haven’t decided anything in the last ${days} days.` : "Nothing more on this page."}</p>
    );
  }
  return (
    <>
      <p className="text-sm text-muted">What you decided in the last {days} days, newest first.</p>
      <ul className={cx("divide-y divide-border", surface)}>
        {decisions.map((d) => (
          <li key={d.auditId} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 space-y-1">
              <p className="font-medium break-words">{d.requesterName || d.requesterEmail}</p>
              <ColorLabel color={d.leaveTypeColor}>{formatLeaveDates(d.startDate, d.endDate, d.dayPortion)}</ColorLabel>
              <p className="text-sm text-muted">
                {d.leaveTypeName} · {formatDays(d.days)} · {d.decision === "approved" ? "Approved" : "Declined"} by you on{" "}
                {formatInstantDate(d.decidedAt, timeZone)}
              </p>
              {d.decisionNote && (
                <p className="text-sm break-words">
                  <span className="text-muted">Your note: </span>
                  {d.decisionNote}
                </p>
              )}
            </div>
            <div className="shrink-0">
              <StatusBadge status={d.status} />
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
