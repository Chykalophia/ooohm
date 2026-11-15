import "server-only";
import { DomainError } from "@/domain/errors";
import type { LevelEventPayload, Unattributed } from "@/domain/events";
import { isUniqueViolation } from "@/server/repositories/errors";
import type { LevelDTO } from "./dto";

/** A level as its events carry it. */
export function levelPayload(level: LevelDTO): Unattributed<LevelEventPayload> {
  return { levelId: level.id, name: level.name };
}

/** Runs `work`, turning a unique-name race into `already_exists`. */
export async function withUniqueName<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (isUniqueViolation(err, "levels_company_lower_name_uq")) throw new DomainError("already_exists");
    throw err;
  }
}
