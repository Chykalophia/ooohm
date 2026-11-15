import { DomainError } from "@/shared/kernel/errors";
import { NOTE_MAX_LENGTH } from "@/shared/kernel/leave-range";

/**
 * Trims free text and turns blank into `null`. `field` names the form field it came
 * from, so an error can point at it (a request's `note`, a decision's `reason`).
 *
 * @throws DomainError `invalid_input` when longer than {@link NOTE_MAX_LENGTH}.
 */
export function normalizeNote(note: string | null | undefined, field = "note"): string | null {
  const trimmed = note?.trim() ?? "";
  if (trimmed.length > NOTE_MAX_LENGTH) {
    throw new DomainError("invalid_input", `Notes are limited to ${NOTE_MAX_LENGTH} characters.`, { field });
  }
  return trimmed === "" ? null : trimmed;
}
