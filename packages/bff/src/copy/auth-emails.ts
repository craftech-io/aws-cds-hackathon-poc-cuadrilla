// The authentication emails of the Cognito custom message trigger (ADR-0025 §1,
// auth-triggers/custom-message.ts), in Mexican Spanish (tuteo) here and in English in
// auth-emails.en.ts: the code of the own sign-up and of its resend, the code of a forgotten password,
// and the operator's invitation. What each says: the product, the code, when it expires, "if you did
// not ask for it, ignore this email", the synthetic-demo notice and "Powered by Craftech".
//
// Rules of these texts (docs/test-plan.md §3):
//   - the NEUTRAL brand in every mode of BrandConfig: they go to addresses nobody verified yet;
//   - nothing the visitor wrote is ever interpolated (no name, no attribute): only the code and the
//     username placeholders Cognito fills (`{####}`, `{username}`) and fixed texts, so the sign-up form
//     can never carry a message of its own to somebody else's mailbox;
//   - every rule inline and a table layout (email clients drop <style>), one image (Craftech's PNG).
import { AUTH_EMAILS_EN } from "./auth-emails.en";

export const AUTH_EMAIL_KINDS = ["SIGN_UP", "RESEND_CODE", "FORGOT_PASSWORD", "ADMIN_CREATE_USER"] as const;
export type AuthEmailKind = (typeof AUTH_EMAIL_KINDS)[number];
export type AuthEmailLocale = "es-MX" | "en";

interface CodeEmailTexts {
  readonly subject: string;
  readonly title: string;
  readonly lead: string;
  readonly expiry: string;
  readonly ignore: string;
}

interface InvitationTexts extends CodeEmailTexts {
  readonly usernameLabel: string;
  readonly passwordLabel: string;
  readonly firstSteps: string;
  readonly button: string;
}

export interface AuthEmailTexts {
  readonly htmlLang: string;
  /** Appended to every subject. */
  readonly syntheticTag: string;
  readonly disclaimer: string;
  readonly poweredBy: string;
  readonly codeLabel: string;
  readonly SIGN_UP: CodeEmailTexts;
  readonly RESEND_CODE: CodeEmailTexts;
  readonly FORGOT_PASSWORD: CodeEmailTexts;
  readonly ADMIN_CREATE_USER: InvitationTexts;
}

export const PRODUCT_NAME = "Cuadrilla";

export const AUTH_EMAILS_ES: AuthEmailTexts = {
  htmlLang: "es-MX",
  syntheticTag: "(demo sintética)",
  disclaimer: "Cuadrilla es una demo con datos sintéticos: la operadora, el manual, las políticas, las personas y las órdenes son ficticios.",
  poweredBy: "Powered by",
  codeLabel: "Tu código",
  SIGN_UP: {
    subject: "Tu código para crear tu cuenta de Cuadrilla",
    title: "Confirma tu email",
    lead: "Usa este código para terminar de crear tu cuenta de prueba de Cuadrilla, el copiloto de campo en WhatsApp para instaladores de fibra.",
    expiry: "El código vence en 24 horas.",
    ignore: "Si no pediste esta cuenta, ignora este correo: sin el código no se crea nada.",
  },
  RESEND_CODE: {
    subject: "Tu nuevo código de Cuadrilla",
    title: "Tu nuevo código",
    lead: "Usa este código para confirmar tu cuenta de prueba de Cuadrilla.",
    expiry: "El código vence en 24 horas.",
    ignore: "Si no pediste esta cuenta, ignora este correo: sin el código no se crea nada.",
  },
  FORGOT_PASSWORD: {
    subject: "Tu código para restablecer la contraseña de Cuadrilla",
    title: "Restablece tu contraseña",
    lead: "Usa este código en Cuadrilla junto con tu contraseña nueva.",
    expiry: "El código vence en una hora.",
    ignore: "Si no lo pediste, ignora este correo: tu contraseña no cambió.",
  },
  ADMIN_CREATE_USER: {
    subject: "Tu acceso a la consola de Cuadrilla",
    title: "Te damos la bienvenida a Cuadrilla",
    lead: "Te invitaron a la consola de Cuadrilla, el copiloto de campo en WhatsApp para instaladores de fibra. Estos son tus datos para el primer ingreso:",
    usernameLabel: "Tu usuario",
    passwordLabel: "Contraseña temporal",
    firstSteps: "Entra con tu usuario y la contraseña temporal; después eliges una contraseña propia.",
    button: "Entrar a la consola",
    expiry: "La contraseña temporal vence en 7 días.",
    ignore: "Si no esperabas esta invitación, ignora este correo.",
  },
};

const TEXTS: Readonly<Record<AuthEmailLocale, AuthEmailTexts>> = { "es-MX": AUTH_EMAILS_ES, en: AUTH_EMAILS_EN };

/** `en` when the user's `locale` attribute says so; Mexican Spanish otherwise. */
export function authEmailLocale(locale: string | undefined): AuthEmailLocale {
  return locale === "en" ? "en" : "es-MX";
}

/** What Cognito fills in: the code (or temporary password) and, in the invitation, the username. */
export interface AuthEmailPlaceholders {
  readonly code: string;
  readonly username?: string;
}

export interface AuthEmailLinks {
  /** Absolute https sign-in URL of the console (the invitation's button). */
  readonly loginUrl: string;
  /** Absolute https URL of Craftech's PNG logo. */
  readonly logoUrl: string;
}

export interface RenderedAuthEmail {
  readonly subject: string;
  readonly html: string;
}

const INK = "#12161b";
const MUTED = "#57626e";
const LINE = "#dfe3e8";
const PAGE = "#f4f5f7";
const HEAD = "#1b1f24";
const ACCENT = "#8a6400";
const FONT = "Inter,Segoe UI,Helvetica,Arial,sans-serif";
const TABLE = 'role="presentation" cellpadding="0" cellspacing="0" border="0"';

const ENTITIES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (text: string): string => text.replace(/[&<>"']/g, (char) => ENTITIES[char] ?? char);

function httpsUrl(url: string): string {
  if (!/^https:\/\/[^\s"'<>]+$/.test(url)) throw new RangeError("an email link is an absolute https URL without quotes, spaces or angle brackets");
  return url;
}

const text = (content: string, size = 15, color = INK): string => `<p style="margin:0 0 14px;font:400 ${size}px/1.6 ${FONT};color:${color};">${esc(content)}</p>`;

// The code and the username are Cognito's placeholders, written as they are so Cognito replaces them.
function valueBox(rows: ReadonlyArray<readonly [string, string]>): string {
  const cells = rows
    .map(([label, value]) => `<p style="margin:0;font:600 11px/1.4 ${FONT};letter-spacing:.08em;text-transform:uppercase;color:${MUTED};">${esc(label)}</p><p style="margin:2px 0 12px;font:700 22px/1.3 Menlo,Consolas,monospace;color:${HEAD};letter-spacing:.06em;">${value}</p>`)
    .join("");
  return `<table ${TABLE} width="100%" style="margin:4px 0 16px;background:${PAGE};border:1px solid ${LINE};border-radius:10px;"><tr><td style="padding:16px 18px 4px;">${cells}</td></tr></table>`;
}

function button(href: string, label: string): string {
  return `<table ${TABLE} style="margin:4px 0 18px;"><tr><td style="background:${ACCENT};border-radius:10px;"><a href="${href}" style="display:inline-block;padding:13px 26px;font:700 15px/1 ${FONT};color:#ffffff;text-decoration:none;">${esc(label)}</a></td></tr></table>`;
}

function page(lang: string, title: string, body: string, footer: string): string {
  const wordmark = `<span style="font:700 20px/28px ${FONT};color:#ffffff;">${PRODUCT_NAME}</span>`;
  return [
    "<!doctype html>",
    `<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(title)}</title></head>`,
    `<body style="margin:0;padding:0;background:${PAGE};">`,
    `<table ${TABLE} width="100%" style="background:${PAGE};"><tr><td align="center" style="padding:24px 12px;">`,
    `<table ${TABLE} width="100%" style="max-width:560px;background:#ffffff;border:1px solid ${LINE};border-radius:12px;">`,
    `<tr><td style="background:${HEAD};padding:18px 28px;border-radius:12px 12px 0 0;">${wordmark}</td></tr>`,
    `<tr><td style="padding:26px 28px 8px;"><h1 style="margin:0 0 14px;font:700 22px/1.3 ${FONT};color:${HEAD};">${esc(title)}</h1>${body}</td></tr>`,
    `<tr><td style="border-top:1px solid ${LINE};padding:16px 28px 20px;">${footer}</td></tr>`,
    "</table></td></tr></table></body></html>",
  ].join("\n");
}

function footerOf(texts: AuthEmailTexts, links: AuthEmailLinks): string {
  const logo = `<img src="${httpsUrl(links.logoUrl)}" alt="Craftech" height="20" style="display:inline-block;height:20px;width:auto;border:0;vertical-align:middle;">`;
  return `${text(texts.disclaimer, 12, MUTED)}<p style="margin:0;font:400 12px/20px ${FONT};color:${MUTED};">${esc(texts.poweredBy)} ${logo}</p>`;
}

/** One email of one kind, in one language, with the neutral brand; `code` and `username` are Cognito's placeholders. */
export function renderAuthEmail(kind: AuthEmailKind, locale: AuthEmailLocale, placeholders: AuthEmailPlaceholders, links: AuthEmailLinks): RenderedAuthEmail {
  const texts = TEXTS[locale];
  const footer = footerOf(texts, links);
  const subject = `${texts[kind].subject} ${texts.syntheticTag}`;
  if (kind === "ADMIN_CREATE_USER") {
    const invite = texts.ADMIN_CREATE_USER;
    if (placeholders.username === undefined) throw new RangeError("the invitation names the username");
    const body = [
      text(invite.lead),
      valueBox([
        [invite.usernameLabel, placeholders.username],
        [invite.passwordLabel, placeholders.code],
      ]),
      text(invite.firstSteps),
      button(httpsUrl(links.loginUrl), invite.button),
      text(invite.expiry, 13, MUTED),
      text(invite.ignore, 13, MUTED),
    ].join("");
    return { subject, html: page(texts.htmlLang, invite.title, body, footer) };
  }
  const message = texts[kind];
  const body = [text(message.lead), valueBox([[texts.codeLabel, placeholders.code]]), text(message.expiry, 13, MUTED), text(message.ignore, 13, MUTED)].join("");
  return { subject, html: page(texts.htmlLang, message.title, body, footer) };
}
