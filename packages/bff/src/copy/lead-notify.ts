// Text of the notice Craftech receives for each confirmed lead (ADR-0026, docs/architecture-integrations.md
// §9.3), es-MX. It reaches an internal mailbox from a Craftech domain, and every field the visitor
// typed is untrusted, so:
//   - the visitor's fields go under "Datos declarados por el visitante, sin verificar";
//   - every URL or domain inside a field (and inside the attribution) is neutralized: the scheme goes
//     away and the dots become `[.]` (`ejemplo[.]com`), so no mail client turns it into a link;
//   - the HTML part is the same text with EVERY value escaped and no anchor at all;
//   - without the contact consent, the subject and the first line say "NO CONTACTAR".
// Neutral product text: no world data, no link, no word of ADR-0023.
import { escapeMarkup } from "../channels/normalizer";

export const LEAD_NOTICE_SENDER_NAME = "Cuadrilla · Leads";
export const LEAD_NOTICE_SENDER_LOCAL_PART = "leads";

/** `kind` email tag of the notice (the configuration set measures it apart from the auth emails). */
export const LEAD_NOTICE_KIND = "LEAD_NOTIFY";

const MAX_FIELD = 160;
const MAX_SUBJECT_COMPANY = 80;

export interface LeadNoticeInput {
  readonly leadId: string;
  readonly email: string;
  readonly name?: string | undefined;
  readonly company?: string | undefined;
  readonly jobTitle?: string | undefined;
  readonly locale: string;
  readonly contactAccepted: boolean;
  readonly contactVersion: string;
  readonly origin: "WEB" | "QA";
  readonly utm?: Readonly<Partial<Record<"source" | "medium" | "campaign" | "term" | "content", string>>> | undefined;
  readonly referrerOrigin?: string | undefined;
  /** ISO instant of the sign-up (the confirmation). */
  readonly signupAt: string;
  /** `leads:notify-test`: marked "PRUEBA", fictitious data. */
  readonly test?: boolean;
}

export interface LeadNotice {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/g;
const SCHEME = /\b(?:https?|ftp|file|javascript|data|vbscript|mailto|tel|sms|ws|wss):(?:\/\/)?/gi;
const DOMAIN = /(?<![\w-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?![\w-])/gi;
const IPV4 = /(?<![\w.])\d{1,3}(?:\.\d{1,3}){3}(?![\w.])/g;

/**
 * A value the visitor controls, made harmless for a mailbox: one line, no control character, no
 * scheme, every domain and IPv4 address with its dots as `[.]`, at most 160 characters.
 */
export function neutralizeVisitorText(value: string): string {
  const oneLine = value.replace(CONTROL, " ").replace(SCHEME, "");
  const defanged = oneLine.replace(DOMAIN, (domain) => domain.replace(/\./g, "[.]")).replace(IPV4, (ip) => ip.replace(/\./g, "[.]"));
  const compact = defanged.replace(/\s+/g, " ").trim();
  return [...compact].length > MAX_FIELD ? `${[...compact].slice(0, MAX_FIELD - 1).join("")}…` : compact;
}

/** `2026-09-26 14:05 UTC` (no Intl: the Lambdas format by hand, scripts/lint/no-intl.ts). */
function formatInstant(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "sin fecha";
  const text = at.toISOString();
  return `${text.slice(0, 10)} ${text.slice(11, 16)} UTC`;
}

const LANGUAGE: Readonly<Record<string, string>> = { "es-MX": "español (es-MX)", en: "inglés (en)" };

function declared(label: string, value: string | undefined): string {
  const shown = value === undefined ? "" : neutralizeVisitorText(value);
  return `${label}: ${shown.length > 0 ? shown : "(no lo indicó)"}`;
}

function utmLine(utm: LeadNoticeInput["utm"]): string {
  const entries = Object.entries(utm ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0);
  if (entries.length === 0) return "UTM: (sin etiquetas)";
  return `UTM: ${entries.map(([key, value]) => `${key}=${neutralizeVisitorText(value)}`).join(", ")}`;
}

/** Subject, plain text and minimal HTML of one notice. */
export function renderLeadNotice(input: LeadNoticeInput): LeadNotice {
  // A header shows no markup at all: angle brackets out of the company that goes in the subject.
  const company = input.company === undefined ? "" : neutralizeVisitorText(input.company).replace(/[<>]/g, "").trim();
  const companyShown = company.length === 0 ? "sin empresa" : [...company].slice(0, MAX_SUBJECT_COMPANY).join("");
  const warnings: string[] = [];
  if (!input.contactAccepted) warnings.push("NO CONTACTAR");
  if (input.test === true) warnings.push("PRUEBA");
  const subject = [...warnings, "Nuevo lead de la demo Cuadrilla", companyShown].join(" · ");

  const first: string[] = [];
  if (!input.contactAccepted) first.push("NO CONTACTAR: esta persona no aceptó que Craftech la contacte por esta solución.");
  if (input.test === true) first.push("PRUEBA: aviso de prueba con datos ficticios; no corresponde a ninguna persona.");

  const text = [
    ...first,
    "Nuevo lead de la demo Cuadrilla.",
    "",
    `Referencia: ${input.leadId}`,
    `Fecha de alta: ${formatInstant(input.signupAt)}`,
    `Idioma: ${LANGUAGE[input.locale] ?? "sin indicar"}`,
    `Consentimiento de contacto: ${input.contactAccepted ? "sí" : "no"} (versión ${input.contactVersion})`,
    `Origen: ${input.origin === "WEB" ? "web" : "prueba interna"}`,
    `Sitio de referencia: ${input.referrerOrigin === undefined ? "(sin dato)" : neutralizeVisitorText(input.referrerOrigin)}`,
    utmLine(input.utm),
    "",
    "Datos declarados por el visitante, sin verificar:",
    declared("Nombre", input.name),
    declared("Empresa", input.company),
    declared("Cargo", input.jobTitle),
    declared("Email", input.email),
    "",
    "Si la persona pide borrar sus datos o no ser contactada, usa la referencia de este aviso.",
  ].join("\n");

  return { subject, text, html: htmlOf(subject, text) };
}

/** The text, escaped line by line, paragraphs on blank lines; never an anchor. */
function htmlOf(subject: string, text: string): string {
  const paragraphs = text
    .split(/\n{2,}/)
    .filter((paragraph) => paragraph.trim().length > 0)
    .map((paragraph) => `<p>${paragraph.split("\n").map(escapeMarkup).join("<br>")}</p>`);
  return [
    "<!doctype html>",
    '<html lang="es-MX"><head><meta charset="utf-8">',
    '<meta name="format-detection" content="telephone=no,date=no,address=no,email=no,url=no">',
    `<title>${escapeMarkup(subject)}</title></head>`,
    '<body style="font-family:Arial,Helvetica,sans-serif;line-height:1.5">',
    ...paragraphs,
    "</body></html>",
  ].join("\n");
}
