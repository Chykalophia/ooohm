import assert from "node:assert/strict";
import { test } from "node:test";
import { addToCalendarLinks } from "@/domain/calendar-feed";
import { feedTokenHint } from "@/lib/feed-token";

const FEED = "https://hr.example.com/api/ics/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE.ics";

test("a new link opens straight in Google, Apple and Outlook, so nobody has to copy it", () => {
  const links = addToCalendarLinks(FEED, "OOOhm: Who's out at Northwind");
  // Apple subscribes from the webcal scheme.
  assert.equal(links.apple, "webcal://hr.example.com/api/ics/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE.ics");
  // Google takes the webcal address as `cid`.
  assert.equal(links.google, `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(links.apple)}`);
  // Outlook's "subscribe from web" takes the https address and a name.
  const outlook = new URL(links.outlook);
  assert.equal(outlook.origin + outlook.pathname, "https://outlook.office.com/calendar/0/addfromweb");
  assert.equal(outlook.searchParams.get("url"), FEED);
  assert.equal(outlook.searchParams.get("name"), "OOOhm: Who's out at Northwind");
});

test("a local http address becomes webcal too", () => {
  assert.equal(addToCalendarLinks("http://localhost:3000/api/ics/x.ics", "n").apple, "webcal://localhost:3000/api/ics/x.ics");
});

test("a link's hint is its last 4 characters, not enough to guess the rest", () => {
  assert.equal(feedTokenHint("AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"), "AbCdE".slice(-4));
});
