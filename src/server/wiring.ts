import "server-only";
/**
 * Connects the ports a module owns to the module that implements them, where a direct
 * import would run against the dependency direction. Leave owns `ApprovalRouter` and
 * approvals implements it; approvals depends on leave, so leave is handed its routing
 * here instead of importing approvals.
 *
 * Every composition root calls {@link wireModules} once before any service call: the
 * app (`runtime.ts`), the scripts (`scripts/script-context.mts`) and the integration
 * tests' harness. Calling it again does no harm.
 */
import { leaveApprovalRouting } from "@/modules/approvals";
import { provideApprovalRouting } from "@/modules/leave";

export function wireModules(): void {
  provideApprovalRouting(leaveApprovalRouting);
}
