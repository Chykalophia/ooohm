import { type EmailCopy, fillTemplate } from "@/domain/email-template";
import { escapeHtml } from "@/lib/email-layout";

/** An email's words with every field set: its defaults, or an admin's copy over them. */
export interface CopyTemplate {
  subject: string;
  message: string;
}

/** A variable an email's copy may use, as the editor lists it. */
export interface CopyVariable {
  name: string;
  /** What it fills in, for the editor: "The requester's name". */
  description: string;
}

/** The copy to render: each field the admin saved, else the email's default. */
export function resolveCopy(defaults: CopyTemplate, saved?: EmailCopy | null): CopyTemplate {
  return { subject: saved?.subject ?? defaults.subject, message: saved?.message ?? defaults.message };
}

/** Longest subject sent once variables are filled. */
const SUBJECT_SENT_MAX = 200;

/**
 * The subject, filled: one line whatever the values hold, so nothing typed can add a
 * header, and capped.
 */
export function fillSubject(template: string, values: Readonly<Record<string, string>>): string {
  const line = fillTemplate(template, values)
    .map((p) => p.text)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > SUBJECT_SENT_MAX ? `${line.slice(0, SUBJECT_SENT_MAX - 1).trimEnd()}…` : line;
}

/** The message, filled, one entry a paragraph: plain text, and HTML with every piece escaped. */
export interface FilledMessage {
  text: string[];
  html: string[];
}

/**
 * The message split into paragraphs (at blank lines) and filled. A single line break
 * stays one (`<br>` in HTML). Values of the variables in `bold` are bold in HTML.
 */
export function fillMessage(template: string, values: Readonly<Record<string, string>>, bold: readonly string[] = []): FilledMessage {
  const out: FilledMessage = { text: [], html: [] };
  for (const paragraph of template.split(/\n{2,}/)) {
    const parts = fillTemplate(paragraph, values);
    out.text.push(parts.map((p) => p.text).join(""));
    out.html.push(
      parts
        .map((p) => {
          const html = escapeHtml(p.text).replace(/\n/g, "<br>");
          return p.variable && bold.includes(p.variable) ? `<b style="font-weight:600">${html}</b>` : html;
        })
        .join(""),
    );
  }
  return out;
}
