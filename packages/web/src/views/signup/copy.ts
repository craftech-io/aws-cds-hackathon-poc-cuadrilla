// Texts of the own sign-up (`/signup`), in Mexican Spanish (tuteo) and English, from their single source:
// docs/landing-spec.md §7.3 (the form), §7.4 (the code) and §7.5 (what the visitor reads when a limit
// or a check stops the sign-up). The two consents are NOT here: their text and version come from
// packages/shared/src/legal/consents.ts, the source the BFF validates against. No message says whether
// an email has an account, except EMAIL_TAKEN (ADR-0025 §3, a declared residual risk).
import type { SignupErrorCode } from "./signup-model";

export type SignupLang = "es" | "en";

/** A text with inline links: plain runs and link runs, in reading order. */
export type RichText = ReadonlyArray<string | { readonly label: string; readonly href: string; readonly external?: boolean }>;

export const CONTACT_URL = "https://craftech.io/contact/";

export interface SignupCopy {
  readonly title: string;
  readonly lead: string;
  readonly email: string;
  readonly password: string;
  readonly optional: string;
  readonly name: string;
  readonly company: string;
  readonly jobTitle: string;
  readonly consentsLabel: string;
  readonly submit: string;
  readonly note: string;
  readonly haveAccount: { readonly before: string; readonly link: string };
  readonly confirm: {
    readonly title: string;
    readonly lead: (email: string) => string;
    readonly code: string;
    readonly submit: string;
    readonly resend: string;
    readonly resent: string;
    readonly back: string;
  };
  readonly signingIn: string;
  /** `login` and `forgot` are the paths of the login in the language on screen. */
  readonly errors: (paths: { readonly login: string; readonly forgot: string }) => Readonly<Record<SignupErrorCode, RichText>>;
}

export const signupCopy: Readonly<Record<SignupLang, SignupCopy>> = {
  es: {
    title: "Crea tu cuenta",
    lead: "Entras con esta cuenta y tu propio mundo de prueba se crea al confirmar el email.",
    email: "Email",
    password: "Contraseña",
    optional: "Opcional",
    name: "Nombre (opcional)",
    company: "Empresa (opcional)",
    jobTitle: "Cargo (opcional)",
    consentsLabel: "Consentimientos",
    submit: "Crear cuenta",
    note: "Vas a recibir un código por email para confirmar tu cuenta.",
    haveAccount: { before: "¿Ya tienes cuenta? ", link: "Inicia sesión" },
    confirm: {
      title: "Revisa tu email",
      lead: (email) => `Te enviamos un código de 6 dígitos a ${email}. Si no llega en unos minutos, revisa tu carpeta de spam.`,
      code: "Código",
      submit: "Confirmar cuenta",
      resend: "Reenviar código",
      resent: "Código reenviado.",
      back: "Usar otro email",
    },
    signingIn: "Un momento…",
    errors: ({ login, forgot }) => ({
      EMAIL_TAKEN: ["Ya existe una cuenta con este email. ¿Quieres ", { label: "iniciar sesión", href: login }, " o ", { label: "restablecer tu contraseña", href: forgot }, "?"],
      RATE_LIMITED: ["Llegaste al límite de altas desde esta conexión o con este email. Intenta más tarde o ", { label: "hablemos", href: CONTACT_URL, external: true }, " y te preparamos una demo guiada."],
      CAP_REACHED: ["Por ahora no estamos abriendo cuentas nuevas de prueba. Vuelve más tarde o ", { label: "hablemos", href: CONTACT_URL, external: true }, " y te preparamos una demo guiada."],
      TICKET_INVALID: ["La sesión del formulario venció, intenta de nuevo."],
      EMAIL_DOMAIN: ["Revisa tu email: ese dominio no puede recibir correo."],
      UNAVAILABLE: ["No pudimos crear tu cuenta en este momento. Intenta de nuevo en unos minutos."],
      BROWSER_CHECK: ["No pudimos verificar tu navegador. Recarga la página, desactiva el bloqueador de contenido para este sitio o intenta desde otro navegador."],
      WEAK_PASSWORD: ["La contraseña no cumple los requisitos."],
      INVALID_CODE: ["El código no es válido o venció. Pide uno nuevo."],
      TOO_MANY_ATTEMPTS: ["Demasiados intentos. Espera unos minutos y vuelve a intentar."],
    }),
  },
  en: {
    title: "Create your account",
    lead: "Sign in with this account and your own test world is created once you confirm your email.",
    email: "Email",
    password: "Password",
    optional: "Optional",
    name: "Name (optional)",
    company: "Company (optional)",
    jobTitle: "Job title (optional)",
    consentsLabel: "Consents",
    submit: "Create account",
    note: "You'll get an email code to confirm your account.",
    haveAccount: { before: "Already have an account? ", link: "Sign in" },
    confirm: {
      title: "Check your email",
      lead: (email) => `We sent a 6-digit code to ${email}. If it doesn't arrive in a few minutes, check your spam folder.`,
      code: "Code",
      submit: "Confirm account",
      resend: "Resend code",
      resent: "Code resent.",
      back: "Use a different email",
    },
    signingIn: "One moment…",
    errors: ({ login, forgot }) => ({
      EMAIL_TAKEN: ["There's already an account with this email. Want to ", { label: "sign in", href: login }, " or ", { label: "reset your password", href: forgot }, "?"],
      RATE_LIMITED: ["You've reached the sign-up limit for this connection or email. Try again later, or ", { label: "let's talk", href: CONTACT_URL, external: true }, " and we'll set up a guided demo."],
      CAP_REACHED: ["We're not opening new test accounts right now. Try again later, or ", { label: "let's talk", href: CONTACT_URL, external: true }, " and we'll set up a guided demo."],
      TICKET_INVALID: ["The form session expired, please try again."],
      EMAIL_DOMAIN: ["Check your email: that domain can't receive mail."],
      UNAVAILABLE: ["We couldn't create your account right now. Please try again in a few minutes."],
      BROWSER_CHECK: ["We couldn't verify your browser. Reload the page, turn off your content blocker for this site, or try another browser."],
      WEAK_PASSWORD: ["The password doesn't meet the requirements."],
      INVALID_CODE: ["The code isn't valid or expired. Request a new one."],
      TOO_MANY_ATTEMPTS: ["Too many attempts. Wait a few minutes and try again."],
    }),
  },
};
