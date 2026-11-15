import "server-only";
/**
 * The organisation module's public API (see README.md): company settings and appearance,
 * departments, levels and the leave type catalog. Everything outside the module imports
 * from here only.
 */

// Company settings and appearance.
export { getCompanySettings } from "./application/queries/get-company-settings";
export { updateCompanyAppearance } from "./application/use-cases/update-company-appearance";
export { updateCompanyLogo } from "./application/use-cases/update-company-logo";
export { removeCompanyLogo } from "./application/use-cases/remove-company-logo";
export { getAppearance } from "./application/queries/get-appearance";
export { getCompanyLogo } from "./application/queries/get-company-logo";
export { getDeploymentLogo } from "./application/queries/get-deployment-logo";
export { getLogoFile } from "./application/queries/get-logo-file";
export { findCompany } from "./application/queries/find-company";
export { saveCompanySettings } from "./application/steps/save-company-settings";
export { lockCompanyForChange } from "./application/steps/lock-company-for-change";
export { applyCompanyChanges } from "./application/steps/apply-company-changes";

// Departments.
export { listDepartmentsForAdmin } from "./application/queries/list-departments-for-admin";
export { listDepartmentManagerChoices } from "./application/queries/list-department-manager-choices";
export { createDepartment } from "./application/use-cases/create-department";
export { renameDepartment } from "./application/use-cases/rename-department";
export { deleteDepartment } from "./application/use-cases/delete-department";
export { setDepartmentLimit } from "./application/use-cases/set-department-limit";
export { changeDepartmentManager } from "./application/steps/change-department-manager";
export { listDepartments } from "./application/queries/list-departments";
export { findDepartment } from "./application/queries/find-department";
export { findDepartmentLimits } from "./application/queries/find-department-limits";
export { findDepartmentManagerIds } from "./application/queries/find-department-manager-ids";
export { listManagedDepartmentIds } from "./application/queries/list-managed-department-ids";
export { addDepartment } from "./application/steps/add-department";
export { clearDepartmentsManagedBy } from "./application/steps/clear-departments-managed-by";

// Levels.
export { createLevel } from "./application/use-cases/create-level";
export { renameLevel } from "./application/use-cases/rename-level";
export { deleteLevel } from "./application/use-cases/delete-level";
export { listLevelsForAdmin } from "./application/queries/list-levels-for-admin";
export { listLevels } from "./application/queries/list-levels";
export { findLevel } from "./application/queries/find-level";

// Leave types.
export { listLeaveTypesForAdmin } from "./application/queries/list-leave-types-for-admin";
export { getLeaveTypeForAdmin } from "./application/queries/get-leave-type-for-admin";
export { createLeaveType } from "./application/use-cases/create-leave-type";
export { updateLeaveType } from "./application/use-cases/update-leave-type";
export { setLeaveTypeArchived } from "./application/use-cases/set-leave-type-archived";
export { reorderLeaveTypes } from "./application/use-cases/reorder-leave-types";
export { findLeaveType } from "./application/queries/find-leave-type";
export { listAllLeaveTypes } from "./application/queries/list-all-leave-types";
export { findLeaveTypeForAdmin } from "./application/queries/find-leave-type-for-admin";
export { findLeaveTypeByCode } from "./application/queries/find-leave-type-by-code";
export { addLeaveType } from "./application/steps/add-leave-type";
export { applyLeaveTypeChanges } from "./application/steps/apply-leave-type-changes";
export { recordLeaveTypeChange } from "./application/leave-type-changes";

// Allowance rules of a department or level (recorded the same way by the rule use cases).
export { allowanceRulePayload, allowanceRuleSnapshot } from "./application/allowance-rule-removal";

export {
  canManageAppearance,
  canManageCompanySettings,
  canManageDepartments,
  canManageLeaveTypes,
  canManageLevels,
} from "./application/policies";
export type { CompanyChange } from "./application/company-changes";
export type { DepartmentManagerChange } from "./application/steps/change-department-manager";
export type {
  AllowanceRuleFacts,
  CompanyDTO,
  CompanySettingsFormDTO,
  DepartmentDTO,
  DepartmentManagerChoiceDTO,
  DepartmentSummaryDTO,
  LeaveTypeDTO,
  LeaveTypeFields,
  LeaveTypeSettingsDTO,
  LevelDTO,
  LevelSummaryDTO,
} from "./application/dto";
