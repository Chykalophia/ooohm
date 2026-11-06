/**
 * CSV (RFC 4180): writing downloads that open in a spreadsheet, and reading uploads. Pure.
 */

import { DomainError } from "./errors";

export type CsvCell = string | number | boolean | null | undefined;

/**
 * Characters that make a spreadsheet read a cell as a formula. A cell starting with one
 * gets a leading `'`, so text a person typed (a leave note) can never run as a formula
 * when an admin opens the file (CSV injection).
 */
const FORMULA_START = /^[=+\-@\t\r]/;

/** One cell: quoted when it holds a comma, quote or line break; formula-looking text neutralized. */
export function csvCell(value: CsvCell): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "yes" : "no";
  const text = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** A whole CSV document: a header row, then each row, lines ending in CRLF. */
export function toCsv(header: readonly string[], rows: readonly (readonly CsvCell[])[]): string {
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/**
 * Reads a CSV document (RFC 4180, as spreadsheets save it) into rows of cells. Cells are
 * returned as written, untrimmed. Lines may end in CRLF, LF or a lone CR; a leading byte
 * order mark and one trailing line break are dropped.
 *
 * @throws DomainError `invalid_input` when a quoted cell is never closed.
 */
export function parseCsv(text: string): string[][] {
  const source = text.startsWith("﻿") ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let i = 0;
  const endRow = () => {
    row.push(cell);
    rows.push(row);
    row = [];
    cell = "";
  };
  while (i < source.length) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        cell += ch;
      }
      i++;
      continue;
    }
    if (ch === '"' && cell === "") quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\r" || ch === "\n") {
      endRow();
      if (ch === "\r" && source[i + 1] === "\n") i++;
    } else cell += ch;
    i++;
  }
  if (quoted) throw new DomainError("invalid_input", "A quoted cell in the file is never closed.");
  if (cell !== "" || row.length > 0) endRow();
  return rows;
}
