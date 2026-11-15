/**
 * The structured facts some error codes carry (see `DomainErrorCode`). Kept apart from
 * `errors.ts` and free of imports, so any domain file can name them without a cycle.
 */

/**
 * Facts behind an `insufficient_balance` error, so the presentation layer can say
 * exactly what is left without parsing a message.
 */
export interface BalanceShortfallDetails {
  /** The calendar year whose balance falls short. */
  readonly year: number;
  /** Days the request costs in that year. */
  readonly requested: number;
  /** Days left in that year before this request (may be 0 or negative). */
  readonly remaining: number;
  /** How many calendar years the request spans (1 or 2). */
  readonly yearsSpanned: number;
  /** Who the time off is for, when someone else is adding it for them: the message names them. */
  readonly person?: string;
}

/**
 * Facts behind a `zero_days` error: the company holidays inside the requested dates, so
 * the message can name them rather than say "weekends or holidays". Empty when only
 * non-working days were asked for.
 */
export interface NoWorkingDaysDetails {
  readonly holidays: readonly { readonly date: string; readonly name: string }[];
}

/**
 * Which input an `invalid_input` error is about, by the name forms give that field, so
 * the form can mark it and move focus there (WCAG 3.3.1).
 */
export interface InvalidFieldDetails {
  readonly field: string;
}

/** What has to change before a person can be deleted. Every field empty or false: nothing blocks. */
export interface DeletionBlockers {
  /** Deleting takes two steps: deactivate first. */
  readonly stillActive: boolean;
  /** People whose manager they are: give them another manager first. */
  readonly reports: readonly { id: string; name: string }[];
  /** Pending requests assigned to them to decide. */
  readonly pendingApprovals: number;
  /** They are the company's only active admin. */
  readonly lastAdmin: boolean;
}

/** Structured facts attached to some codes; see each code's documentation. */
export type DomainErrorDetails = BalanceShortfallDetails | DeletionBlockers | NoWorkingDaysDetails | InvalidFieldDetails;
