// The email a finished sign-up hands to `/login` when its own automatic sign-in did not work
// (ADR-0025 §1: "/login with the email filled in"). It travels in this page's memory only: never in
// the URL (an address is personal data), never in `sessionStorage` or `localStorage`; the login reads
// it when it opens and forgets it right after. A reload simply starts the login empty.
let pending: string | undefined;

export function handOffEmail(email: string): void {
  pending = email;
}

/** The handed-off email, if any; reading does not forget it (a render may run twice). */
export function handedOffEmail(): string | undefined {
  return pending;
}

export function forgetHandedOffEmail(): void {
  pending = undefined;
}
