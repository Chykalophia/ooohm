import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { pagerLinks, readPageParams } from "@/app/_lib/paging";
import { type PageCursor, type PageRequest, decodePageKey, encodePageKey, isCursorInstant, readPage, textPart } from "@/domain/paging";

/** A list sorted by its one key, read the way a repository reads it, counting reads. */
function list(keys: string[]) {
  const sorted = [...keys].sort();
  const reads: (PageRequest | undefined)[] = [];
  const read = async (request: PageRequest | undefined, limit: number) => {
    reads.push(request);
    if (!request) return sorted.slice(0, limit);
    const [k] = request.key;
    return request.direction === "after"
      ? sorted.filter((x) => x > k).slice(0, limit)
      : sorted
          .filter((x) => x < k)
          .reverse()
          .slice(0, limit);
  };
  const page = (cursor: PageCursor | undefined, size = 3) =>
    readPage({ cursor, size, checks: [textPart(10)], read, keyOf: (x: string) => [x] });
  return { page, reads, sorted };
}

const letters = (n: number) => Array.from({ length: n }, (_, i) => String.fromCharCode(97 + i));

describe("readPage", () => {
  test("forward through the whole list: every row once, in order, one read per page", async () => {
    const l = list(letters(8));
    const pages: string[][] = [];
    let cursor: PageCursor | undefined;
    do {
      const p = await l.page(cursor);
      assert.equal(p.previous === null, pages.length === 0);
      pages.push(p.items);
      cursor = p.next ?? undefined;
    } while (cursor);
    assert.deepEqual(pages, [
      ["a", "b", "c"],
      ["d", "e", "f"],
      ["g", "h"],
    ]);
    assert.equal(l.reads.length, 3);
  });

  test("back from the last page gives the same pages, and page 1 has no previous", async () => {
    const l = list(letters(8));
    const third = await l.page({ direction: "after", token: encodePageKey(["f"]) });
    const second = await l.page(third.previous!);
    assert.deepEqual(second.items, ["d", "e", "f"]);
    assert.ok(second.next && second.previous);
    const first = await l.page(second.previous!);
    assert.deepEqual([first.items, first.previous], [["a", "b", "c"], null]);
    assert.deepEqual((await l.page(first.next!)).items, ["d", "e", "f"]);
  });

  test("a list of exactly one page has no pager; one more row makes a second page", async () => {
    const exact = await list(letters(3)).page(undefined);
    assert.deepEqual([exact.items, exact.previous, exact.next], [["a", "b", "c"], null, null]);
    const over = await list(letters(4)).page(undefined);
    assert.deepEqual(over.items, ["a", "b", "c"]);
    assert.ok(over.next);
    const last = await list(letters(4)).page(over.next!);
    assert.deepEqual([last.items, last.next === null, last.previous !== null], [["d"], true, true]);
  });

  test("an empty list is one empty page", async () => {
    assert.deepEqual(await list([]).page(undefined), { items: [], previous: null, next: null });
  });

  test("going back with less than a page left shows the real first page, full", async () => {
    // Only two rows come before "c" (say, rows were removed meanwhile): Previous shows page 1 as it is, not two rows.
    const l = list(letters(8));
    const p = await l.page({ direction: "before", token: encodePageKey(["c"]) });
    assert.deepEqual([p.items, p.previous], [["a", "b", "c"], null]);
    assert.equal(l.reads.length, 2, "the short read, then the first page");
  });

  test("past the end (the last rows were removed): no rows, and Previous leads back", async () => {
    const l = list(letters(4));
    const p = await l.page({ direction: "after", token: encodePageKey(["z"]) });
    assert.deepEqual([p.items, p.next], [[], null]);
    assert.deepEqual((await l.page(p.previous!)).items, ["b", "c", "d"]);
  });

  test("back to a page whose following rows have gone since: no Next leading to an empty page", async () => {
    // Someone on page 3 decided everything there, then went back.
    const before = list(letters(8));
    const third = await before.page({ direction: "after", token: encodePageKey(["f"]) });
    const after = list(letters(6));
    const second = await after.page(third.previous!);
    assert.deepEqual([second.items, second.next], [["d", "e", "f"], null]);
    assert.ok(second.previous, "the earlier pages are still there");
    // With rows still after it, Next stays.
    assert.ok((await list(letters(7)).page(third.previous!)).next);
  });

  test("rows added between pages are neither skipped nor repeated", async () => {
    const keys = ["b", "d", "f", "h", "j", "l"];
    const before = await list(keys).page(undefined);
    const after = await list([...keys, "a", "c", "k"]).page(before.next!);
    assert.deepEqual(
      [before.items, after.items],
      [
        ["b", "d", "f"],
        ["h", "j", "k"],
      ],
    );
  });

  test("a token that does not decode, or fails a check, reads as the first page", async () => {
    for (const token of [
      "",
      "%%%",
      "bm90LWpzb24",
      encodePageKey([]),
      encodePageKey(["a", "b"]),
      encodePageKey(["x".repeat(11)]),
      "a".repeat(4_001),
    ]) {
      for (const direction of ["after", "before"] as const) {
        const p = await list(letters(5)).page({ direction, token });
        assert.deepEqual([p.items, p.previous], [["a", "b", "c"], null], `${direction} ${token.slice(0, 20)}`);
      }
    }
  });
});

describe("page keys", () => {
  test("round-trip any text, accents and all, in a URL-safe token", () => {
    const key = ["zoë o'brien-łukasz 李", "a+b/c=d@example.com"];
    const token = encodePageKey(key);
    assert.match(token, /^[A-Za-z0-9_-]+$/);
    assert.deepEqual(decodePageKey(token, [textPart(100), textPart(100)]), key);
    assert.equal(decodePageKey(token, [textPart(100)]), undefined, "the wrong number of parts");
    assert.equal(decodePageKey(encodePageKey(["1", "2"]).slice(0, -2) + "!!", [textPart(9), textPart(9)]), undefined);
  });

  test("cursor instants: the microsecond UTC shape, and a real moment", () => {
    assert.ok(isCursorInstant("2026-10-01T12:00:00.123456Z"));
    assert.ok(isCursorInstant("2028-02-29T23:59:59.000000Z"));
    for (const bad of [
      "2026-10-01T12:00:00Z",
      "2026-10-01T12:00:00.123Z",
      "2026-02-30T12:00:00.000000Z",
      "2026-10-01T24:00:00.000000Z",
      "2027-02-29T00:00:00.000000Z",
    ]) {
      assert.equal(isCursorInstant(bad), false, bad);
    }
  });
});

describe("page links", () => {
  const next: PageCursor = { direction: "after", token: "NX" };
  const previous: PageCursor = { direction: "before", token: "PV" };

  test("page 1 links to page 2 only, keeping the filters and the fragment", () => {
    assert.deepEqual(
      pagerLinks("/admin/audit", { previous: null, next }, 1, { keep: { action: "user.created", actor: undefined }, fragment: "log" }),
      {
        number: 1,
        first: null,
        previous: null,
        next: "/admin/audit?action=user.created&after=NX&page=2#log",
      },
    );
  });

  test("Previous from page 2 is the plain first page; from page 3 on, First page appears", () => {
    assert.equal(pagerLinks("/x", { previous, next }, 2).previous, "/x");
    assert.deepEqual(pagerLinks("/x", { previous, next }, 3), {
      number: 3,
      first: "/x",
      previous: "/x?before=PV&page=2",
      next: "/x?after=NX&page=4",
    });
  });

  test("the number is a label: without a previous page it is 1, with one at least 2", () => {
    assert.equal(pagerLinks("/x", { previous: null, next }, 7).number, 1);
    assert.equal(pagerLinks("/x", { previous, next: null }, 1).number, 2);
  });

  test("reading the link: one of after or before, a sane page number, else the first page", () => {
    assert.deepEqual(readPageParams({ after: "abc", page: "4" }), { cursor: { direction: "after", token: "abc" }, number: 4 });
    assert.deepEqual(readPageParams({ before: "abc" }), { cursor: { direction: "before", token: "abc" }, number: 2 });
    for (const params of [{}, { after: "a", before: "b" }, { after: ["a", "b"] }, { after: "has space" }, { page: "3" }]) {
      assert.deepEqual(readPageParams(params), { cursor: undefined, number: 1 }, JSON.stringify(params));
    }
    assert.equal(readPageParams({ after: "a", page: "0" }).number, 2, "a bad number falls back");
  });
});
