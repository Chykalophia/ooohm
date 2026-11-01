import assert from "node:assert/strict";
import { type DomainErrorCode, isDomainError } from "@/domain/errors";

/** Asserts that `promise` rejects with a `DomainError` carrying `code`. */
export async function rejectsWith(promise: Promise<unknown>, code: DomainErrorCode): Promise<void> {
  await assert.rejects(promise, (err) => {
    assert.ok(isDomainError(err), `expected DomainError(${code}), got ${String(err)}`);
    assert.equal(err.code, code);
    return true;
  });
}
