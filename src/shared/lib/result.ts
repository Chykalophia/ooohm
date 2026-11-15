import { DomainError, type DomainErrorCode, type DomainErrorDetails, isDomainError } from "@/shared/kernel/errors";

/**
 * What a use case returns at the application boundary (ADR-0003): a value, or an
 * expected failure with a stable code. Unexpected faults still throw.
 *
 * Results carry a private marker so the action pipeline and the API handler can tell
 * one from an ordinary return value that happens to have an `ok` field.
 */
export interface AppError {
  readonly code: DomainErrorCode;
  readonly message: string;
  readonly details?: DomainErrorDetails;
}

const RESULT: unique symbol = Symbol("ServiceResult");

export type Ok<T> = { readonly ok: true; readonly value: T; readonly [RESULT]: true };
export type Err = { readonly ok: false; readonly error: AppError; readonly [RESULT]: true };
export type ServiceResult<T> = Ok<T> | Err;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value, [RESULT]: true };
}

/** A failure. `message` defaults to the code, as `DomainError` does. */
export function err(code: DomainErrorCode, message?: string, details?: DomainErrorDetails): Err {
  return { ok: false, error: { code, message: message ?? code, ...(details ? { details } : {}) }, [RESULT]: true };
}

export function isServiceResult(value: unknown): value is ServiceResult<unknown> {
  return typeof value === "object" && value !== null && RESULT in value;
}

export const isOk = <T>(result: ServiceResult<T>): result is Ok<T> => result.ok;
export const isErr = <T>(result: ServiceResult<T>): result is Err => !result.ok;

export function map<T, U>(result: ServiceResult<T>, fn: (value: T) => U): ServiceResult<U> {
  return result.ok ? ok(fn(result.value)) : result;
}

/** A thrown `DomainError` as a failure; anything else is a fault and is rethrown. */
export function fromDomainError(error: unknown): Err {
  if (isDomainError(error)) return err(error.code, error.message, error.details);
  throw error;
}

/**
 * Runs `work` and returns its value as a result, turning a thrown `DomainError` into
 * a failure. This is how a use case that still throws inside (or rolls back a
 * transaction by throwing) reports at its boundary once the transaction has settled.
 */
export async function attempt<T>(work: () => Promise<T>): Promise<ServiceResult<T>> {
  try {
    return ok(await work());
  } catch (error) {
    return fromDomainError(error);
  }
}

/** The value of a success; a failure is thrown as the `DomainError` it stands for. */
export function unwrap<T>(result: ServiceResult<T>): T {
  if (result.ok) return result.value;
  throw new DomainError(result.error.code, result.error.message, result.error.details);
}

/** A returned value as-is, or a returned result unwrapped (see {@link unwrap}). */
export function valueOf<T>(outcome: T | ServiceResult<T>): T {
  return isServiceResult(outcome) ? unwrap(outcome as ServiceResult<T>) : (outcome as T);
}
