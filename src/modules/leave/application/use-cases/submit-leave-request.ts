import "server-only";
import type { Actor } from "@/domain/actor";
import { readApprovalMode } from "@/shared/kernel/approval";
import { DomainError } from "@/domain/errors";
import { isUuid } from "@/domain/ids";
import type { Notification } from "@/modules/notifications";
import type { LeaveDraft } from "@/server/services/balances";
import { attempt, type ServiceResult } from "@/shared/lib/result";
import { createDateRange } from "../../domain/date-range";
import { normalizeNote } from "../../domain/note";
import { type SubmittedLeaveDTO, toLeaveRequestDTO } from "../dto";
import type { LeaveDeps, LeaveStore } from "../ports";
import { type StoredPlan, storeSubmission } from "../store-submission";
import { submitMail } from "../submit-mail";

/** What a person fills in to ask for time off. */
export interface SubmitLeaveInput extends LeaveDraft {
  note?: string | null;
}

/**
 * Most requests one person may submit per {@link SUBMIT_WINDOW_MINUTES}, counting
 * ones since cancelled. Each submit can email an approver, and each cancel of it
 * emails them again, so this also caps how much mail one person can cause.
 */
export const SUBMIT_LIMIT = 10;
export const SUBMIT_WINDOW_MINUTES = 10;

/** What the checks inside the unit of work settled: what it costs and who decides it. */
export interface SubmitPlan extends StoredPlan {
  /** Who is told instead of asked (heads-up mode), if anyone. */
  informId: string | null;
  /** Booked because approval is turned off, not approved by anyone. */
  headsUp: boolean;
}

/**
 * Submits a leave request for the actor and routes it for approval.
 *
 * Days are counted from the company's working days and holidays, never taken from
 * input, by the same computation the live preview runs (`AllowanceReader.assess`), so
 * submit decides exactly what the preview showed. The requester's row lock serialises
 * their submits, so two sent at once cannot spend the same days, and the company row is
 * share-locked so no calendar change recounts underneath. What the request costs per year
 * is stored with it, so later holiday edits never change a past balance.
 *
 * The company's approval mode picks the rule ({@link approvalRuleFor}) unless `rule` is
 * given. The request is approved on the spot when the rule says so (self-approval, or
 * every request while approval is turned off); otherwise it waits for its approver.
 * Every transition writes an audit row and an outbox event in the same transaction;
 * emails go out after commit.
 *
 * Fails with what the assessment refuses (including `insufficient_balance`, with its
 * details), `overlapping_request`, `no_approver`, `rate_limited` (more than
 * {@link SUBMIT_LIMIT} in {@link SUBMIT_WINDOW_MINUTES} minutes), or `forbidden` for an
 * inactive requester.
 */
export async function submitLeaveRequest(
  deps: LeaveDeps,
  actor: Actor,
  input: SubmitLeaveInput,
): Promise<ServiceResult<SubmittedLeaveDTO>> {
  // Cheap checks first, so malformed input never opens a transaction.
  const range = createDateRange(input.startDate, input.endDate, input.dayPortion);
  if (!range.ok) return range;
  return attempt(async () => {
    const note = normalizeNote(input.note);
    if (!isUuid(input.leaveTypeId)) throw new DomainError("leave_type_unavailable");
    return deps.unitOfWork(actor.companyId, async (store) => {
      const plan = await planSubmit(store, actor, input);
      const final = await storeSubmission(deps, store, actor, { plan, range: range.value, note, userId: actor.id });
      const notify: Notification[] = await submitMail(deps, store, actor, final, plan);
      return { result: { ...toLeaveRequestDTO(final), headsUp: plan.headsUp }, notify };
    });
  });
}

/** The checks under the locks: an active requester under the rate limit, the cost, and who decides. */
async function planSubmit(store: LeaveStore, actor: Actor, input: SubmitLeaveInput): Promise<SubmitPlan> {
  // Shared with other submits, exclusive with a holiday or working-days change, which
  // recounts submitted requests: a request is never counted with a calendar that is
  // being replaced. Taken before the member lock, the order every service locks in.
  await store.directory.shareLockCompany(actor.companyId);
  const requester = await store.directory.lockMember(actor.companyId, actor.id);
  if (!requester?.isActive) throw new DomainError("forbidden");
  // Counted under the member lock, so parallel submits cannot all slip under the cap.
  if ((await store.requests.countRecentByRequester(actor.id, SUBMIT_WINDOW_MINUTES)) >= SUBMIT_LIMIT) {
    throw new DomainError("rate_limited");
  }
  const assessment = await store.allowances.assess(actor, input);
  const settings = await store.directory.companySettings(actor.companyId);
  if (!settings) throw new DomainError("no_company");
  const decision = await store.approvals.route(actor.companyId, requester, readApprovalMode(settings.approvalMode));
  const informId = decision.kind === "auto_approve" ? (decision.informId ?? null) : null;
  const headsUp = decision.kind === "auto_approve" && decision.informId !== undefined;
  return { assessment, decision, informId, headsUp };
}
