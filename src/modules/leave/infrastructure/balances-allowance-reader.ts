import "server-only";
import type { Executor, Transaction } from "@/db/types";
import { listAllowances, sumBookedDays } from "@/server/repositories/balances";
import { allowanceYearsFor, assessLeaveRequest, balanceInputs, loadAllowanceDefaults, summarizeBalances } from "@/server/services/balances";
import { recarryMemberLeaveType } from "@/server/services/rollover";
import type { AllowanceReader } from "../application/ports";

/** Leave's {@link AllowanceReader}, served by the balances services, bound to `ex`. */
export function balancesAllowanceReader(ex: Executor): AllowanceReader {
  return {
    assess: (person, draft) => assessLeaveRequest(ex, person, draft),
    summarize: (person, loaded) => summarizeBalances(ex, person, loaded),
    balancesFor: async (companyId, { years, ...scope }) => {
      const [allowanceRows, bookedRows, defaults] = await Promise.all([
        listAllowances(ex, { ...scope, years: allowanceYearsFor(years) }),
        sumBookedDays(ex, { ...scope, years }),
        loadAllowanceDefaults(ex, companyId, scope.userIds),
      ]);
      return balanceInputs(allowanceRows, bookedRows, defaults);
    },
    recarry: async (job) => {
      await recarryMemberLeaveType(ex as Transaction, job);
    },
  };
}
