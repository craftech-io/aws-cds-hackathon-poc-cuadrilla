// The console's sign-in as a small state machine: a state, an action, and `advance` computes the
// next state against Cognito. No React here, so every path (first login with a temporary password,
// TOTP enrolment, the TOTP code, a forgotten password, an expired challenge) is unit-tested with a
// fake Cognito (flow.test.ts).
//
//   credentials ──signIn──▶ SRP ──▶ newPassword ──▶ (mfaSetup | totp | done)
//        │                    ├──▶ totp ─────────▶ done
//        │                    ├──▶ mfaSetup ─────▶ done        (Cognito MFA_SETUP, or the optional
//        │                    └──▶ done                         TOTP offer; never to a judge)
//        └──forgot──▶ forgotRequest ──▶ forgotConfirm ──▶ credentials (notice: passwordReset)
//
// The same machine runs the recent-login step-up (mode `stepUp`): approving or reopening a file
// needs an interactive sign-in in the last 15 minutes (`auth_time`, ADR-0010), so the console signs
// the same person in again, in place, and swaps the tokens.
import { type AuthResponse, type CognitoApi, type Credential, TOTP_MFA } from "./cognito";
import { missingPasswordRules, normalizeEmail, normalizeTotpCode } from "./credentials";
import { type AuthFlowErrorCode, type FlowStep, errorCodeOf } from "./errors";
import type { SrpClient } from "./srp";
import { type TokenSet, tokenSetOf } from "./tokens";

export type FlowMode = { readonly kind: "signIn" } | { readonly kind: "stepUp"; readonly sub: string; readonly email: string };

/** A pending Cognito challenge: who (USER_ID_FOR_SRP) and the session that answers it. */
export interface ChallengeContext {
  readonly email: string;
  readonly username: string;
  readonly session: string;
}

export interface MfaSetup {
  readonly email: string;
  /** Base32 secret for the authenticator app. Memory only: never stored, never logged. */
  readonly secret: string;
  /** False when the role needs TOTP, in a step-up, or when Cognito itself demands it. */
  readonly optional: boolean;
  readonly via: { readonly kind: "challenge"; readonly username: string; readonly session: string } | { readonly kind: "tokens"; readonly tokens: TokenSet };
}

export type AuthFlowState =
  | { readonly step: "credentials"; readonly notice?: "passwordReset" }
  | { readonly step: "newPassword"; readonly challenge: ChallengeContext }
  | { readonly step: "totp"; readonly challenge: ChallengeContext }
  | { readonly step: "mfaSetup"; readonly setup: MfaSetup }
  | { readonly step: "forgotRequest" }
  | { readonly step: "forgotConfirm"; readonly email: string }
  /** `totpVerified`: this sign-in passed a TOTP code (the step-up requires it). */
  | { readonly step: "done"; readonly tokens: TokenSet; readonly totpVerified: boolean };

export type AuthFlowAction =
  | { readonly type: "signIn"; readonly email: string; readonly password: string }
  | { readonly type: "newPassword"; readonly password: string }
  | { readonly type: "totp"; readonly code: string }
  | { readonly type: "verifyMfaSetup"; readonly code: string }
  | { readonly type: "skipMfaSetup" }
  | { readonly type: "forgot" }
  | { readonly type: "requestReset"; readonly email: string }
  | { readonly type: "confirmReset"; readonly code: string; readonly password: string }
  | { readonly type: "restart" };

export interface Transition {
  readonly state: AuthFlowState;
  readonly error?: AuthFlowErrorCode;
}

export interface AuthFlowDeps {
  readonly cognito: CognitoApi;
  readonly srp: SrpClient;
  readonly mode: FlowMode;
  readonly now: () => number;
  /** Whether this person may be offered TOTP after signing in (never a judge). */
  readonly offersTotp: (tokens: TokenSet) => boolean;
  /** `sub` of the id token, to tell whether a step-up signed in the same person. */
  readonly subOf: (tokens: TokenSet) => string | undefined;
}

export const INITIAL_STATE: AuthFlowState = { step: "credentials" };

const RESET_CODE = /^\d{6}$/;

function stay(state: AuthFlowState, error: AuthFlowErrorCode): Transition {
  return { state, error };
}

function restart(error: AuthFlowErrorCode): Transition {
  return { state: INITIAL_STATE, error };
}

/** Runs one action. Never throws for a Cognito or network failure: that comes back as `error`. */
export async function advance(state: AuthFlowState, action: AuthFlowAction, deps: AuthFlowDeps): Promise<Transition> {
  if (action.type === "restart") return { state: INITIAL_STATE };
  switch (state.step) {
    case "credentials":
      if (action.type === "signIn") return signIn(state, action.email, action.password, deps);
      if (action.type === "forgot" && deps.mode.kind === "signIn") return { state: { step: "forgotRequest" } };
      return { state };
    case "newPassword":
      return action.type === "newPassword" ? newPassword(state, state.challenge, action.password, deps) : { state };
    case "totp":
      return action.type === "totp" ? totp(state, state.challenge, action.code, deps) : { state };
    case "mfaSetup":
      if (action.type === "verifyMfaSetup") return verifyMfaSetup(state, state.setup, action.code, deps);
      if (action.type === "skipMfaSetup" && state.setup.optional && state.setup.via.kind === "tokens") {
        return { state: { step: "done", tokens: state.setup.via.tokens, totpVerified: false } };
      }
      return { state };
    case "forgotRequest":
      return action.type === "requestReset" ? requestReset(state, action.email, deps) : { state };
    case "forgotConfirm":
      return action.type === "confirmReset" ? confirmReset(state, action.code, action.password, deps) : { state };
    case "done":
      return { state };
  }
}

async function signIn(state: AuthFlowState, rawEmail: string, password: string, deps: AuthFlowDeps): Promise<Transition> {
  // A step-up signs in the person already in session, whatever the form says.
  const email = deps.mode.kind === "stepUp" ? deps.mode.email : normalizeEmail(rawEmail);
  if (!email || !password) return stay(state, "INVALID_CREDENTIALS");
  try {
    const exchange = await deps.srp.start(email, password);
    const verifier = await deps.cognito.initiateSrp(email, exchange.srpA);
    if (verifier.ChallengeName !== "PASSWORD_VERIFIER" || !verifier.ChallengeParameters) return stay(state, "UNSUPPORTED");
    const responses = await exchange.sign(verifier.ChallengeParameters);
    const answer = await deps.cognito.respondToChallenge("PASSWORD_VERIFIER", responses, verifier.Session);
    return await onAuthResponse(answer, { email, username: responses.USERNAME ?? email }, false, deps);
  } catch (error) {
    return stay(state, errorCodeOf(error, "credentials"));
  }
}

async function newPassword(state: AuthFlowState, challenge: ChallengeContext, password: string, deps: AuthFlowDeps): Promise<Transition> {
  if (missingPasswordRules(password).length > 0) return stay(state, "WEAK_PASSWORD");
  return inChallenge(state, "challenge", async () => {
    const answer = await deps.cognito.respondToChallenge("NEW_PASSWORD_REQUIRED", { USERNAME: challenge.username, NEW_PASSWORD: password }, challenge.session);
    return onAuthResponse(answer, challenge, false, deps);
  });
}

async function totp(state: AuthFlowState, challenge: ChallengeContext, rawCode: string, deps: AuthFlowDeps): Promise<Transition> {
  const code = normalizeTotpCode(rawCode);
  if (!code) return stay(state, "INVALID_CODE");
  return inChallenge(state, "challenge", async () => {
    const answer = await deps.cognito.respondToChallenge("SOFTWARE_TOKEN_MFA", { USERNAME: challenge.username, SOFTWARE_TOKEN_MFA_CODE: code }, challenge.session);
    return onAuthResponse(answer, challenge, true, deps);
  });
}

async function verifyMfaSetup(state: AuthFlowState, setup: MfaSetup, rawCode: string, deps: AuthFlowDeps): Promise<Transition> {
  const code = normalizeTotpCode(rawCode);
  if (!code) return stay(state, "INVALID_CODE");
  const { via } = setup;
  if (via.kind === "tokens") {
    return inChallenge(state, "setup", async () => {
      const verified = await deps.cognito.verifySoftwareToken({ accessToken: via.tokens.accessToken }, code);
      if (!verified.ok) return stay(state, "INVALID_CODE");
      await deps.cognito.setTotpPreferred(via.tokens.accessToken);
      return { state: { step: "done", tokens: via.tokens, totpVerified: true } };
    });
  }
  return inChallenge(state, "setup", async () => {
    const verified = await deps.cognito.verifySoftwareToken({ session: via.session }, code);
    if (!verified.ok) return stay(state, "INVALID_CODE");
    const answer = await deps.cognito.respondToChallenge("MFA_SETUP", { USERNAME: via.username }, verified.session ?? via.session);
    if (answer.AuthenticationResult) {
      const tokens = tokenSetOf(answer.AuthenticationResult, deps.now());
      // MFA_SETUP verified the code; this only makes TOTP the preferred factor. Best effort.
      await deps.cognito.setTotpPreferred(tokens.accessToken).catch(() => undefined);
      return afterTokens(tokens, setup.email, true, deps);
    }
    return onAuthResponse(answer, { email: setup.email, username: via.username, session: via.session }, true, deps);
  });
}

// A failure inside a challenge keeps the step, except an expired session, which starts over.
async function inChallenge(state: AuthFlowState, step: FlowStep, run: () => Promise<Transition>): Promise<Transition> {
  try {
    return await run();
  } catch (error) {
    const code = errorCodeOf(error, step);
    return code === "SESSION_EXPIRED" ? restart(code) : stay(state, code);
  }
}

async function onAuthResponse(
  response: AuthResponse,
  who: { readonly email: string; readonly username: string; readonly session?: string },
  totpVerified: boolean,
  deps: AuthFlowDeps,
): Promise<Transition> {
  if (response.AuthenticationResult) return afterTokens(tokenSetOf(response.AuthenticationResult, deps.now()), who.email, totpVerified, deps);
  const session = response.Session;
  if (!session) return restart("UNAVAILABLE");
  const username = response.ChallengeParameters?.USER_ID_FOR_SRP ?? who.username;
  const challenge: ChallengeContext = { email: who.email, username, session };
  switch (response.ChallengeName) {
    case "NEW_PASSWORD_REQUIRED":
      return { state: { step: "newPassword", challenge } };
    case "SOFTWARE_TOKEN_MFA":
      return { state: { step: "totp", challenge } };
    case "SELECT_MFA_TYPE": {
      if (!listParam(response, "MFAS_CAN_CHOOSE").includes(TOTP_MFA)) return restart("UNSUPPORTED");
      const answer = await deps.cognito.respondToChallenge("SELECT_MFA_TYPE", { USERNAME: username, ANSWER: TOTP_MFA }, session);
      return onAuthResponse(answer, challenge, totpVerified, deps);
    }
    case "MFA_SETUP": {
      const canSetup = listParam(response, "MFAS_CAN_SETUP");
      if (canSetup.length > 0 && !canSetup.includes(TOTP_MFA)) return restart("UNSUPPORTED");
      const association = await deps.cognito.associateSoftwareToken({ session });
      return {
        state: {
          step: "mfaSetup",
          setup: { email: who.email, secret: association.secretCode, optional: false, via: { kind: "challenge", username, session: association.session ?? session } },
        },
      };
    }
    default:
      return restart("UNSUPPORTED");
  }
}

// Cognito sends list parameters as JSON strings (`["SOFTWARE_TOKEN_MFA"]`).
function listParam(response: AuthResponse, name: string): string[] {
  const raw = response.ChallengeParameters?.[name];
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

async function afterTokens(tokens: TokenSet, email: string, totpVerified: boolean, deps: AuthFlowDeps): Promise<Transition> {
  if (deps.mode.kind === "stepUp" && deps.subOf(tokens) !== deps.mode.sub) {
    // Somebody else's session must not outlive this screen.
    if (tokens.refreshToken) await deps.cognito.revoke(tokens.refreshToken).catch(() => undefined);
    return restart("DIFFERENT_USER");
  }
  if (totpVerified) return { state: { step: "done", tokens, totpVerified } };

  // The pool's MFA is optional (docs/architecture.md §10): a user without TOTP signs in with the
  // password alone, a step-up never turns into an enrolment, and judges are never offered TOTP.
  if (deps.mode.kind === "stepUp" || !deps.offersTotp(tokens)) return { state: { step: "done", tokens, totpVerified: false } };
  let enabled: readonly string[];
  try {
    enabled = await deps.cognito.mfaMethods(tokens.accessToken);
  } catch {
    // TOTP is optional: an unanswered lookup must not lock the person out.
    return { state: { step: "done", tokens, totpVerified: false } };
  }
  if (enabled.includes(TOTP_MFA)) return { state: { step: "done", tokens, totpVerified: false } };
  try {
    const association = await deps.cognito.associateSoftwareToken({ accessToken: tokens.accessToken } satisfies Credential);
    return { state: { step: "mfaSetup", setup: { email, secret: association.secretCode, optional: true, via: { kind: "tokens", tokens } } } };
  } catch {
    return { state: { step: "done", tokens, totpVerified: false } };
  }
}

async function requestReset(state: AuthFlowState, rawEmail: string, deps: AuthFlowDeps): Promise<Transition> {
  const email = normalizeEmail(rawEmail);
  if (!email) return stay(state, "INVALID_CREDENTIALS");
  try {
    await deps.cognito.forgotPassword(email);
  } catch (error) {
    const code = errorCodeOf(error, "reset");
    // Unknown email, unverified email, account still on its temporary password: same screen as a
    // success, so the form never tells whether the email has an account.
    if (code !== "INVALID_CODE") return stay(state, code);
  }
  return { state: { step: "forgotConfirm", email } };
}

async function confirmReset(state: Extract<AuthFlowState, { step: "forgotConfirm" }>, rawCode: string, password: string, deps: AuthFlowDeps): Promise<Transition> {
  const code = rawCode.replace(/\s+/g, "");
  if (!RESET_CODE.test(code)) return stay(state, "INVALID_CODE");
  if (missingPasswordRules(password).length > 0) return stay(state, "WEAK_PASSWORD");
  try {
    await deps.cognito.confirmForgotPassword(state.email, code, password);
  } catch (error) {
    return stay(state, errorCodeOf(error, "reset"));
  }
  return { state: { step: "credentials", notice: "passwordReset" } };
}
