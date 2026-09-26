// Content of an outbound email (docs/architecture-integrations.md §1, "Contenido"): the subject and
// the plain-text body come from copy/es-MX-documents.ts with the order's data (and, for an alert,
// the verified case summary); this module checks them once more before SES and generates the
// minimal HTML part from the text. The only URL an email may carry is the console link of its own
// case in a `ZONE_CHIEF_ALERT` (`CP-NO-FOREIGN-LINKS`); a certificate carries none, and no email
// carries an address. The HTML escapes everything, so a summary can never become markup.
import { ChannelError } from "@cuadrilla/shared";
import type { EmailKind } from "../../domain/conversations";
import { MASK_SOURCES } from "../../lib/mask";
import { escapeAttribute, escapeMarkup } from "../normalizer";
import { assertHeaderText } from "./mime";

/** Longest subject and body (`OutboundEmail`, docs/architecture.md §5). */
export const MAX_SUBJECT_CHARS = 200;
export const MAX_BODY_CHARS = 20_000;

function invalid(message: string): ChannelError {
  return new ChannelError("INVALID", "EMAIL", message, { retryable: false });
}

/** `https://<domain>/app/cases/<caseId>`: the console page of a case (it requires a login). */
export function consoleCaseUrl(identityDomain: string, caseId: string): string {
  return `https://${identityDomain}/app/cases/${encodeURIComponent(caseId)}`;
}

const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"]+/gi;
const EMAIL_PATTERN = new RegExp(MASK_SOURCES.EMAIL);

export interface ContentContext {
  readonly kind: EmailKind;
  readonly identityDomain: string;
  readonly caseId?: string | undefined;
}

/** The URLs a body may carry: the alert's own case, and nothing else. */
export function allowedUrls(context: ContentContext): readonly string[] {
  return context.kind === "ZONE_CHIEF_ALERT" && context.caseId !== undefined ? [consoleCaseUrl(context.identityDomain, context.caseId)] : [];
}

/** Throws `INVALID` for a subject or body SES must never get. */
export function assertEmailContent(subject: string, body: string, context: ContentContext): void {
  assertHeaderText(subject, "subject");
  if ([...subject].length > MAX_SUBJECT_CHARS) throw invalid(`subject exceeds ${MAX_SUBJECT_CHARS} characters`);
  if (body.trim().length === 0) throw invalid("the body is empty");
  if (body.length > MAX_BODY_CHARS) throw invalid(`body exceeds ${MAX_BODY_CHARS} characters`);
  if (/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/.test(body)) throw invalid("the body has a control character");
  const allowed = allowedUrls(context);
  const urls = [...`${subject}\n${body}`.matchAll(URL_PATTERN)].map((match) => match[0].replace(/[.,;:)]+$/, ""));
  if (urls.some((url) => !allowed.includes(url))) throw invalid("the email carries a link other than its case in the console");
  if (EMAIL_PATTERN.test(`${subject}\n${body}`)) throw invalid("the email carries an email address");
}

function paragraphHtml(paragraph: string, allowed: readonly string[]): string {
  const lines = paragraph.split("\n").map((line) => {
    let html = escapeMarkup(line);
    for (const url of allowed) html = html.split(escapeMarkup(url)).join(`<a href="${escapeAttribute(url)}">${escapeMarkup(url)}</a>`);
    return html;
  });
  return `<p>${lines.join("<br>")}</p>`;
}

/** The HTML part: the text, escaped, paragraph by paragraph; the allowed console link as an anchor. */
export function htmlFromText(subject: string, body: string, context: ContentContext): string {
  const allowed = allowedUrls(context);
  const paragraphs = body.split(/\n{2,}/).filter((paragraph) => paragraph.trim().length > 0).map((paragraph) => paragraphHtml(paragraph, allowed));
  return [
    "<!doctype html>",
    '<html lang="es-MX"><head><meta charset="utf-8">',
    `<title>${escapeMarkup(subject)}</title></head>`,
    '<body style="font-family:Arial,Helvetica,sans-serif;line-height:1.5">',
    ...paragraphs,
    "</body></html>",
  ].join("\n");
}
