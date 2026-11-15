import "server-only";
import type { EmailCopy } from "@/domain/email-template";
import type { NotificationKind } from "./catalog";
import type { CopyTemplate, CopyVariable } from "./templates/copy";
import type { EmailContent } from "./types";

/** One email as Admin → Emails lists it. */
export interface EmailListItemDTO {
  type: NotificationKind;
  label: string;
  description: string;
  /** The company has its own words for it. */
  customized: boolean;
}

/** One email as its editor opens it. */
export interface EmailEditorDTO {
  type: NotificationKind;
  label: string;
  description: string;
  /** The variables its subject and message may use. */
  variables: CopyVariable[];
  /** OOOhm's own words. */
  defaults: CopyTemplate;
  /** The company's saved words (`null` fields are the defaults), or `null` when it uses the defaults. */
  saved: EmailCopy | null;
}

/** An email as a preview renders it. */
export interface EmailPreviewDTO {
  subject: string;
  text: string;
  html: string;
}

export function toEmailListItemDTO({ type, label, description, customized }: EmailListItemDTO): EmailListItemDTO {
  return { type, label, description, customized };
}

export function toEmailEditorDTO(email: {
  type: NotificationKind;
  label: string;
  description: string;
  variables: readonly CopyVariable[];
  defaults: CopyTemplate;
  saved: EmailCopy | null;
}): EmailEditorDTO {
  return {
    type: email.type,
    label: email.label,
    description: email.description,
    variables: email.variables.map(({ name, description }) => ({ name, description })),
    defaults: { subject: email.defaults.subject, message: email.defaults.message },
    saved: email.saved && { subject: email.saved.subject, message: email.saved.message },
  };
}

export function toEmailPreviewDTO({ subject, text, html }: EmailContent): EmailPreviewDTO {
  return { subject, text, html };
}
