// Pure half of the console's Cognito user pool (infra/auth.ts): the settings the pool and its web
// client are built from, the brand and the sender of the emails Cognito sends, and those emails (the
// invitation of AdminCreateUser and the code message ForgotPassword uses). No SST or Pulumi
// dependency, so infra/auth-email.test.ts checks every value without an AWS account, and
// scripts/console/invite.ts can read the groups, the informative attribute and the password policy.
//
// Brand (ADR-0018). Cognito keeps one template per pool, so the brand is resolved on each deploy from
// the BrandConfig secret: "Cuadrilla" in `neutral`, "Cuadrilla for <partner>" in `cobrand`, with the
// synthetic-demo notice in both and "(demo sintética)" in every subject. The partner's name and its
// notice come only from the secret; this file never names an operator. The From header is generic
// ("Cuadrilla") in both modes.
//
// Email clients drop <style> blocks and SVG, so every rule is inline, the layout is tables and the
// only image is Craftech's PNG logo on an absolute URL of the app domain (packages/web/public/brand).
// Cognito replaces `{username}` (invitation only) and `{####}` (temporary password or code) and takes
// up to 20,000 characters per message and 140 per subject. Texts are Mexican Spanish with tuteo, like
// every text the operator's staff reads (ADR-0013).
import { BrandConfigValue } from "../packages/bff/src/lib/secret-schemas";

export const PRODUCT_NAME = "Cuadrilla";

// ---- Pool and web client -----------------------------------------------------------------------

/** Console roles, one Cognito group each; the lowest precedence wins in `cognito:preferred_role`. */
export const CONSOLE_GROUPS = {
  SUPERVISOR: { precedence: 10, description: "Crew supervisor: sees and acts, takes cases and validates evidence by hand" },
  JUDGE: { precedence: 20, description: "Hackathon judge: supervisor permissions inside the judge's own demo world, no TOTP" },
  OPS: { precedence: 30, description: "Operations: sees orders, cases, evidence and certificates, never validates" },
} as const;

export type ConsoleGroup = keyof typeof CONSOLE_GROUPS;

export const CONSOLE_GROUP_NAMES = Object.keys(CONSOLE_GROUPS) as ConsoleGroup[];

/**
 * Informative only: set by the invitation, readable by the web client, never writable by it and
 * never trusted. The pre token trigger takes `ispId` and the role from `Isps/USER#` by `sub`.
 */
export const ISP_ID_ATTRIBUTE = "ispId";
export const ISP_ID_CLAIM = `custom:${ISP_ID_ATTRIBUTE}`;

/** Also the rules the console checks before sending (packages/web/src/lib/auth/credentials.ts). */
export const PASSWORD_POLICY = {
  minimumLength: 12,
  requireLowercase: true,
  requireUppercase: true,
  requireNumbers: true,
  requireSymbols: true,
  temporaryPasswordValidityDays: 7,
} as const;

/** Build-time variables of the console, as packages/web/src/lib/env.ts reads them. */
export const WEB_ENV_NAMES = { userPoolId: "VITE_COGNITO_USER_POOL_ID", clientId: "VITE_COGNITO_CLIENT_ID" } as const;

// Public client of the browser: SRP and refresh only, no secret, no OAuth, no hosted UI (the
// placeholder callback URL SST puts on a client is cleared). Tokens live 15 minutes because the BFF
// verifies them offline, so a revoked or copied token is usable until it expires; the console
// refreshes silently with the 12-hour refresh token. The only attribute a user may write is the
// display name: never `custom:*`, never the email.
export const WEB_CLIENT_SETTINGS = {
  generateSecret: false,
  allowedOauthFlowsUserPoolClient: false,
  allowedOauthFlows: [],
  allowedOauthScopes: [],
  callbackUrls: [],
  logoutUrls: [],
  supportedIdentityProviders: ["COGNITO"],
  explicitAuthFlows: ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
  preventUserExistenceErrors: "ENABLED",
  enableTokenRevocation: true,
  accessTokenValidity: 15,
  idTokenValidity: 15,
  refreshTokenValidity: 12,
  tokenValidityUnits: { accessToken: "minutes", idToken: "minutes", refreshToken: "hours" },
  readAttributes: ["email", "email_verified", "name", ISP_ID_CLAIM],
  writeAttributes: ["name"],
};

/**
 * What infra/auth.ts lays over SST's pool defaults, besides the messages. ESSENTIALS is the feature
 * plan that runs the pre token generation trigger V2_0 (free up to 10,000 monthly active users,
 * nothing billed by the hour). Recovery goes only through the verified email (judges have none).
 */
export function userPoolSettings() {
  return {
    userPoolTier: "ESSENTIALS",
    // Removal is `remove` in every stage (CLAUDE.md).
    deletionProtection: "INACTIVE",
    schemas: [
      {
        name: ISP_ID_ATTRIBUTE,
        attributeDataType: "String",
        mutable: true,
        required: false,
        stringAttributeConstraints: { minLength: "1", maxLength: "64" },
      },
    ],
    accountRecoverySetting: { recoveryMechanisms: [{ name: "verified_email", priority: 1 }] },
    passwordPolicy: { ...PASSWORD_POLICY },
  };
}

/** Nobody signs up (only AdminCreateUser), and both templates carry the brand of this deploy. */
export function cognitoMessages(options: AuthEmailOptions) {
  const invitation = invitationEmail(options);
  const verification = verificationEmail(options);
  return {
    adminCreateUserConfig: {
      allowAdminCreateUserOnly: true,
      inviteMessageTemplate: { emailSubject: invitation.subject, emailMessage: invitation.message },
    },
    verificationMessageTemplate: { defaultEmailOption: "CONFIRM_WITH_CODE", emailSubject: verification.subject, emailMessage: verification.message },
  };
}

// ---- Brand -------------------------------------------------------------------------------------

export interface EmailBrand {
  /** "Cuadrilla", or "Cuadrilla for <partner>" in co-branding: subjects and titles. */
  readonly name: string;
  /** The partner's display name, only in co-branding. */
  readonly partner?: string;
  /** The synthetic-demo notice, plain text. */
  readonly disclaimer: string;
}

export const SYNTHETIC_DEMO_TAG = "(demo sintética)";
/** Neutral notice: it never names the fictitious default operator (that name lives only in copy/brand.ts). */
export const NEUTRAL_DISCLAIMER = `${PRODUCT_NAME} es una demo con datos sintéticos: la operadora, el manual, las políticas, las personas y las órdenes son ficticios.`;

/**
 * The brand of the emails from the raw BrandConfig secret. Every error names fields and codes only,
 * never the value: a deploy log must not print the partner's configuration.
 */
export function emailBrandFrom(raw: string): EmailBrand {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("BrandConfig is not valid JSON (value not shown; docs/pending.md §5).");
  }
  const parsed = BrandConfigValue.safeParse(json);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"} ${issue.code}`);
    throw new Error(`BrandConfig does not match ADR-0018 (${fields.join("; ")}); value not shown.`);
  }
  const config = parsed.data;
  if (config.mode === "neutral") return { name: PRODUCT_NAME, disclaimer: NEUTRAL_DISCLAIMER };
  if ([config.partnerDisplayName, config.disclaimer.es].some((text) => /\p{Cc}/u.test(text))) {
    throw new Error("BrandConfig.partnerDisplayName and BrandConfig.disclaimer.es must not carry control characters (value not shown).");
  }
  return { name: `${PRODUCT_NAME} for ${config.partnerDisplayName}`, partner: config.partnerDisplayName, disclaimer: config.disclaimer.es };
}

// ---- Sender ------------------------------------------------------------------------------------

export const NO_REPLY_LOCAL_PART = "no-reply";

export interface EmailConfiguration {
  readonly emailSendingAccount: "DEVELOPER" | "COGNITO_DEFAULT";
  readonly sourceArn?: string;
  readonly fromEmailAddress?: string;
}

/** The SES identity as read on this deploy (infra/messaging-email.ts creates it). */
export interface SesIdentityState {
  readonly domain: string;
  readonly arn: string;
  readonly verified: boolean;
}

export interface EmailSenderChoice {
  readonly configuration: EmailConfiguration;
  /** Why Cognito keeps its own sender on this deploy; printed as a deploy warning. */
  readonly warning?: string;
}

/**
 * `Name <address>` for a From header. SES takes only printable ASCII there, and an RFC 5322 phrase
 * without specials needs no quoting, so anything else is refused instead of encoded.
 */
export function fromAddress(displayName: string, address: string): string {
  if (!/^[A-Za-z0-9 ]+$/.test(displayName) || displayName.trim() !== displayName) {
    throw new Error("the display name of a From header must be plain ASCII letters, digits and inner spaces");
  }
  if (!/^[a-z0-9-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(address)) throw new Error("the From address must be a lowercase ASCII mailbox");
  return `${displayName} <${address}>`;
}

/**
 * The sender of the console emails: SES (DEVELOPER) from `no-reply@<app domain>`, DKIM-aligned under
 * the domain's `p=reject` DMARC record, as soon as the identity exists and is verified; Cognito's own
 * sender, with the same templates, until then (DKIM can take a while after the identity is created).
 * An identity of another domain is a wiring error and fails the deploy.
 */
export function emailSenderFor(identity: SesIdentityState | undefined, appDomain: string): EmailSenderChoice {
  if (identity === undefined) {
    return {
      configuration: { emailSendingAccount: "COGNITO_DEFAULT" },
      warning: `infra/messaging-email.ts exports no emailIdentity yet: Cognito sends the console emails from its default sender until the SES identity ${appDomain} exists and is verified.`,
    };
  }
  if (identity.domain !== appDomain) throw new Error(`the SES identity is ${identity.domain}, but the console emails are sent from ${appDomain}`);
  if (!identity.verified) {
    return {
      configuration: { emailSendingAccount: "COGNITO_DEFAULT" },
      warning: `The SES identity ${appDomain} is not verified for sending yet: Cognito keeps its default sender until a deploy finds it verified.`,
    };
  }
  return {
    configuration: {
      emailSendingAccount: "DEVELOPER",
      sourceArn: identity.arn,
      fromEmailAddress: fromAddress(PRODUCT_NAME, `${NO_REPLY_LOCAL_PART}@${appDomain}`),
    },
  };
}

// ---- Emails ------------------------------------------------------------------------------------

export const COGNITO_USERNAME = "{username}";
export const COGNITO_CODE = "{####}";
export const COGNITO_EMAIL_MAX_CHARS = 20_000;
export const COGNITO_SUBJECT_MAX_CHARS = 140;

export const CRAFTECH_URL = "https://craftech.io";
/** PNG, because email clients do not render SVG (packages/web/public/brand). */
export const CRAFTECH_LOGO_FILE = "logo-craftech-color.png";
/** Sign-in route of the console (packages/web/src/routes.ts `LOGIN_PATH`). */
export const LOGIN_PATH = "/login";

export interface AuthEmailOptions {
  /** Absolute login URL of the console (`https://cuadrilla.demo.craftech.io/login`). */
  readonly loginUrl: string;
  /** Absolute base of the brand files, without a trailing slash (`https://cuadrilla.demo.craftech.io/brand`). */
  readonly brandUrl: string;
  readonly brand: EmailBrand;
}

export interface CognitoEmail {
  readonly subject: string;
  readonly message: string;
}

/** Console theme tokens (packages/web/src/index.css `--color-*`); an email carries no stylesheet. */
export const EMAIL_PALETTE = {
  navy: "#0b1f3a",
  cyan: "#12b5d9",
  "cyan-deep": "#0a7f99",
  ink: "#111a2b",
  slate: "#5a6a80",
  mist: "#e4e9f0",
  paper: "#f5f7fa",
  white: "#ffffff",
} as const;

const C = EMAIL_PALETTE;
const SANS = "Inter,Segoe UI,Helvetica,Arial,sans-serif";
const MONO = "SFMono-Regular,Menlo,Consolas,monospace";
const LAYOUT_TABLE = 'role="presentation" cellpadding="0" cellspacing="0" border="0"';

const HTML_ESCAPES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Texts that come from the secret are data, never markup. */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

function safeUrl(url: string): string {
  if (!/^https:\/\/[^\s"'<>]+$/.test(url)) throw new Error("email links must be absolute https URLs without quotes, spaces or angle brackets");
  return url;
}

function paragraph(html: string, tone: "body" | "note" = "body"): string {
  const font = tone === "body" ? `400 15px/1.6 ${SANS}` : `400 13px/1.6 ${SANS}`;
  return `<p style="margin:0 0 14px;color:${tone === "body" ? C.ink : C.slate};font:${font};">${html}</p>`;
}

function block(padding: string, content: readonly string[]): string {
  return `<tr><td style="padding:${padding};">\n${content.join("\n")}\n</td></tr>`;
}

function credential(label: string, value: string): string {
  return [
    `<p style="margin:0 0 4px;color:${C.slate};font:600 11px/1.4 ${SANS};letter-spacing:.08em;text-transform:uppercase;">${label}</p>`,
    `<p style="margin:0 0 14px;color:${C.navy};font:700 17px/1.4 ${MONO};word-break:break-all;">${value}</p>`,
  ].join("\n");
}

function credentialsCard(fields: readonly string[]): string {
  const card = `<table ${LAYOUT_TABLE} width="100%" style="background:${C.paper};border:1px solid ${C.mist};border-radius:10px;"><tr><td style="padding:16px 18px 4px;">\n${fields.join("\n")}\n</td></tr></table>`;
  return block("4px 28px 12px", [card]);
}

function actionButton(href: string, label: string): string {
  const link = `<a href="${href}" style="display:inline-block;padding:14px 30px;color:${C.white};font:700 16px/1 ${SANS};text-decoration:none;border-radius:10px;">${label}</a>`;
  return `<tr><td align="center" style="padding:8px 28px 20px;"><table ${LAYOUT_TABLE}><tr><td style="border-radius:10px;background:${C["cyan-deep"]};">${link}</td></tr></table></td></tr>`;
}

function fallbackLink(url: string): string {
  return paragraph(`Si el botón no funciona, copia este enlace en tu navegador:<br><a href="${url}" style="color:${C["cyan-deep"]};word-break:break-all;">${url}</a>`, "note");
}

function heading(title: string, lines: readonly string[]): string {
  return block("28px 28px 8px", [`<h1 style="margin:0 0 14px;color:${C.navy};font:700 22px/1.3 ${SANS};">${title}</h1>`, ...lines.map((line) => paragraph(line))]);
}

// First line of the body: the brand, as text like the console's wordmark (it survives blocked images).
function brandHeader(brand: EmailBrand): string {
  const wordmark = `<span style="color:${C.white};font:700 20px/28px ${SANS};">${PRODUCT_NAME}<span style="color:${C.cyan};">.</span></span>`;
  const partner =
    brand.partner === undefined
      ? ""
      : ` <span style="color:${C.mist};font:400 14px/28px ${SANS};">for</span> <span style="color:${C.white};font:700 20px/28px ${SANS};">${escapeHtml(brand.partner)}</span>`;
  return `<tr><td style="background:${C.navy};padding:20px 28px;border-radius:12px 12px 0 0;">${wordmark}${partner}</td></tr>`;
}

// Last lines of the body: the synthetic-demo notice and "Powered by Craftech".
function brandFooter(brand: EmailBrand, brandUrl: string): string {
  const logo = `<img src="${brandUrl}/${CRAFTECH_LOGO_FILE}" alt="Craftech" height="20" style="display:block;height:20px;width:auto;border:0;color:${C.navy};font:700 13px/20px ${SANS};">`;
  const poweredBy = `<table ${LAYOUT_TABLE}><tr><td style="vertical-align:middle;padding-right:8px;color:${C.slate};font:400 12px/20px ${SANS};">Powered by</td><td style="vertical-align:middle;"><a href="${CRAFTECH_URL}" style="text-decoration:none;">${logo}</a></td></tr></table>`;
  const notice = `<p style="margin:0 0 10px;color:${C.slate};font:400 12px/1.5 ${SANS};">${escapeHtml(brand.disclaimer)}</p>`;
  return `<tr><td style="border-top:1px solid ${C.mist};padding:18px 28px 22px;">\n${notice}\n${poweredBy}\n</td></tr>`;
}

function layout(title: string, rows: readonly string[], options: AuthEmailOptions): string {
  return [
    "<!doctype html>",
    `<html lang="es-MX"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(title)}</title></head>`,
    `<body style="margin:0;padding:0;background:${C.paper};">`,
    `<table ${LAYOUT_TABLE} width="100%" style="background:${C.paper};"><tr><td align="center" style="padding:24px 12px;">`,
    `<table ${LAYOUT_TABLE} width="100%" style="max-width:560px;background:${C.white};border:1px solid ${C.mist};border-radius:12px;">`,
    brandHeader(options.brand),
    ...rows,
    brandFooter(options.brand, safeUrl(options.brandUrl)),
    "</table>",
    "</td></tr></table>",
    "</body></html>",
  ].join("\n");
}

/** Invitation of AdminCreateUser (`npm run console:invite`): username, temporary password, first steps. */
export function invitationEmail(options: AuthEmailOptions): CognitoEmail {
  const loginUrl = safeUrl(options.loginUrl);
  const steps = [
    "Entra con tu usuario (o con este email) y la contraseña temporal.",
    `Elige una contraseña nueva: al menos ${PASSWORD_POLICY.minimumLength} caracteres, con mayúscula, minúscula, número y símbolo.`,
    "Si quieres, activa el código de verificación (TOTP) con la app de autenticación de tu celular. Es opcional y suma una capa de seguridad.",
  ];
  const rows = [
    heading(`Te damos la bienvenida a ${PRODUCT_NAME}`, [
      `Te invitaron a la consola de <strong>${PRODUCT_NAME}</strong>, el copiloto de campo en WhatsApp que acompaña a los instaladores de fibra de la operadora: órdenes del día, casos, evidencia y actas de instalación.`,
      "Estos son tus datos para el primer ingreso:",
    ]),
    credentialsCard([credential("Tu usuario", COGNITO_USERNAME), credential("Contraseña temporal", COGNITO_CODE)]),
    actionButton(loginUrl, "Entrar a la consola"),
    block("0 28px 12px", [
      paragraph("<strong>La primera vez:</strong>"),
      `<ol style="margin:0 0 14px;padding-left:20px;color:${C.ink};font:400 14px/1.6 ${SANS};">`,
      ...steps.map((step) => `<li style="margin:0 0 6px;">${step}</li>`),
      "</ol>",
      paragraph(
        `La contraseña temporal vence en ${PASSWORD_POLICY.temporaryPasswordValidityDays} días. Si vence, pide una invitación nueva a quien te invitó. Si no esperabas esta invitación, ignora este correo.`,
        "note",
      ),
      fallbackLink(loginUrl),
    ]),
  ];
  return { subject: `Tu acceso a la consola de ${options.brand.name} ${SYNTHETIC_DEMO_TAG}`, message: layout(`Invitación a ${PRODUCT_NAME}`, rows, options) };
}

/** The code message: "Olvidé mi contraseña" (ForgotPassword) and any email verification. */
export function verificationEmail(options: AuthEmailOptions): CognitoEmail {
  const loginUrl = safeUrl(options.loginUrl);
  const rows = [
    heading("Tu código de verificación", [
      `Usa este código en la consola de <strong>${PRODUCT_NAME}</strong>. Si pediste restablecer tu contraseña, escríbelo junto con la contraseña nueva.`,
    ]),
    credentialsCard([credential("Código", COGNITO_CODE)]),
    actionButton(loginUrl, "Ir a la consola"),
    block("0 28px 12px", [paragraph("El código vence en una hora. Si no lo pediste, ignora este correo: tu contraseña no cambió.", "note"), fallbackLink(loginUrl)]),
  ];
  return { subject: `${options.brand.name}: tu código de verificación ${SYNTHETIC_DEMO_TAG}`, message: layout(`Código de ${PRODUCT_NAME}`, rows, options) };
}
