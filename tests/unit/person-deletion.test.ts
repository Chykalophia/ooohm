import assert from "node:assert/strict";
import { test } from "node:test";
import { changeSourceLabel, bySystem, CHANGE_PROCESSES, recordedChangeSource } from "@/domain/change-source";
import { csvCell, toCsv } from "@/domain/csv";
import { isDomainError } from "@/domain/errors";
import { eventAttribution } from "@/domain/events";
import { normalizeEmail } from "@/domain/people";
import {
  assertConfirmed,
  assertDeletable,
  confirmationMatches,
  DELETION_GRACE_DAYS,
  deletionBlockers,
  deletionBlockersOf,
  describeDeletion,
  isBlocked,
  isDeletionMode,
  isTombstoneEmail,
  mentionsEmail,
  nameInUse,
  namesInOwnRecords,
  personRedactions,
  redactionNeedles,
  redactJson,
  redactJsonText,
  redactText,
  scrubDueAt,
  shortStableId,
  tombstoneEmail,
  tombstoneName,
} from "@/domain/person-deletion";
import { displayName } from "@/domain/person";
import { isCrossSiteRequest } from "@/lib/fetch-site";

const ID = "3f9a2c71-0b8e-4f4e-9d1c-2a7b6e5d4c3b";
const zeb = { id: ID, name: "Zebulon Quixtrade", email: "zeb.q@example.com" };

test("tombstone names: a short stable id after a full scrub, the name and (deleted) when records are kept", () => {
  assert.equal(shortStableId(ID), "3f9a2c");
  assert.equal(shortStableId(ID), shortStableId(ID), "stable");
  assert.equal(shortStableId("AbC-dEf_123"), "abcdef");
  assert.equal(shortStableId("---"), "000000");
  assert.equal(tombstoneName(zeb, "scrubbed"), "Former employee #3f9a2c");
  assert.equal(tombstoneName(zeb, "records_kept"), "Zebulon Quixtrade (deleted)");
  assert.equal(tombstoneName({ id: ID, name: "  " }, "records_kept"), "Former employee (deleted)");
  const long = tombstoneName({ id: ID, name: "N".repeat(120) }, "records_kept");
  assert.ok(long.endsWith(" (deleted)") && long.length <= 100);
  assert.equal(displayName(long), long, "the suffix survives the display cap");
});

test("tombstone emails are unique per id, lowercase, and rejected by the email rule everyone applies", () => {
  assert.equal(tombstoneEmail(ID), `deleted+${ID}@invalid`);
  const mixed = tombstoneEmail("AbC123");
  assert.equal(mixed, mixed.toLowerCase());
  assert.notEqual(tombstoneEmail("abc"), tombstoneEmail("ABC"), "ids differing only in case never share an address");
  assert.ok(isTombstoneEmail(tombstoneEmail(ID)) && isTombstoneEmail(mixed));
  assert.ok(!isTombstoneEmail("deleted+x@invalid.example"));
  assert.throws(() => normalizeEmail(tombstoneEmail(ID)), (err) => isDomainError(err, "invalid_input"), "cannot be invited or signed in with");
});

test("modes and the grace period", () => {
  assert.ok(isDeletionMode("scrubbed") && isDeletionMode("records_kept"));
  assert.ok(!isDeletionMode("archived") && !isDeletionMode(undefined));
  assert.equal(DELETION_GRACE_DAYS, 7);
  assert.equal(scrubDueAt(new Date("2026-11-01T15:00:00Z")).toISOString(), "2026-11-08T15:00:00.000Z");
});

const facts = (over: Partial<Parameters<typeof deletionBlockers>[0]> = {}) => ({
  person: { id: "p", role: "employee" as const, isActive: false },
  reports: [],
  pendingApprovals: 0,
  activeAdminIds: ["boss"],
  ...over,
});

test("guards: a deactivated person who manages nobody and decides nothing can go; each blocker alone blocks", () => {
  assert.equal(isBlocked(deletionBlockers(facts())), false);
  assert.doesNotThrow(() => assertDeletable(facts()));

  const cases = [
    facts({ person: { id: "p", role: "employee", isActive: true } }),
    facts({ reports: [{ id: "r", name: "Ana" }] }),
    facts({ pendingApprovals: 1 }),
  ];
  for (const f of cases) {
    assert.equal(isBlocked(deletionBlockers(f)), true);
    assert.throws(
      () => assertDeletable(f),
      (err) => {
        const blockers = isDomainError(err) ? deletionBlockersOf(err) : null;
        return blockers !== null && isBlocked(blockers);
      },
    );
  }
  assert.deepEqual(deletionBlockers(facts({ reports: [{ id: "r", name: "Ana" }] })).reports, [{ id: "r", name: "Ana" }]);
});

test("guards: the last active admin is flagged; another admin, or not being active, clears it", () => {
  const admin = (isActive: boolean) => ({ id: "p", role: "admin" as const, isActive });
  assert.equal(deletionBlockers(facts({ person: admin(true), activeAdminIds: ["p"] })).lastAdmin, true);
  assert.equal(deletionBlockers(facts({ person: admin(true), activeAdminIds: ["p", "q"] })).lastAdmin, false);
  assert.equal(deletionBlockers(facts({ person: admin(false), activeAdminIds: ["q"] })).lastAdmin, false);
  assert.equal(deletionBlockers(facts({ person: { id: "p", role: "manager", isActive: true }, activeAdminIds: [] })).lastAdmin, false);
});

test("confirmation: the full name, ignoring case and extra spaces; nothing less", () => {
  assert.ok(confirmationMatches("Zebulon Quixtrade", zeb));
  assert.ok(confirmationMatches("  zebulon   QUIXTRADE ", zeb));
  for (const typed of ["Zebulon", "Quixtrade", "", "Zebulon Quixtrad", zeb.email]) assert.ok(!confirmationMatches(typed, zeb), typed);
  assert.ok(confirmationMatches(zeb.email, { name: " ", email: zeb.email }), "a blank name is confirmed with the email");
  assert.throws(() => assertConfirmed("nope", zeb), (err) => isDomainError(err, "confirmation_mismatch"));
});

test("the confirmation counts: a scrub removes history, keeping records keeps it", () => {
  const counts = { leaveRequests: 14, pendingRequests: 0, balanceYears: 3, allowanceRows: 6, auditEntries: 41, sessions: 2, accounts: 1, calendarFeeds: 0 };
  const scrub = describeDeletion("scrubbed", counts);
  assert.deepEqual(scrub.keeps, []);
  assert.ok(scrub.removes.includes("14 leave requests") && scrub.removes.includes("3 years of balances") && scrub.removes.includes("41 audit entries"));
  assert.ok(scrub.removes.includes("2 signed-in sessions") && scrub.removes.includes("1 linked Google sign-in"));
  assert.ok(!scrub.removes.some((l) => l.includes("calendar")), "zero counts are left out");
  const keep = describeDeletion("records_kept", counts);
  assert.deepEqual(keep.keeps, ["14 leave requests", "3 years of balances", "41 audit entries"]);
  assert.ok(keep.removes.includes("their email address") && !keep.removes.includes("14 leave requests"));
  assert.deepEqual(describeDeletion("scrubbed", { ...counts, leaveRequests: 1, balanceYears: 1, auditEntries: 1 }).removes.slice(1, 4), [
    "1 leave request",
    "1 year of balances",
    "1 audit entry",
  ]);
  // Their own requests still waiting: keeping records withdraws them; a scrub deletes them with the rest.
  const waiting = { ...counts, pendingRequests: 2 };
  assert.deepEqual(describeDeletion("records_kept", waiting).removes.slice(0, 2), ["their email address", "2 requests of theirs still waiting for a decision (withdrawn)"]);
  assert.deepEqual(describeDeletion("scrubbed", waiting), scrub);
});

const TOMB = "Former employee #3f9a2c";
const TOMB_EMAIL = `deleted+${ID}@invalid`;

test("redactions: a scrub replaces the full name (whole words) and the email; keeping records replaces the email only", () => {
  const scrub = personRedactions(zeb, "scrubbed");
  const keep = personRedactions(zeb, "records_kept");
  const text = "Zebulon Quixtrade <ZEB.Q@example.com> covers for zebulon  quixtrade; ZebulonQuixtrades is someone else.";
  assert.equal(redactText(text, scrub), `${TOMB} <${TOMB_EMAIL}> covers for ${TOMB}; ZebulonQuixtrades is someone else.`);
  assert.equal(redactText(text, keep), `Zebulon Quixtrade <${TOMB_EMAIL}> covers for zebulon  quixtrade; ZebulonQuixtrades is someone else.`);
  assert.equal(redactText("a+b(c)@x.io", personRedactions({ id: ID, name: "", email: "a+b(c)@x.io" }, "scrubbed")), TOMB_EMAIL, "regex characters are literal");
  assert.equal(redactText("Mail zeb.q@example.com.", scrub), `Mail ${TOMB_EMAIL}.`, "a sentence may end right after the address");
});

test("redactions: an address that only contains theirs is someone else's, left byte for byte", () => {
  const ed = personRedactions({ id: ID, name: "Ed Park", email: "ed@acme.com" }, "scrubbed");
  for (const other of ["ted@acme.com", "fred.ed@acme.com", "ed@acme.com.au", "ed@acme.company", "x-ed@acme.com", "ed@acme.com-mail.org"]) {
    assert.equal(redactText(`Ask ${other} about it`, ed), `Ask ${other} about it`, other);
    assert.equal(mentionsEmail(other, ed), false, other);
  }
  for (const mine of ["ed@acme.com", "ED@Acme.com", "<ed@acme.com>", '"ed@acme.com"', "mailto:ed@acme.com", "(ed@acme.com)"]) {
    assert.equal(mentionsEmail(mine, ed), true, mine);
  }
  // After the separators of URLs, query strings and log lines, it is still theirs.
  for (const around of ["GET /users/ed@acme.com returned 404", "user=ed@acme.com not found", "lookup?email=ed@acme.com", "{ed@acme.com}", "#ed@acme.com", "a&to=ed@acme.com", "|ed@acme.com|"]) {
    assert.equal(mentionsEmail(around, ed), true, around);
    const out = redactText(around, ed);
    assert.ok(!out.includes("ed@acme.com") && out.includes(TOMB_EMAIL), out);
  }
  const echoed = JSON.stringify({ data: { note: "see /users/ed@acme.com" } });
  const fixed = redactJsonText(echoed, ed);
  assert.ok(fixed?.changed && !fixed.text.includes("ed@acme.com"), JSON.stringify(fixed));
  const ted = { userId: "ted-id", email: "ted@acme.com", name: "Ted Park", note: "cc fred.ed@acme.com" };
  assert.deepEqual(redactJson(ted, ed), { value: ted, changed: false });
  for (const mode of ["scrubbed", "records_kept"] as const) {
    const body = JSON.stringify({ id: "e1", type: "user.updated", data: ted });
    assert.deepEqual(redactJsonText(body, personRedactions({ id: ID, name: "Ed Park", email: "ed@acme.com" }, mode)), { text: body, changed: false }, mode);
  }
});

test("redactions: a one-word name is never searched for in free text; the name of a thing is free text", () => {
  const may = personRedactions({ id: ID, name: "May", email: "may@acme.com" }, "scrubbed");
  assert.deepEqual(may.name?.freeText, []);
  assert.equal(redactText("Back at work in May. I will be back.", may), "Back at work in May. I will be back.");
  const holiday = { holidayId: "h1", date: "2026-05-01", name: "May Day", actorId: "boss" };
  assert.deepEqual(redactJson(holiday, may), { value: holiday, changed: false });
  // A thing named after them (an API key, a holiday) loses their full name, as any free text does.
  const key = { apiKeyId: "k1", name: "Zebulon Quixtrade - Zapier", prefix: "ooohm_ab" };
  assert.deepEqual(redactJson(key, personRedactions(zeb, "scrubbed")).value, { ...key, name: `${TOMB} - Zapier` });
  assert.deepEqual(redactJson(key, personRedactions(zeb, "records_kept")), { value: key, changed: false }, "keeping records keeps the name");
  // Their own records still lose the name, one word or not.
  assert.deepEqual(redactJson({ userId: ID, email: "may@acme.com", name: "May" }, may).value, { userId: ID, email: TOMB_EMAIL, name: TOMB });
  const a = personRedactions({ id: ID, name: "A", email: "a@acme.com" }, "scrubbed");
  assert.equal(redactText("a cat and a dog", a), "a cat and a dog");
});

test("needles: the email and each full name's longest word, as written and as escaped inside JSON, plus the id on a scrub, lowercased", () => {
  const needles = redactionNeedles(personRedactions({ id: ID, name: 'Ana "Nan" Lima', email: "ana@x.io" }, "scrubbed"));
  assert.deepEqual(needles, ["ana@x.io", '"nan"', '\\"nan\\"', ID]);
  assert.deepEqual(redactionNeedles(personRedactions({ id: ID, name: "Ana Lima", email: "ana@x.io" }, "records_kept")), ["ana@x.io"]);
});

test("needles find every text the rewrite changes, however the name's words are spaced", () => {
  const r = personRedactions(zeb, "scrubbed", ["Zeb Q"]);
  const needles = redactionNeedles(r);
  const found = (stored: string) => needles.some((n) => stored.toLowerCase().includes(n));
  for (const text of ["Swapping with Zebulon  Quixtrade", "Zebulon\nQuixtrade covered", "ZEBULON\tQUIXTRADE", "cover: zeb   q", "zeb.q@example.com"]) {
    assert.notEqual(redactText(text, r), text, `the rewrite changes ${JSON.stringify(text)}`);
    assert.ok(found(text), `a plain column holding ${JSON.stringify(text)} is looked up`);
    const json = JSON.stringify({ reason: text });
    assert.ok(redactJson(JSON.parse(json), r).changed && found(json), `JSON holding ${json} is looked up`);
  }
});

test("a name another person of the company also goes by is left out of free text, the email never", () => {
  const sam = { id: ID, name: "Sam Lee", email: "sam.a@acme.com" };
  const shared = personRedactions(sam, "scrubbed", ["Sammy Lee"], ["sam  LEE", "Ana Lima"]);
  assert.deepEqual(shared.name?.freeText, ["Sammy Lee"], "the shared name is left out (case and spacing aside); the former one stays");
  assert.equal(redactText("Sam Lee: dentist, ask sam.a@acme.com", shared), `Sam Lee: dentist, ask ${TOMB_EMAIL}`);
  // The surviving Sam Lee's own records keep their name and free text.
  const theirs = { userId: "sam-b", name: "Sam Lee", email: "sam.b@acme.com", reason: "Raise for Sam Lee after review" };
  assert.deepEqual(redactJson(theirs, shared), { value: theirs, changed: false });
  // The deleted one's own records still lose the name.
  assert.equal((redactJson({ userId: ID, name: "Sam Lee" }, shared).value as { name: string }).name, `Former employee #${shortStableId(ID)}`);

  assert.equal(nameInUse({ name: "Sam Lee", deletionMode: null }), "Sam Lee");
  assert.equal(nameInUse({ name: "Sam Lee (deleted)", deletionMode: "records_kept" }), "Sam Lee", "their kept history still says it");
  assert.equal(nameInUse({ name: "Former employee #abc123", deletionMode: "scrubbed" }), null);
});

test("JSON: their own records lose name and email; another person's record keeps its name but loses free-text mentions", () => {
  const r = personRedactions(zeb, "scrubbed");
  const payload = {
    userId: ID,
    name: "Zebulon Quixtrade",
    email: "zeb.q@example.com",
    days: 2,
    nested: { list: ["Zebulon Quixtrade", 3, null, true] },
    "zeb.q@example.com": "a key",
    "Zebulon Quixtrade": "a key that is not an address stays",
  };
  const out = redactJson(payload, r);
  assert.equal(out.changed, true);
  assert.deepEqual(out.value, {
    userId: ID,
    name: TOMB,
    email: TOMB_EMAIL,
    days: 2,
    nested: { list: [TOMB, 3, null, true] },
    [TOMB_EMAIL]: "a key",
    "Zebulon Quixtrade": "a key that is not an address stays",
  });

  // The app's allowance audit row about Mia: `allowanceSnapshot` (with her userId) plus the admin's reason.
  const miaAllowance = { userId: "mia", leaveTypeId: "pto", year: 2026, days: 20, reason: "Covering for Zebulon Quixtrade (zeb.q@example.com)" };
  assert.deepEqual(redactJson(miaAllowance, r).value, { ...miaAllowance, reason: `Covering for ${TOMB} (${TOMB_EMAIL})` });

  const namesake = { userId: "other", name: "Zebulon Quixtrade", email: "zq2@example.com", note: "met zeb.q@example.com" };
  assert.deepEqual(redactJson(namesake, r).value, { ...namesake, note: `met ${TOMB_EMAIL}` }, "same name, other person: their name field stays");
  assert.equal(redactJson({ name: "Zebulon Quixtrade", email: "zq2@example.com" }, r).changed, false, "a snapshot identified by another email is theirs");
  assert.equal((redactJson({ name: "Zebulon Quixtrade", email: "ZEB.Q@example.com" }, r).value as { name: string }).name, TOMB);
  const report = { rows: [{ userId: ID, name: "Zebulon Quixtrade" }, { userId: "other", name: "Zebulon Quixtrade" }] };
  assert.deepEqual(
    (redactJson(report, r).value as typeof report).rows.map((x) => x.name),
    [TOMB, "Zebulon Quixtrade"],
  );
  assert.deepEqual(redactJson({ a: 1, b: ["x"] }, r), { value: { a: 1, b: ["x"] }, changed: false });
});

test("JSON: a name they had before a rename goes too, from their own records and, once known, from free text", () => {
  const owner = { id: ID, email: zeb.email };
  const created = { userId: ID, email: zeb.email, name: "Zeb Q", role: "employee" };
  const importUser = { name: "Zebby Quix", role: "employee" };
  assert.deepEqual(namesInOwnRecords(created, owner), ["Zeb Q"]);
  assert.deepEqual(namesInOwnRecords({ userId: "other", name: "Ana" }, owner), []);
  assert.deepEqual(namesInOwnRecords(importUser, owner), [], "a snapshot that says nothing of whose it is");
  assert.deepEqual(namesInOwnRecords(importUser, owner, true), ["Zebby Quix"], "unless the row is about their account");

  const r = personRedactions(zeb, "scrubbed", ["Zeb Q", "zebulon quixtrade", "Zebby Quix", "Zeb"]);
  assert.deepEqual(r.name?.freeText, ["Zebulon Quixtrade", "Zebby Quix", "Zeb Q"], "full names only, once each, longest first");
  assert.deepEqual(redactJson(created, r).value, { ...created, email: TOMB_EMAIL, name: TOMB });
  assert.equal(redactText("Cover for Zeb Q, then Zebby Quix", r), `Cover for ${TOMB}, then ${TOMB}`);
});

test("a stored body: redacted JSON, untouched when clean, refused when not JSON or still holding the email", () => {
  const r = personRedactions(zeb, "scrubbed");
  const body = JSON.stringify({ id: "e1", data: { userId: ID, email: zeb.email, name: zeb.name } });
  const out = redactJsonText(body, r);
  assert.ok(out && out.changed);
  assert.ok(!out.text.toLowerCase().includes("zebulon") && !out.text.includes(zeb.email));
  assert.deepEqual(JSON.parse(out.text).data, { userId: ID, email: TOMB_EMAIL, name: TOMB });
  const clean = JSON.stringify({ id: "e2", data: { userId: "other" } });
  assert.deepEqual(redactJsonText(clean, r), { text: clean, changed: false });
  assert.equal(redactJsonText(`not json ${zeb.email}`, r), null);
});

test("CSV: quoted when needed, formula-looking text neutralized, CRLF lines", () => {
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell('a "b", c'), '"a ""b"", c"');
  assert.equal(csvCell("line\nbreak"), '"line\nbreak"');
  assert.equal(csvCell("=HYPERLINK(1)"), "'=HYPERLINK(1)");
  assert.equal(csvCell("+1"), "'+1");
  assert.equal(csvCell("@cmd"), "'@cmd");
  assert.equal(csvCell(-1.5), "-1.5", "numbers stay numbers");
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(true), "yes");
  assert.equal(toCsv(["a", "b"], [[1, "x,y"], [null, "z"]]), 'a,b\r\n1,"x,y"\r\n,z\r\n');
});

test("a scheduled scrub is the system's change, made on the requesting admin's behalf", () => {
  const source = bySystem(CHANGE_PROCESSES.scheduledScrub, "boss");
  assert.deepEqual(source, { kind: "system", process: "scheduled_scrub", requestedBy: "boss" });
  assert.deepEqual(eventAttribution(source), { actorId: null, actor: { type: "system", process: "scheduled_scrub", requestedBy: "boss" } });
  const names = { person: (id: string) => ({ boss: "Peter Krzyzek" })[id], apiKey: () => undefined, adapter: () => undefined };
  assert.equal(changeSourceLabel(source, names), "System: scheduled deletion, requested by Peter Krzyzek");
  assert.equal(changeSourceLabel(bySystem(CHANGE_PROCESSES.scheduledScrub), names), "System: scheduled deletion");
  const row = { actorKind: "system", actorId: null, apiKeyId: null, actorVia: null, actorProcess: "scheduled_scrub", actorRequestedBy: "boss" };
  assert.equal(changeSourceLabel(recordedChangeSource(row), names), "System: scheduled deletion, requested by Peter Krzyzek");
  assert.equal(
    changeSourceLabel(recordedChangeSource({ ...row, actorRequestedBy: "gone" }), names),
    "System: scheduled deletion, requested by Someone",
  );
});

test("the records export answers OOOhm's own pages and typed links, never another site", () => {
  const site = (value?: string) => isCrossSiteRequest(new Headers(value === undefined ? {} : { "sec-fetch-site": value }));
  assert.deepEqual([site("same-origin"), site("none"), site()], [false, false, false]);
  assert.deepEqual([site("cross-site"), site("same-site")], [true, true]);
});
