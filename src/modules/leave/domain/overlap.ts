/**
 * Who else is off while a request would be: the line an approver reads before deciding
 * ("Nobody else in Design is off then", "Aisha is off then too").
 */

/** One person's pending or approved leave, as the team calendar has it. */
export interface TeamLeave {
  userId: string;
  personName: string;
  departmentId: string | null;
  startDate: string;
  endDate: string;
  status: string;
  leaveTypeName: string;
}

/** The request being decided. */
export interface OverlapTarget {
  requesterId: string;
  departmentId: string | null;
  startDate: string;
  endDate: string;
}

/** Another person off during the target's dates. `pending` when none of their overlapping leave is approved yet. */
export interface Overlap {
  userId: string;
  personName: string;
  leaveTypeName: string;
  pending: boolean;
}

/**
 * Other people off on any of `target`'s dates: the requester's department when they
 * have one, everyone otherwise. One entry per person, in order of their first
 * overlapping leave; approved leave wins over pending when someone has both.
 *
 * @param leave Pending and approved leave intersecting at least the target's dates,
 *   in start-date order (as `listTeamEntries` returns it).
 */
export function overlapsFor(target: OverlapTarget, leave: readonly TeamLeave[]): Overlap[] {
  const byPerson = new Map<string, Overlap>();
  for (const l of leave) {
    if (l.userId === target.requesterId) continue;
    if (target.departmentId && l.departmentId !== target.departmentId) continue;
    if (l.endDate < target.startDate || l.startDate > target.endDate) continue;
    const pending = l.status !== "approved";
    const seen = byPerson.get(l.userId);
    if (!seen) byPerson.set(l.userId, { userId: l.userId, personName: l.personName, leaveTypeName: l.leaveTypeName, pending });
    else if (seen.pending && !pending) byPerson.set(l.userId, { ...seen, leaveTypeName: l.leaveTypeName, pending });
  }
  return [...byPerson.values()];
}

/** Most names {@link describeOverlap} lists before "and N more". */
const NAMES_SHOWN = 3;

/**
 * The approver's one line: "Nobody else in Design is off then.", "Aisha Khan is off then
 * too.", or "Also off then: Aisha Khan, Tomás (not approved yet) and 2 more."
 */
export function describeOverlap(overlaps: readonly Overlap[], departmentName: string | null): string {
  if (overlaps.length === 0) return departmentName ? `Nobody else in ${departmentName} is off then.` : "Nobody else is off then.";
  const label = (o: Overlap) => (o.pending ? `${o.personName} (not approved yet)` : o.personName);
  if (overlaps.length === 1) return `${label(overlaps[0] as Overlap)} is off then too.`;
  const shown = overlaps.slice(0, NAMES_SHOWN).map(label);
  const rest = overlaps.length - shown.length;
  const list = rest > 0 ? `${shown.join(", ")} and ${rest} more` : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
  return `Also off then: ${list}.`;
}
