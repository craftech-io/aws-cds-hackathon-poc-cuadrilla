// The authentication emails the neutral-surfaces guard renders in memory and reads as text
// (ADR-0023 §3): every template, in each locale it is written in, with the neutral brand and with a
// made-up co-branding one, because the brand's name and notice are interpolated when the email is
// built. The pool's default templates of infra/auth-email.ts (Mexican Spanish only: Cognito keeps one
// template per pool), and the four emails of the Cognito custom message trigger of
// packages/bff/src/copy/auth-emails*.ts, in es and en (ADR-0025 §1), which carry the neutral brand
// whatever BrandConfig says: both brands render the same text, and the guard reads both.
import { emailBrandFrom, invitationEmail, verificationEmail, type AuthEmailOptions, type CognitoEmail } from "../../infra/auth-email";
import { AUTH_EMAIL_KINDS, type AuthEmailKind, renderAuthEmail } from "../../packages/bff/src/copy/auth-emails";
import type { BrandConfigValue } from "../../packages/bff/src/lib/secret-schemas";

export type RenderLocale = "es" | "en";
export type RenderBrand = "neutral" | "cobrand";

export const RENDER_BRANDS: readonly RenderBrand[] = ["neutral", "cobrand"];

/** The BrandConfig values the templates are rendered with; the co-branding partner is made up. */
export const TEST_BRAND_CONFIGS: Readonly<Record<RenderBrand, BrandConfigValue>> = {
  neutral: { mode: "neutral" },
  cobrand: {
    mode: "cobrand",
    partnerDisplayName: "Design Partner Demo",
    partnerShortName: "Partner",
    logoAssetKeys: { onLight: "brand/logo-on-light.svg", onDark: "brand/logo-on-dark.svg" },
    disclaimer: {
      es: "Demo sintética: el manual, las políticas y los datos son inventados y no son las políticas reales de Design Partner Demo.",
      en: "Synthetic demo: the manual, the policies and the data are made up and are not the real policies of Design Partner Demo.",
    },
  },
};

export interface RenderedEmail {
  readonly subject: string;
  readonly body: string;
}

export interface AuthEmailRenderer {
  /** File and template, as a finding names them. */
  readonly source: string;
  readonly locales: readonly RenderLocale[];
  render(locale: RenderLocale, brand: BrandConfigValue): RenderedEmail;
}

/** Text of one rendered email: what the guard scans. */
export interface RenderedSurface {
  readonly source: string;
  readonly text: string;
}

// The app's public URL (infra/dns.ts `appUrl`, which needs the SST runtime and cannot be imported here).
const APP_URL = "https://cuadrilla.demo.craftech.io";

function poolTemplate(template: (options: AuthEmailOptions) => CognitoEmail): AuthEmailRenderer["render"] {
  return (_locale, brand) => {
    const email = template({ loginUrl: `${APP_URL}/login`, brandUrl: `${APP_URL}/brand`, brand: emailBrandFrom(JSON.stringify(brand)) });
    return { subject: email.subject, body: email.message };
  };
}

// The trigger's emails, as Cognito sends them: its placeholders stay, the brand is never an input.
function triggerTemplate(kind: AuthEmailKind): AuthEmailRenderer["render"] {
  return (locale) => {
    const email = renderAuthEmail(kind, locale === "en" ? "en" : "es-MX", { code: "{####}", username: "{username}" }, { loginUrl: `${APP_URL}/login`, logoUrl: `${APP_URL}/brand/logo-craftech-color.png` });
    return { subject: email.subject, body: email.html };
  };
}

export const AUTH_EMAIL_RENDERERS: readonly AuthEmailRenderer[] = [
  { source: "infra/auth-email.ts invitationEmail", locales: ["es"], render: poolTemplate(invitationEmail) },
  { source: "infra/auth-email.ts verificationEmail", locales: ["es"], render: poolTemplate(verificationEmail) },
  ...AUTH_EMAIL_KINDS.map((kind): AuthEmailRenderer => ({ source: `packages/bff/src/copy/auth-emails.ts ${kind}`, locales: ["es", "en"], render: triggerTemplate(kind) })),
];

/** Every renderer in each of its locales and with each test brand, subject first. */
export function renderAuthEmails(renderers: readonly AuthEmailRenderer[] = AUTH_EMAIL_RENDERERS): RenderedSurface[] {
  return renderers.flatMap((renderer) =>
    renderer.locales.flatMap((locale) =>
      RENDER_BRANDS.map((brand) => {
        const email = renderer.render(locale, TEST_BRAND_CONFIGS[brand]);
        return { source: `${renderer.source} (rendered, ${locale}, ${brand})`, text: `${email.subject}\n${email.body}` };
      }),
    ),
  );
}
