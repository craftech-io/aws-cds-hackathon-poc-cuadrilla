// Client-side checks that mirror the pool (infra/auth.ts `passwordPolicy`) so a person learns what
// is missing before the request goes out, and the otpauth URI the authenticator app scans. Cognito
// still enforces the policy; these are for the form, not for security.

export const PASSWORD_MIN_LENGTH = 12;

export type PasswordRule = "length" | "lower" | "upper" | "number" | "symbol";

const RULES: ReadonlyArray<readonly [PasswordRule, (password: string) => boolean]> = [
  ["length", (password) => [...password].length >= PASSWORD_MIN_LENGTH],
  ["lower", (password) => /\p{Ll}/u.test(password)],
  ["upper", (password) => /\p{Lu}/u.test(password)],
  ["number", (password) => /\d/.test(password)],
  // Cognito's symbol set: ^ $ * . [ ] { } ( ) ? " ! @ # % & / \ , > < ' : ; | _ ~ ` = + - and space.
  ["symbol", (password) => /[\^$*.[\]{}()?"!@#%&/\\,><':;|_~`=+\- ]/.test(password)],
];

/** Rules of the pool's policy the password does not meet yet (empty = acceptable). */
export function missingPasswordRules(password: string): PasswordRule[] {
  return RULES.filter(([, test]) => !test(password)).map(([rule]) => rule);
}

/** Cognito rejects leading and trailing spaces in a password. */
export function hasOuterSpaces(password: string): boolean {
  return password !== password.trim();
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function looksLikeEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

/** A six-digit TOTP code, after removing the spaces people type or paste. */
export function normalizeTotpCode(code: string): string | undefined {
  const digits = code.replace(/\s+/g, "");
  return /^\d{6}$/.test(digits) ? digits : undefined;
}

export const TOTP_ISSUER = "Cuadrilla";

/**
 * `otpauth://totp/Al%20D%C3%ADa:<email>?secret=…&issuer=…` (Key Uri Format): what Google
 * Authenticator, Microsoft Authenticator and 1Password scan. Rendered as a QR code locally; the
 * secret never leaves the page.
 */
export function otpauthUri(secret: string, account: string, issuer: string = TOTP_ISSUER): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: "6", period: "30" });
  return `otpauth://totp/${label}?${params.toString().replace(/\+/g, "%20")}`;
}

/** The secret in groups of four, easier to type by hand when the camera is not an option. */
export function groupSecret(secret: string): string {
  return secret.replace(/\s+/g, "").replace(/(.{4})/g, "$1 ").trim();
}
