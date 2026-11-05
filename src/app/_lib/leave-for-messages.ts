import type { DomainErrorCode } from "@/domain/errors";

/**
 * Wording for adding time off for someone else, where the request form's defaults
 * ("You already have time off…") would talk about the wrong person. Shared by the
 * action and the live preview.
 */
export const addForMessages: Partial<Record<DomainErrorCode, string>> = {
  overlapping_request: "They already have time off on some of those dates.",
  forbidden: "Only an admin or their manager can add time off for someone.",
  not_found: "That person isn't an active member any more.",
};
