/** One email as a template renders it: always plain text and an HTML twin. */
export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}
