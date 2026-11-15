import "server-only";
import type { EmailApproval } from "../dto";
import { resolveLink } from "../email-link";
import type { ApprovalDeps } from "../ports";

/**
 * Reads what an approve link points at, without changing anything: email scanners
 * open links before people do, so a GET must never decide. Two queries at most.
 */
export async function readEmailApproval(deps: ApprovalDeps, token: string): Promise<EmailApproval> {
  return (await resolveLink(deps, token)).approval;
}
