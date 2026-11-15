import assert from "node:assert/strict";
import { test } from "node:test";
import { type CompanyId, parseCompanyId, parseLeaveRequestId, parseUserId, type UserId } from "@/shared/kernel/ids";
import { sequenceIds, uuidGenerator } from "@/shared/lib/id-generator";
import { isUuid } from "@/shared/kernel/uuid";

test("branded ids parse from UUID strings and refuse anything else", () => {
  const id = "3F2504E0-4F89-41D3-9A0C-0305E82C3301";
  assert.equal(parseUserId(id), id.toLowerCase());
  assert.equal(parseCompanyId("not-a-uuid"), null);
  assert.equal(parseLeaveRequestId(42), null);
  assert.equal(parseUserId(undefined), null);
});

test("a UserId is not a CompanyId", () => {
  const user = parseUserId("3f2504e0-4f89-41d3-9a0c-0305e82c3301") as UserId;
  // @ts-expect-error: the brands keep the two kinds of id apart.
  const company: CompanyId = user;
  assert.ok(company);
});

test("the id generators make UUIDs; the sequence one is predictable", () => {
  assert.ok(isUuid(uuidGenerator.next()));
  assert.notEqual(uuidGenerator.next(), uuidGenerator.next());
  const ids = sequenceIds();
  assert.equal(ids.next(), "00000000-0000-4000-8000-000000000001");
  assert.equal(ids.next(), "00000000-0000-4000-8000-000000000002");
  assert.ok(isUuid(sequenceIds(255).next()));
});
