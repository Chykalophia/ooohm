import assert from "node:assert/strict";
import { test } from "node:test";
import { earliestOverlappingStart, MAX_REQUEST_SPAN_DAYS } from "@/domain/leave-request";
import { spanInDays } from "@/domain/calendar-date";
import { personLabel, teamLabel } from "@/domain/person";
import { clientAddress, SHARED_CLIENT } from "@/lib/client-address";

const person = (name: string, email = "ana.lima@acme.example") => ({ name, email });

test("team labels use the name, else the email's local part, never the full address", () => {
  assert.equal(teamLabel(person("Ana Lima")), "Ana Lima");
  assert.equal(teamLabel(person("  Ana\n  Lima ")), "Ana Lima", "one line, trimmed");
  assert.equal(teamLabel(person("")), "ana.lima");
  assert.equal(teamLabel(person(" \t\n ")), "ana.lima");
  assert.ok(!teamLabel(person("")).includes("@"));
  assert.equal(teamLabel(person("", "@acme.example")), "A teammate", "nothing usable at all");
});

test("email labels still fall back to the full address, paired against team labels", () => {
  assert.equal(personLabel(person("")), "ana.lima@acme.example");
  assert.notEqual(personLabel(person("")), teamLabel(person("")));
  assert.equal(personLabel(person("Ana")), teamLabel(person("Ana")), "a real name reads the same in both");
});

test("the earliest start that can still reach a date is exactly the longest span away", () => {
  const date = "2026-11-01";
  const earliest = earliestOverlappingStart(date);
  assert.equal(earliest, "2025-11-01");
  assert.equal(spanInDays(earliest, date), MAX_REQUEST_SPAN_DAYS, "a maximal request from there just reaches the date");
});

const h = (init: Record<string, string>) => new Headers(init);

test("with no trusted proxy, every caller shares one key whatever headers it sends", () => {
  // Next fills X-Forwarded-For from the socket only when it is missing, so here the
  // client wrote it: rotating it or naming someone else's address must change nothing.
  const spoofs: Record<string, string>[] = [
    {},
    { "x-forwarded-for": "203.0.113.9" },
    { "x-forwarded-for": "1.2.3.4, 198.51.100.7" },
    { "x-real-ip": "198.51.100.8" },
  ];
  for (const headers of spoofs) assert.equal(clientAddress(h(headers), 0), SHARED_CLIENT, JSON.stringify(headers));
});

test("behind trusted proxies, the key is the entry the outermost one wrote, not the client's", () => {
  assert.equal(clientAddress(h({ "x-forwarded-for": "203.0.113.9" }), 1), "203.0.113.9", "an overwriting proxy");
  assert.equal(clientAddress(h({ "x-forwarded-for": "1.2.3.4, 198.51.100.7" }), 1), "198.51.100.7", "a spoofed first entry is ignored");
  assert.equal(clientAddress(h({ "x-forwarded-for": "1.1.1.1,  2001:db8::1 " }), 1), "2001:db8::1");
  assert.equal(clientAddress(h({ "x-forwarded-for": "1.2.3.4, 198.51.100.7, 10.0.0.2" }), 2), "198.51.100.7", "two hops: the CDN's entry is skipped");
  assert.equal(clientAddress(h({ "x-real-ip": "198.51.100.8" }), 1), SHARED_CLIENT, "X-Real-IP alone is not trusted");
});

test("behind trusted proxies, a short list or a non-address entry falls back to the shared key", () => {
  assert.equal(clientAddress(h({}), 1), SHARED_CLIENT);
  assert.equal(clientAddress(h({ "x-forwarded-for": "" }), 1), SHARED_CLIENT);
  assert.equal(clientAddress(h({ "x-forwarded-for": "198.51.100.7" }), 2), SHARED_CLIENT, "fewer entries than hops");
  assert.equal(clientAddress(h({ "x-forwarded-for": "1.2.3.4, not-an-ip" }), 1), SHARED_CLIENT);
});
