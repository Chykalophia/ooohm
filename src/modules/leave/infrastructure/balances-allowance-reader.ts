import "server-only";
import type { Executor, Transaction } from "@/db/types";
import { assessLeaveRequest, loadBalanceInputs, recarryMemberLeaveType, summarizeBalances } from "@/modules/balances";
import type { AllowanceReader } from "../application/ports";

/** Leave's {@link AllowanceReader}, served by the balances services, bound to `ex`. */
export function balancesAllowanceReader(ex: Executor): AllowanceReader {
  return {
    assess: (person, draft) => assessLeaveRequest(ex, person, draft),
    summarize: (person, loaded) => summarizeBalances(ex, person, loaded),
    balancesFor: (companyId, scope) => loadBalanceInputs(ex, companyId, scope),
    recarry: async (job) => {
      await recarryMemberLeaveType(ex as Transaction, job);
    },
  };
}
