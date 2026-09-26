import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ConsoleRole } from "../packages/shared/src/enums";
import {
  COGNITO_CODE,
  COGNITO_INVITE_SMS,
  COGNITO_VERIFICATION_SMS,
  COGNITO_EMAIL_MAX_CHARS,
  COGNITO_SUBJECT_MAX_CHARS,
  COGNITO_USERNAME,
  CONSOLE_GROUPS,
  CONSOLE_GROUP_NAMES,
  CRAFTECH_LOGO_FILE,
  CRAFTECH_URL,
  EMAIL_PALETTE,
  ISP_ID_ATTRIBUTE,
  ISP_ID_CLAIM,
  LOGIN_PATH,
  NEUTRAL_DISCLAIMER,
  PASSWORD_POLICY,
  PRODUCT_NAME,
  SYNTHETIC_DEMO_TAG,
  WEB_CLIENT_SETTINGS,
  WEB_ENV_NAMES,
  cognitoMessages,
  emailBrandFrom,
  emailSenderFor,
  fromAddress,
  invitationEmail,
  userPoolSettings,
  verificationEmail,
  type AuthEmailOptions,
} from "./auth-email";

// The console files these settings must agree with import browser modules, so they are read as text.
const read = (path: string): string => readFileSync(resolve(process.cwd(), path), "utf8");

const APP_DOMAIN = "cuadrilla.demo.craftech.io";
const PARTNER = "Design Partner Fibra";
const PARTNER_NOTICE = `Demo sintética: el manual, las políticas y los datos son inventados y no son las políticas reales de ${PARTNER}.`;
const NEUTRAL_CONFIG = JSON.stringify({ mode: "neutral" });
const COBRAND = {
  mode: "cobrand",
  partnerDisplayName: PARTNER,
  partnerShortName: "Partner",
  logoAssetKeys: { onLight: "brand/logo-on-light.svg", onDark: "brand/logo-on-dark.svg" },
  disclaimer: { es: PARTNER_NOTICE, en: "Synthetic demo: invented manual, policies and data." },
};

const URLS = { loginUrl: `https://${APP_DOMAIN}${LOGIN_PATH}`, brandUrl: `https://${APP_DOMAIN}/brand` } as const;
const NEUTRAL: AuthEmailOptions = { ...URLS, brand: emailBrandFrom(NEUTRAL_CONFIG) };
const COBRANDED: AuthEmailOptions = { ...URLS, brand: emailBrandFrom(JSON.stringify(COBRAND)) };
const SETTINGS = userPoolSettings();

// Cognito's patterns for a subject and for a message around its `{####}` (API reference of
// VerificationMessageTemplateType and MessageTemplateType).
const COGNITO_SUBJECT = /^[\p{L}\p{M}\p{S}\p{N}\p{P}\s]+$/u;
const COGNITO_MESSAGE = /^[\p{L}\p{M}\p{S}\p{N}\p{P}\s*]*\{####\}[\p{L}\p{M}\p{S}\p{N}\p{P}\s*]*$/u;
// Rioplatense voseo that must not leak into Mexican Spanish (ADR-0013).
const VOSEO = /\b(ingresá|entrá|elegí|copiá|pedí|activá|ignorá|usá|escribí|querés|tenés|podés|sos)\b/i;

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;
const matches = (html: string, pattern: RegExp): string[] => [...html.matchAll(pattern)].map((match) => match[1] ?? "");

describe("groups and the informative attribute", () => {
  it("has one group per console role, in the precedence order of @cuadrilla/shared", () => {
    const byPrecedence = [...CONSOLE_GROUP_NAMES].sort((a, b) => CONSOLE_GROUPS[a].precedence - CONSOLE_GROUPS[b].precedence);
    expect(byPrecedence).toEqual(ConsoleRole.options);
    expect([...CONSOLE_GROUP_NAMES].sort()).toEqual(["JUDGE", "OPS", "SUPERVISOR"]);
    expect(new Set(CONSOLE_GROUP_NAMES.map((group) => CONSOLE_GROUPS[group].precedence)).size).toBe(CONSOLE_GROUP_NAMES.length);
  });

  it("declares custom:ispId as the only custom attribute, a short string", () => {
    expect(SETTINGS.schemas.map((schema) => schema.name)).toEqual([ISP_ID_ATTRIBUTE]);
    expect(ISP_ID_CLAIM).toBe("custom:ispId");
    expect(SETTINGS.schemas[0]).toMatchObject({ attributeDataType: "String", required: false, stringAttributeConstraints: { minLength: "1", maxLength: "64" } });
  });

  it("lets the web client read custom:ispId and write only its display name", () => {
    expect(WEB_CLIENT_SETTINGS.readAttributes).toContain(ISP_ID_CLAIM);
    expect(WEB_CLIENT_SETTINGS.writeAttributes).toEqual(["name"]);
    for (const attribute of WEB_CLIENT_SETTINGS.writeAttributes) expect(attribute).not.toMatch(/^custom:|^email/);
  });
});

describe("sign-up, recovery and passwords", () => {
  it("creates users only through AdminCreateUser and recovers them only by verified email", () => {
    for (const options of [NEUTRAL, COBRANDED]) expect(cognitoMessages(options).adminCreateUserConfig.allowAdminCreateUserOnly).toBe(true);
    expect(SETTINGS.accountRecoverySetting.recoveryMechanisms).toEqual([{ name: "verified_email", priority: 1 }]);
  });

  it("runs on the feature plan of the V2_0 pre token trigger and can be removed", () => {
    expect(SETTINGS.userPoolTier).toBe("ESSENTIALS");
    expect(SETTINGS.deletionProtection).toBe("INACTIVE");
  });

  it("asks for the password the console checks before sending", () => {
    const minLength = /PASSWORD_MIN_LENGTH = (\d+);/.exec(read("packages/web/src/lib/auth/credentials.ts"))?.[1];
    expect(Number(minLength)).toBe(PASSWORD_POLICY.minimumLength);
    expect(SETTINGS.passwordPolicy).toEqual({ ...PASSWORD_POLICY });
    expect(PASSWORD_POLICY).toMatchObject({ requireLowercase: true, requireUppercase: true, requireNumbers: true, requireSymbols: true });
  });

  it("templates the invitation and the code message with the brand of the deploy", () => {
    const messages = cognitoMessages(COBRANDED);
    const invitation = invitationEmail(COBRANDED);
    const verification = verificationEmail(COBRANDED);
    expect(messages.adminCreateUserConfig.inviteMessageTemplate).toEqual({ emailSubject: invitation.subject, emailMessage: invitation.message, smsMessage: COGNITO_INVITE_SMS });
    expect(messages.verificationMessageTemplate).toEqual({
      defaultEmailOption: "CONFIRM_WITH_CODE",
      emailSubject: verification.subject,
      emailMessage: verification.message,
      smsMessage: COGNITO_VERIFICATION_SMS,
    });
  });

  it("fills both SMS templates the way CreateUserPool validates them, although no SMS is ever sent", () => {
    // MessageTemplateType / VerificationMessageTemplateType: 6..140 characters, the code placeholder,
    // and the username placeholder in the invitation.
    for (const sms of [COGNITO_INVITE_SMS, COGNITO_VERIFICATION_SMS]) {
      expect(sms.length).toBeGreaterThanOrEqual(6);
      expect(sms.length).toBeLessThanOrEqual(140);
      expect(count(sms, COGNITO_CODE)).toBe(1);
      expect(sms).not.toMatch(VOSEO);
    }
    expect(count(COGNITO_INVITE_SMS, COGNITO_USERNAME)).toBe(1);
  });
});

describe("web client", () => {
  it("speaks only SRP and refresh, with no secret, no OAuth and no hosted UI", () => {
    expect(WEB_CLIENT_SETTINGS.explicitAuthFlows).toEqual(["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]);
    expect(WEB_CLIENT_SETTINGS.generateSecret).toBe(false);
    expect(WEB_CLIENT_SETTINGS.allowedOauthFlowsUserPoolClient).toBe(false);
    const { allowedOauthFlows, allowedOauthScopes, callbackUrls, logoutUrls } = WEB_CLIENT_SETTINGS;
    for (const list of [allowedOauthFlows, allowedOauthScopes, callbackUrls, logoutUrls]) expect(list).toEqual([]);
    expect(WEB_CLIENT_SETTINGS.supportedIdentityProviders).toEqual(["COGNITO"]);
  });

  it("issues 15-minute id and access tokens and a 12-hour refresh token, inside Cognito's bounds", () => {
    const { accessTokenValidity, idTokenValidity, refreshTokenValidity, tokenValidityUnits } = WEB_CLIENT_SETTINGS;
    expect({ accessTokenValidity, idTokenValidity, refreshTokenValidity }).toEqual({ accessTokenValidity: 15, idTokenValidity: 15, refreshTokenValidity: 12 });
    expect(tokenValidityUnits).toEqual({ accessToken: "minutes", idToken: "minutes", refreshToken: "hours" });
    // Access and id tokens: 5 minutes to 1 day. Refresh token: 1 hour to 10 years.
    for (const minutes of [accessTokenValidity, idTokenValidity]) expect(minutes).toBeGreaterThanOrEqual(5);
    expect(refreshTokenValidity).toBeGreaterThanOrEqual(1);
  });

  it("revokes tokens on sign-out and never tells whether a user exists", () => {
    expect(WEB_CLIENT_SETTINGS.enableTokenRevocation).toBe(true);
    expect(WEB_CLIENT_SETTINGS.preventUserExistenceErrors).toBe("ENABLED");
  });

  it("hands the console the build-time variables and the login path it reads", () => {
    const env = read("packages/web/src/lib/env.ts");
    for (const name of Object.values(WEB_ENV_NAMES)) expect(env).toContain(`env.${name}`);
    expect(/export const LOGIN_PATH = "([^"]+)";/.exec(read("packages/web/src/routes.ts"))?.[1]).toBe(LOGIN_PATH);
  });
});

describe("brand of the emails (ADR-0018)", () => {
  it("is Cuadrilla with the neutral synthetic-demo notice in neutral mode", () => {
    expect(NEUTRAL.brand).toEqual({ name: PRODUCT_NAME, disclaimer: NEUTRAL_DISCLAIMER });
    expect(NEUTRAL_DISCLAIMER).toMatch(/datos sintéticos/);
    expect(NEUTRAL_DISCLAIMER).toMatch(/la operadora/);
  });

  it("is Cuadrilla for <partner> with the partner's notice from the secret in co-branding", () => {
    expect(COBRANDED.brand).toEqual({ name: `${PRODUCT_NAME} for ${PARTNER}`, partner: PARTNER, disclaimer: PARTNER_NOTICE });
  });

  it("fails on a value that is not JSON or not ADR-0018 without printing it", () => {
    const secret = "SECRET-PARTNER-NAME";
    for (const raw of [secret, JSON.stringify({ mode: "cobrand", partnerDisplayName: secret }), JSON.stringify({ mode: secret })]) {
      let message = "";
      try {
        emailBrandFrom(raw);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toMatch(/^BrandConfig /);
      expect(message).not.toContain(secret);
    }
  });

  it("refuses control characters in the texts that reach a subject or a body", () => {
    for (const cobrand of [{ ...COBRAND, partnerDisplayName: "Partner\r\nBcc: x" }, { ...COBRAND, disclaimer: { ...COBRAND.disclaimer, es: "Demo\u0007" } }]) {
      expect(() => emailBrandFrom(JSON.stringify(cobrand))).toThrow(/control characters/);
    }
  });

  it("escapes the partner's texts, which are data and never markup", () => {
    const brand = emailBrandFrom(JSON.stringify({ ...COBRAND, partnerDisplayName: "A&B <Fibra>", disclaimer: { ...COBRAND.disclaimer, es: 'Aviso "x" <b>' } }));
    const { message } = invitationEmail({ ...URLS, brand });
    expect(message).toContain("A&amp;B &lt;Fibra&gt;");
    expect(message).toContain("Aviso &quot;x&quot; &lt;b&gt;");
    expect(message).not.toContain("<Fibra>");
    expect(message).not.toContain("<b>");
  });
});

describe("sender of the console emails", () => {
  const verified = { domain: APP_DOMAIN, arn: `arn:aws:ses:us-east-1:111111111111:identity/${APP_DOMAIN}`, verified: true };

  it("sends through SES from no-reply of the app domain once the identity is verified", () => {
    expect(emailSenderFor(verified, APP_DOMAIN)).toEqual({
      configuration: { emailSendingAccount: "DEVELOPER", sourceArn: verified.arn, fromEmailAddress: `${PRODUCT_NAME} <no-reply@${APP_DOMAIN}>` },
    });
  });

  it("keeps Cognito's sender, with a deploy warning, while the identity is missing or unverified", () => {
    for (const identity of [undefined, { ...verified, verified: false }]) {
      const choice = emailSenderFor(identity, APP_DOMAIN);
      expect(choice.configuration).toEqual({ emailSendingAccount: "COGNITO_DEFAULT" });
      expect(choice.warning).toContain(APP_DOMAIN);
    }
    expect(emailSenderFor(undefined, APP_DOMAIN).warning).toContain("infra/messaging-email.ts");
  });

  it("fails the deploy when the identity belongs to another domain", () => {
    expect(() => emailSenderFor({ ...verified, domain: `sim.${APP_DOMAIN}` }, APP_DOMAIN)).toThrow(/sim\./);
  });

  it("writes an ASCII From header and refuses header injection", () => {
    expect(fromAddress(PRODUCT_NAME, `no-reply@${APP_DOMAIN}`)).toMatch(/^[\x20-\x7e]+$/);
    for (const name of ["Cuadrilla\r\nBcc: x", "Cuadrilla, Fibra", " Cuadrilla", "Cuadrilla · Actas"]) expect(() => fromAddress(name, `no-reply@${APP_DOMAIN}`)).toThrow();
    for (const address of [`No-Reply@${APP_DOMAIN}`, "no-reply", `no-reply@${APP_DOMAIN}\r\n`]) expect(() => fromAddress(PRODUCT_NAME, address)).toThrow();
  });
});

describe("emails", () => {
  const cases = [
    ["neutral", NEUTRAL],
    ["co-branded", COBRANDED],
  ] as const;

  for (const [mode, options] of cases) {
    for (const [name, email] of [
      ["invitation", invitationEmail(options)],
      ["verification", verificationEmail(options)],
    ] as const) {
      describe(`${name}, ${mode}`, () => {
        it("stays inside Cognito's limits and character classes", () => {
          expect(email.message.length).toBeLessThanOrEqual(COGNITO_EMAIL_MAX_CHARS);
          expect(email.subject.length).toBeLessThanOrEqual(COGNITO_SUBJECT_MAX_CHARS);
          expect(email.subject).toMatch(COGNITO_SUBJECT);
          expect(email.message).toMatch(COGNITO_MESSAGE);
        });

        it("carries the code placeholder exactly once", () => {
          expect(count(email.message, COGNITO_CODE)).toBe(1);
        });

        it("links only to the console login and to craftech.io", () => {
          const links = matches(email.message, /href="([^"]+)"/g);
          expect(links).toContain(URLS.loginUrl);
          expect(new Set(links)).toEqual(new Set([URLS.loginUrl, CRAFTECH_URL]));
        });

        it("shows only Craftech's PNG logo, from the app domain, and the product as a text wordmark", () => {
          expect(matches(email.message, /<img[^>]*\ssrc="([^"]+)"/g)).toEqual([`${URLS.brandUrl}/${CRAFTECH_LOGO_FILE}`]);
          expect(existsSync(resolve(process.cwd(), "packages/web/public/brand", CRAFTECH_LOGO_FILE))).toBe(true);
          expect(email.message).toMatch(/Cuadrilla<span[^>]*>\.<\/span>/);
          expect(email.message).toContain("Powered by");
          expect(email.message).toContain('alt="Craftech"');
        });

        it("carries the brand and the synthetic-demo notice of the mode, and says so in the subject", () => {
          expect(email.subject).toContain(options.brand.name);
          expect(email.subject.endsWith(SYNTHETIC_DEMO_TAG)).toBe(true);
          expect(email.message).toContain(options.brand.disclaimer);
          if (options.brand.partner === undefined) expect(email.message).not.toContain(PARTNER);
          else expect(email.message).toMatch(new RegExp(`>for</span> <span[^>]*>${PARTNER}</span>`));
        });

        it("inlines every style in the console palette: no stylesheet, script or class", () => {
          expect(email.message).not.toMatch(/<style|<script|<link|\sclass=/i);
          expect(email.message).toContain('<html lang="es-MX">');
          const colors = new Set<string>(Object.values(EMAIL_PALETTE));
          for (const color of email.message.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []) expect(colors.has(color), color).toBe(true);
        });

        it("speaks Mexican Spanish with tuteo", () => {
          expect(`${email.subject} ${email.message}`).not.toMatch(VOSEO);
        });
      });
    }
  }

  it("uses exactly the colours of the console theme", () => {
    const css = read("packages/web/src/index.css");
    for (const [token, value] of Object.entries(EMAIL_PALETTE)) {
      expect(new RegExp(`--color-${token}:\\s*([^;]+);`).exec(css)?.[1]?.trim().toLowerCase(), token).toBe(value);
    }
  });

  it("the invitation gives the username and the temporary password and presents TOTP as optional", () => {
    const { message, subject } = invitationEmail(NEUTRAL);
    expect(count(message, COGNITO_USERNAME)).toBe(1);
    expect(subject).toBe(`Tu acceso a la consola de ${PRODUCT_NAME} ${SYNTHETIC_DEMO_TAG}`);
    expect(message).toContain("Contraseña temporal");
    expect(message).toContain(`vence en ${PASSWORD_POLICY.temporaryPasswordValidityDays} días`);
    expect(message).toContain(`al menos ${PASSWORD_POLICY.minimumLength} caracteres`);
    expect(message).toMatch(/TOTP[^<]*\. Es opcional/);
  });

  it("the co-branded subject names the partner only after the product", () => {
    expect(invitationEmail(COBRANDED).subject).toBe(`Tu acceso a la consola de ${PRODUCT_NAME} for ${PARTNER} ${SYNTHETIC_DEMO_TAG}`);
    expect(verificationEmail(COBRANDED).subject).toBe(`${PRODUCT_NAME} for ${PARTNER}: tu código de verificación ${SYNTHETIC_DEMO_TAG}`);
  });

  it("the code message has no username placeholder", () => {
    expect(verificationEmail(NEUTRAL).message).not.toContain(COGNITO_USERNAME);
  });

  it("refuses links that are not plain absolute https URLs", () => {
    for (const loginUrl of [`http://${APP_DOMAIN}/login`, `https://${APP_DOMAIN}/login" onclick="x`, "/login"]) {
      expect(() => invitationEmail({ ...NEUTRAL, loginUrl })).toThrow();
      expect(() => verificationEmail({ ...NEUTRAL, loginUrl })).toThrow();
    }
    expect(() => invitationEmail({ ...NEUTRAL, brandUrl: "javascript:alert(1)" })).toThrow();
  });
});
