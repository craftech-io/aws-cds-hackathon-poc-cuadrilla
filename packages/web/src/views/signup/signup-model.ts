// The own sign-up as a small state machine (ADR-0025 §1 and §3, docs/landing-spec.md §7.1), with no
// React in it, so every path is unit-tested with fakes (signup-model.test.ts):
//
//   signUp ──submit──▶ [password policy, AWS WAF token, signup.start, Cognito SignUp] ──▶ confirmCode
//   confirmCode ──confirm──▶ [ConfirmSignUp, SRP sign-in with the email and the password] ──▶ done
//                                                                   └── sign-in failed ──▶ signIn
//
// There is no step for the world: it is built asynchronously and its state lives only in the guest's
// portada (`/app/home`, §7.6). The password is checked against the pool's policy BEFORE `signup.start`
// (a start is never spent on a password Cognito would refuse); it goes from here to Cognito only, and
// it stays in this machine's state (memory) just until the automatic sign-in, never in storage. A
// `SignUp` that failed after the start (a network error) is retried with the same ticket while it lives.
import { CONSENTS_VERSION } from "@cuadrilla/shared/legal/consents";
import type { LegalLocale } from "@cuadrilla/shared/legal/consents";
import { hasOuterSpaces, looksLikeEmail, missingPasswordRules, normalizeTotpCode } from "../../lib/auth/credentials";
import { CognitoError } from "../../lib/auth/cognito";
import { signupErrorCodeOf } from "../../lib/auth/errors";
import type { SignupCognitoApi } from "../../lib/auth/signup-cognito";
import type { TokenSet } from "../../lib/auth/tokens";
import type { Attribution } from "../../lib/attribution";
import { WafTokenError } from "../../lib/waf-token";

export type SignupErrorCode =
  | "EMAIL_TAKEN"
  | "RATE_LIMITED"
  | "CAP_REACHED"
  | "TICKET_INVALID"
  | "EMAIL_DOMAIN"
  | "UNAVAILABLE"
  | "BROWSER_CHECK"
  | "WEAK_PASSWORD"
  | "INVALID_CODE"
  | "TOO_MANY_ATTEMPTS";

export interface SignupFormValues {
  readonly email: string;
  readonly password: string;
  readonly name: string;
  readonly company: string;
  readonly jobTitle: string;
  /** `TERMS_PRIVACY`: without it "Crear cuenta" stays disabled. */
  readonly terms: boolean;
  /** `CONTACT`: optional, never blocks. */
  readonly contact: boolean;
}

/** What `signup.start` takes (packages/bff/src/signup/form.ts): never the password, never an origin. */
export interface SignupStartInput {
  readonly email: string;
  readonly name?: string;
  readonly company?: string;
  readonly jobTitle?: string;
  readonly locale: LegalLocale;
  readonly consents: { readonly TERMS_PRIVACY: { readonly accepted: boolean; readonly textVersion: string }; readonly CONTACT: { readonly accepted: boolean; readonly textVersion: string } };
  readonly attribution?: Attribution;
}

export interface SignupStartAnswer {
  readonly ticket: string;
  readonly username: string;
  readonly expiresAt: string;
}

/** The last start, kept for a retry of its `SignUp` (no password in it). */
interface IssuedTicket extends SignupStartAnswer {
  readonly email: string;
}

/** The account being confirmed; the password waits here, in memory, for the automatic sign-in. */
export interface PendingAccount {
  readonly email: string;
  readonly username: string;
  readonly password: string;
}

export type SignupState =
  | { readonly step: "signUp"; readonly issued?: IssuedTicket }
  | { readonly step: "confirmCode"; readonly account: PendingAccount; readonly notice?: "codeResent" }
  | { readonly step: "done"; readonly tokens: TokenSet }
  /** The account exists but the automatic sign-in did not work: `/login` with this email. */
  | { readonly step: "signIn"; readonly email: string };

export type SignupAction =
  | { readonly type: "submit"; readonly form: SignupFormValues; readonly locale: LegalLocale; readonly attribution?: Attribution }
  | { readonly type: "confirm"; readonly code: string }
  | { readonly type: "resend" }
  | { readonly type: "back" };

export interface SignupTransition {
  readonly state: SignupState;
  readonly error?: SignupErrorCode;
}

export interface SignupDeps {
  /** `signup.start` through the sign-up's own client (no batch, the WAF token on its fetch). */
  start(input: SignupStartInput): Promise<SignupStartAnswer>;
  readonly waf: { ready(): Promise<void> };
  readonly cognito: SignupCognitoApi;
  /** The console's SRP sign-in (`ConsoleWeb`); the tokens, or undefined when it did not finish. */
  signIn(email: string, password: string): Promise<TokenSet | undefined>;
  readonly now: () => number;
}

export const INITIAL_SIGNUP: SignupState = { step: "signUp" };

/** A ticket this close to its end is not worth a retry: a new start is. */
const TICKET_MARGIN_MS = 30_000;

const START_REASONS: ReadonlySet<string> = new Set(["EMAIL_TAKEN", "RATE_LIMITED", "CAP_REACHED", "EMAIL_DOMAIN"]);

/** The BFF's `reason` of a refused start (tRPC error data), mapped to what the form says. */
export function startErrorOf(error: unknown): SignupErrorCode {
  if (error instanceof WafTokenError) return "BROWSER_CHECK";
  const data = typeof error === "object" && error !== null ? Reflect.get(error, "data") : undefined;
  const reason = typeof data === "object" && data !== null ? Reflect.get(data, "reason") : undefined;
  return typeof reason === "string" && START_REASONS.has(reason) ? (reason as SignupErrorCode) : "UNAVAILABLE";
}

const optional = (value: string): string | undefined => (value.trim().length === 0 ? undefined : value.trim().slice(0, 80));

export function startInputOf(form: SignupFormValues, locale: LegalLocale, attribution: Attribution | undefined): SignupStartInput {
  const name = optional(form.name);
  const company = optional(form.company);
  const jobTitle = optional(form.jobTitle);
  return {
    email: form.email.trim(),
    ...(name === undefined ? {} : { name }),
    ...(company === undefined ? {} : { company }),
    ...(jobTitle === undefined ? {} : { jobTitle }),
    locale,
    consents: { TERMS_PRIVACY: { accepted: form.terms, textVersion: CONSENTS_VERSION }, CONTACT: { accepted: form.contact, textVersion: CONSENTS_VERSION } },
    ...(attribution === undefined ? {} : { attribution }),
  };
}

/** Whether "Crear cuenta" may be pressed: the email looks like one and TERMS_PRIVACY is checked. */
export function canSubmit(form: Pick<SignupFormValues, "email" | "terms">): boolean {
  return form.terms && looksLikeEmail(form.email);
}

export function passwordAcceptable(password: string): boolean {
  return missingPasswordRules(password).length === 0 && !hasOuterSpaces(password);
}

async function submit(state: Extract<SignupState, { step: "signUp" }>, action: Extract<SignupAction, { type: "submit" }>, deps: SignupDeps): Promise<SignupTransition> {
  const { form } = action;
  if (!canSubmit(form)) return { state };
  if (!passwordAcceptable(form.password)) return { state, error: "WEAK_PASSWORD" };
  const email = form.email.trim();
  let issued = state.issued;
  const reusable = issued !== undefined && issued.email.toLowerCase() === email.toLowerCase() && Date.parse(issued.expiresAt) - deps.now() > TICKET_MARGIN_MS;
  if (!reusable) {
    try {
      await deps.waf.ready();
      issued = { ...(await deps.start(startInputOf(form, action.locale, action.attribution))), email };
    } catch (error) {
      return { state: { step: "signUp" }, error: startErrorOf(error) };
    }
  }
  if (issued === undefined) return { state: { step: "signUp" }, error: "UNAVAILABLE" };
  const name = optional(form.name);
  try {
    await deps.cognito.signUp({ username: issued.username, password: form.password, email, locale: action.locale, ticket: issued.ticket, ...(name === undefined ? {} : { name }) });
  } catch (error) {
    // The user of this ticket already exists: an earlier SignUp got through, only its answer was lost.
    if (!(error instanceof CognitoError && error.type === "UsernameExistsException")) {
      const code = signupErrorCodeOf(error, "signUp");
      // A network failure keeps the ticket for a retry; a refusal of Cognito or of the trigger needs a new start.
      const keep = code === "UNAVAILABLE" && !(error instanceof CognitoError) ? { issued } : {};
      return { state: { step: "signUp", ...keep }, error: code };
    }
  }
  return { state: { step: "confirmCode", account: { email, username: issued.username, password: form.password } } };
}

async function confirm(state: Extract<SignupState, { step: "confirmCode" }>, rawCode: string, deps: SignupDeps): Promise<SignupTransition> {
  const code = normalizeTotpCode(rawCode);
  if (code === undefined) return { state, error: "INVALID_CODE" };
  const { account } = state;
  try {
    await deps.cognito.confirmSignUp(account.username, code);
  } catch (error) {
    // Already confirmed (a double press, a lost answer): go on to the sign-in.
    const confirmed = error instanceof CognitoError && error.type === "NotAuthorizedException";
    if (!confirmed) return { state: { step: "confirmCode", account }, error: signupErrorCodeOf(error, "confirm") };
  }
  let tokens: TokenSet | undefined;
  try {
    tokens = await deps.signIn(account.email, account.password);
  } catch {
    tokens = undefined;
  }
  // The password leaves the machine here, whatever happened.
  return { state: tokens === undefined ? { step: "signIn", email: account.email } : { step: "done", tokens } };
}

async function resend(state: Extract<SignupState, { step: "confirmCode" }>, deps: SignupDeps): Promise<SignupTransition> {
  try {
    await deps.cognito.resendCode(state.account.username);
  } catch (error) {
    return { state: { step: "confirmCode", account: state.account }, error: signupErrorCodeOf(error, "resend") };
  }
  return { state: { step: "confirmCode", account: state.account, notice: "codeResent" } };
}

/** Runs one action. Never throws for a network, BFF or Cognito failure: that comes back as `error`. */
export async function advanceSignup(state: SignupState, action: SignupAction, deps: SignupDeps): Promise<SignupTransition> {
  switch (state.step) {
    case "signUp":
      return action.type === "submit" ? submit(state, action, deps) : { state };
    case "confirmCode":
      if (action.type === "confirm") return confirm(state, action.code, deps);
      if (action.type === "resend") return resend(state, deps);
      if (action.type === "back") return { state: INITIAL_SIGNUP };
      return { state };
    case "done":
    case "signIn":
      return { state };
  }
}
