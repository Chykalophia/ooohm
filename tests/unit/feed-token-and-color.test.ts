import assert from "node:assert/strict";
import { test } from "node:test";
import { CALENDAR_FEED_EVENT_TYPES, calendarFeedAuditAction } from "@/domain/events";
import { contrastRatio, normalizeHexColor, readableTextColor } from "@/lib/color";
import {
  feedLogId,
  feedPath,
  generateFeedToken,
  hashFeedToken,
  isFeedTokenShape,
  tokenFromFeedFileName,
} from "@/lib/feed-token";
import { formatInstantDate, formatLongDate, formatMonth } from "@/lib/format";

test("feed tokens are 32 random bytes in base64url, different every time", () => {
  const tokens = new Set(Array.from({ length: 200 }, generateFeedToken));
  assert.equal(tokens.size, 200);
  for (const token of tokens) {
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(token, "base64url").length, 32);
    assert.ok(isFeedTokenShape(token));
  }
});

test("the stored hash is the token's SHA-256 in hex, and never contains the token", () => {
  assert.equal(hashFeedToken("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const token = generateFeedToken();
  const hash = hashFeedToken(token);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.ok(!hash.includes(token));
  assert.equal(feedLogId(token), hash.slice(0, 8));
  assert.ok(!token.startsWith(feedLogId(token)));
});

test("only <token>.ics names a feed; everything else is refused before any lookup", () => {
  const token = generateFeedToken();
  assert.equal(tokenFromFeedFileName(`${token}.ics`), token);
  assert.equal(feedPath(token), `/api/ics/${token}.ics`);
  for (const bad of [token, `${token}.ICS`, `${token}.ics.ics`, `${token.slice(1)}.ics`, `${token}A.ics`, `${token.slice(0, 42)}=.ics`, `${token.slice(0, 42)}+.ics`, ".ics", "../x.ics"]) {
    assert.equal(tokenFromFeedFileName(bad), null, bad);
  }
});

test("feed event names are a public contract", () => {
  assert.deepEqual(CALENDAR_FEED_EVENT_TYPES, { issued: "calendar_feed.issued", revoked: "calendar_feed.revoked" });
  assert.equal(calendarFeedAuditAction("issued"), "calendar_feed.issued");
  assert.equal(calendarFeedAuditAction("revoked"), "calendar_feed.revoked");
});

test("leave type colours are normalized, with a fallback for anything that isn't hex", () => {
  assert.equal(normalizeHexColor("#0F766E"), "#0f766e");
  assert.equal(normalizeHexColor("#abc"), "#aabbcc");
  assert.equal(normalizeHexColor(" #be123c "), "#be123c");
  for (const bad of ["red", "#12345", "url(x)", "#0f766e; background: red", ""]) assert.equal(normalizeHexColor(bad), "#6b7280", bad);
});

test("chip text is black or white, whichever is legible on the colour", () => {
  // The seeded leave types (dark) take white; pale colours take black.
  for (const dark of ["#0f766e", "#b45309", "#be123c", "#7c3aed", "#1c1917"]) assert.equal(readableTextColor(dark), "#ffffff", dark);
  for (const light of ["#fde047", "#a7f3d0", "#ffffff", "#e7e5e4"]) assert.equal(readableTextColor(light), "#000000", light);
  // Whichever is picked reaches at least 4.5:1 for every grey from black to white.
  for (let v = 0; v <= 255; v += 5) {
    const grey = `#${v.toString(16).padStart(2, "0").repeat(3)}`;
    assert.ok(contrastRatio(grey, readableTextColor(grey)) >= 4.5, grey);
  }
});

test("months and instants read naturally, in the right time zone", () => {
  assert.equal(formatMonth("2026-11"), "November 2026");
  assert.equal(formatLongDate("2026-11-26"), "Thursday, November 26, 2026");
  // 03:00 UTC on Nov 2 is still Nov 1 in Chicago.
  assert.equal(formatInstantDate(new Date("2026-11-02T03:00:00Z"), "America/Chicago"), "Nov 1, 2026");
  assert.equal(formatInstantDate(new Date("2026-11-02T03:00:00Z"), "UTC"), "Nov 2, 2026");
});
