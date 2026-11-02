/**
 * CSV writing (RFC 4180) for downloads that open in a spreadsheet. Pure.
 */

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
