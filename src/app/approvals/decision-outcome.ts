/**
 * What the decide action answers on success, one per outcome. The card reads the outcome
 * from this answer, not from the button pressed, so it is right even for a submit made
 * before the page hydrated.
 */
export const DECIDED_MESSAGE = { approve: "Approved.", reject: "Declined." } as const;
