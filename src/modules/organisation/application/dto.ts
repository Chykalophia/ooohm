import "server-only";

/** A level as pickers and other modules see it. */
export interface LevelDTO {
  id: string;
  name: string;
}

/** A level on the admin screen, with its head counts. */
export interface LevelSummaryDTO extends LevelDTO {
  /** Active people at the level (what the screen shows). */
  members: number;
  /** Everyone still at it, deactivated people included (what keeps it from being deleted). */
  assigned: number;
}

export function toLevelDTO({ id, name }: LevelDTO): LevelDTO {
  return { id, name };
}

export function toLevelSummaryDTO({ id, name, members, assigned }: LevelSummaryDTO): LevelSummaryDTO {
  return { id, name, members, assigned };
}
