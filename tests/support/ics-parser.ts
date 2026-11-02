/**
 * A strict iCalendar (RFC 5545) reader for tests. It fails on anything the spec forbids
 * that a serializer could get wrong, so feed output is validated structurally rather
 * than by string matching.
 */
import assert from "node:assert/strict";

export interface IcsProperty {
  name: string;
  params: Record<string, string>;
  value: string;
}

export interface IcsComponent {
  name: string;
  properties: IcsProperty[];
  components: IcsComponent[];
}

const MAX_LINE_OCTETS = 75;
const CONTENT_LINE = /^([A-Z][A-Z0-9-]*)((?:;[A-Z0-9-]+=[^;:"]*)*):(.*)$/;

/**
 * Parses a document with exactly one VCALENDAR. Fails on a bare CR or LF, a missing
 * final CRLF, a physical line over 75 octets, a fold that splits a character, a
 * malformed content line, or unbalanced BEGIN/END.
 */
export function parseIcs(text: string): IcsComponent {
  assert.ok(text.endsWith("\r\n"), "ends with CRLF");
  const physical = text.slice(0, -2).split("\r\n");
  for (const line of physical) {
    assert.ok(!/[\r\n]/.test(line), `no bare CR or LF in ${JSON.stringify(line)}`);
    assert.ok(Buffer.byteLength(line, "utf8") <= MAX_LINE_OCTETS, `at most 75 octets: ${JSON.stringify(line)}`);
    assert.ok(line.isWellFormed(), `no character split by a fold: ${JSON.stringify(line)}`);
  }
  const logical: string[] = [];
  for (const line of physical) {
    if (line.startsWith(" ")) {
      assert.ok(logical.length > 0, "a continuation line follows a content line");
      logical[logical.length - 1] += line.slice(1);
    } else {
      logical.push(line);
    }
  }
  const root: IcsComponent = { name: "", properties: [], components: [] };
  const stack: IcsComponent[] = [root];
  for (const line of logical) {
    const m = CONTENT_LINE.exec(line);
    assert.ok(m, `well-formed content line: ${JSON.stringify(line)}`);
    const [, name, rawParams, value] = m;
    const params = Object.fromEntries(
      rawParams
        .split(";")
        .filter(Boolean)
        .map((p) => p.split("=") as [string, string]),
    );
    if (name === "BEGIN") {
      const child: IcsComponent = { name: value, properties: [], components: [] };
      stack.at(-1)!.components.push(child);
      stack.push(child);
    } else if (name === "END") {
      assert.equal(stack.pop()?.name, value, `END:${value} closes the open component`);
    } else {
      stack.at(-1)!.properties.push({ name, params, value });
    }
  }
  assert.equal(stack.length, 1, "every BEGIN has its END");
  assert.equal(root.components.length, 1, "exactly one VCALENDAR");
  const vcal = root.components[0];
  assert.equal(vcal.name, "VCALENDAR");
  only(vcal, "VERSION");
  only(vcal, "PRODID");
  for (const vevent of vcal.components) {
    assert.equal(vevent.name, "VEVENT");
    for (const required of ["UID", "DTSTAMP", "DTSTART"]) only(vevent, required);
  }
  return vcal;
}

/** The one property `name` of `component`; fails when there are none or several. */
export function only(component: IcsComponent, name: string): IcsProperty {
  const found = component.properties.filter((p) => p.name === name);
  assert.equal(found.length, 1, `${component.name} has exactly one ${name}`);
  return found[0];
}

/** Reverses TEXT escaping (RFC 5545 §3.3.11). */
export function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));
}
