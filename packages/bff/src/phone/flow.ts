// The SMS code as a second factor of every sign-in (ADR-0029). One session of the id token is either
// passed (`PHONESESSION#`) or not; until it is, the BFF answers only the phone step (routers/trpc.ts).
//
//   status       PASSED, ENROL (no verified number yet: the screen asks for one, prefilled with the
//                sign-up's) or SIGN_IN (the verified number, shown by its last digits, never editable);
//                whether a code is out, when it expires and when another one may be asked for
//   sendCode     ENROL: the number typed (or corrected) here, unless another account verified it;
//                SIGN_IN: always the verified number, a number in the input is refused (PHONE_LOCKED).
//                Once a minute; the daily caps of phone/limits.ts reserved before the SMS (a number
//                outside the home region also takes the stage's foreign quota)
//   verifyCode   the code of this session; on success the session is passed and, on an enrolment,
//                the number becomes the account's (phone/enrolment.ts); then the account gets what it
//                needs (its world, `afterPass`)
//   endSession   the sign-out: the session's mark and code are deleted
//
// Accounts with `phoneCheck AUTOMATION` (set only by the operator) are always PASSED. A QA principal
// never gets here: it has no Cognito session.
import { ConnectorError, ToolError } from "@cuadrilla/shared";
import type { LegalLocale } from "@cuadrilla/shared/legal/consents";
import type { Principal } from "../auth/principal";
import type { TableClient } from "../connector/table-client";
import { phoneCodeSms } from "../copy/phone-code";
import type { ConsoleUser } from "../domain/isps";
import type { Logger } from "../lib/log";
import { ipHashOf } from "../signup/limits";
import { type StoredCode, attemptCode, codeDigest, codeKey, newCode, readCode, resendAt, storeCode } from "./code";
import { type LeadSide, PHONE_IN_USE, claimNumber, ownerOf, recordOnLead, recordOnRow, registryUser } from "./enrolment";
import { PHONE_LIMITS, reserveSms } from "./limits";
import { accountPhoneHash, isHomeNumber, maskPhone, parseAccountPhone } from "./number";
import { type SessionGate, clearSession, indexSession, isSessionPassed, markSessionPassed, sessionKeyOf } from "./session";
import type { SmsSender } from "./sms";

export interface PhoneKeys {
  readonly phone: () => Uint8Array | string;
  readonly code: () => Uint8Array | string;
  readonly ip: () => Uint8Array | string;
}

export interface PhonePorts extends LeadSide {
  readonly client: TableClient;
  readonly sms: SmsSender;
  readonly keys: PhoneKeys;
  readonly gate: Pick<SessionGate, "forget">;
  /** What the account needs once a session passed (its world): a failure is logged, never undoes the pass. */
  readonly afterPass: (principal: Principal, log: Logger) => Promise<void>;
  /** Real clock. */
  readonly now: () => Date;
  readonly newCode?: () => string;
}

export interface PhoneCaller {
  readonly principal: Principal;
  /** The viewer the edge verified (the IP's SMS cap); `undefined` off the edge. */
  readonly viewerIp: string | undefined;
  readonly log: Logger;
}

export type PhoneState = "PASSED" | "ENROL" | "SIGN_IN";

export interface PhoneStatus {
  readonly state: PhoneState;
  /** ENROL: the number to prefill (the one of the code out, else the sign-up's). */
  readonly phone?: string;
  /** SIGN_IN: the verified number by its last digits. */
  readonly maskedPhone?: string;
  readonly codeSent: boolean;
  readonly codeExpiresAt?: string;
  readonly resendAt?: string;
}

const PASSED: PhoneStatus = { state: "PASSED", codeSent: false };

const notAvailable = (): ToolError => new ToolError("FORBIDDEN", "sign in again to continue", "NO_REGISTRY_ROW");
const blocked = (): ToolError => new ToolError("FORBIDDEN", "this account is blocked", "ACCOUNT_BLOCKED");

async function rowOf(ports: PhonePorts, principal: Principal): Promise<ConsoleUser> {
  const user = await registryUser(ports.client, principal.ispId, principal.userId);
  if (user === undefined || user.cognitoSub !== principal.sub || !user.active) throw notAvailable();
  // Read on every call, never cached: a block cuts the SMS at once (ADR-0029 §11).
  if (user.blockedAt !== undefined) throw blocked();
  return user;
}

const sessionOf = (principal: Principal) => ({ userId: principal.userId, sessionId: principal.sessionId, authTime: principal.authTime });
const keyOf = (principal: Principal) => codeKey(principal.userId, sessionKeyOf(principal.sessionId));

/** The sign-up's number of a sign-up guest's lead, to prefill the enrolment. */
async function signupPhone(ports: PhonePorts, principal: Principal): Promise<string | undefined> {
  if (principal.email === undefined) return undefined;
  const lead = await ports.leads.get(ports.emailHash(principal.email));
  return lead?.cognitoSub === principal.sub ? lead.phone : undefined;
}

function pendingView(state: "ENROL" | "SIGN_IN", user: ConsoleUser, code: StoredCode | undefined, prefill: string | undefined, now: Date): PhoneStatus {
  const live = code !== undefined && Date.parse(code.codeExpiresAt) > now.getTime() ? code : undefined;
  const wait = resendAt(code, now);
  const number = state === "SIGN_IN" ? { maskedPhone: maskPhone(user.phone ?? "") } : (live?.phone ?? prefill) === undefined ? {} : { phone: live?.phone ?? prefill };
  return { state, ...number, codeSent: live !== undefined, ...(live === undefined ? {} : { codeExpiresAt: live.codeExpiresAt }), ...(wait === undefined ? {} : { resendAt: wait.toISOString() }) };
}

export async function phoneStatusOf(ports: PhonePorts, caller: Pick<PhoneCaller, "principal">): Promise<PhoneStatus> {
  const { principal } = caller;
  const user = await rowOf(ports, principal);
  const now = ports.now();
  if (user.phoneCheck === "AUTOMATION" || (await isSessionPassed(ports.client, sessionOf(principal), now))) return PASSED;
  const code = await readCode(ports.client, keyOf(principal));
  if (user.phoneVerifiedAt !== undefined && user.phone !== undefined) return pendingView("SIGN_IN", user, code, undefined, now);
  return pendingView("ENROL", user, code, code?.phone === undefined ? await signupPhone(ports, principal) : undefined, now);
}

export interface SendInput {
  readonly phone?: string | undefined;
  readonly locale: LegalLocale;
}

/** The number of this send: the verified one at a sign-in (never another), the typed one at an enrolment. */
async function numberFor(ports: PhonePorts, principal: Principal, user: ConsoleUser, input: SendInput, code: StoredCode | undefined): Promise<{ readonly purpose: "ENROL" | "SIGN_IN"; readonly phone: string }> {
  if (user.phoneVerifiedAt !== undefined && user.phone !== undefined) {
    if (input.phone !== undefined) throw new ToolError("FORBIDDEN", "the verified phone of an account cannot be changed here", "PHONE_LOCKED");
    return { purpose: "SIGN_IN", phone: user.phone };
  }
  const typed = input.phone ?? code?.phone ?? (await signupPhone(ports, principal));
  if (typed === undefined) throw new ToolError("INVALID", "type the phone that will receive the code", "PHONE_REQUIRED");
  return { purpose: "ENROL", phone: parseAccountPhone(typed) };
}

export async function sendPhoneCode(ports: PhonePorts, caller: PhoneCaller, input: SendInput): Promise<PhoneStatus> {
  const { principal } = caller;
  const user = await rowOf(ports, principal);
  const now = ports.now();
  if (user.phoneCheck === "AUTOMATION" || (await isSessionPassed(ports.client, sessionOf(principal), now))) return PASSED;
  if (caller.viewerIp === undefined || caller.viewerIp.length === 0) throw new ToolError("UNAVAILABLE", "the code could not be sent right now", "NO_VIEWER");
  const key = keyOf(principal);
  const previous = await readCode(ports.client, key);
  const wait = resendAt(previous, now);
  if (wait !== undefined) throw new ToolError("CAP_REACHED", "wait a minute before asking for another code", "RESEND_TOO_SOON");
  const target = await numberFor(ports, principal, user, input, previous);
  const phoneHash = accountPhoneHash(ports.keys.phone(), target.phone);
  if (target.purpose === "ENROL") {
    const owner = await ownerOf(ports.client, phoneHash);
    if (owner !== undefined && owner !== principal.userId) throw PHONE_IN_USE();
  }
  await reserveSms(ports.client, { userId: principal.userId, phoneHash, ipHash: ipHashOf(ports.keys.ip(), caller.viewerIp), home: isHomeNumber(target.phone) }, now);
  const code = (ports.newCode ?? newCode)();
  const sessionKey = sessionKeyOf(principal.sessionId);
  try {
    await storeCode(ports.client, key, { purpose: target.purpose, digest: codeDigest(ports.keys.code(), principal.userId, sessionKey, code), phoneHash, ...(target.purpose === "ENROL" ? { phone: target.phone } : {}) }, previous?.sentAt, now);
  } catch (error) {
    if (error instanceof ConnectorError && error.code === "CONFLICT") throw new ToolError("CAP_REACHED", "wait a minute before asking for another code", "RESEND_TOO_SOON");
    throw error;
  }
  await indexSession(ports.client, principal, Math.ceil((now.getTime() + PHONE_LIMITS.codeTtlMs) / 1000));
  try {
    await ports.sms.send({ phone: target.phone, text: phoneCodeSms(input.locale, code, PHONE_LIMITS.codeTtlMs / 60_000) });
  } catch (error) {
    await ports.client.delete("Runtime", key);
    caller.log.warn("phone.code.not_sent", { userId: principal.userId, purpose: target.purpose, reason: error instanceof ToolError ? (error.reason ?? error.code) : "UNKNOWN", metric: "PhoneCodeNotSent", value: 1 });
    throw error instanceof ToolError ? error : new ToolError("UNAVAILABLE", "the code could not be sent right now", "SMS_UNAVAILABLE");
  }
  caller.log.info("phone.code.sent", { userId: principal.userId, purpose: target.purpose, metric: "PhoneCodeSent", value: 1 });
  return phoneStatusOf(ports, caller);
}

const CODE_ERRORS = {
  NONE: () => new ToolError("INVALID", "ask for a code first", "CODE_EXPIRED"),
  EXPIRED: () => new ToolError("INVALID", "the code expired: ask for a new one", "CODE_EXPIRED"),
  EXHAUSTED: () => new ToolError("INVALID", "too many wrong codes: ask for a new one", "CODE_EXHAUSTED"),
} as const;

export async function verifyPhoneCode(ports: PhonePorts, caller: PhoneCaller, rawCode: unknown): Promise<PhoneStatus> {
  const { principal } = caller;
  if (typeof rawCode !== "string" || !/^\d{6}$/.test(rawCode)) throw new ToolError("INVALID", "the code has six digits", "CODE_INVALID");
  const user = await rowOf(ports, principal);
  const now = ports.now();
  if (user.phoneCheck === "AUTOMATION" || (await isSessionPassed(ports.client, sessionOf(principal), now))) return PASSED;
  const key = keyOf(principal);
  const sessionKey = sessionKeyOf(principal.sessionId);
  const result = await attemptCode(ports.client, key, () => codeDigest(ports.keys.code(), principal.userId, sessionKey, rawCode), now);
  if (result.check === "WRONG") {
    caller.log.warn("phone.code.wrong", { userId: principal.userId, left: result.left ?? 0, metric: "PhoneCodeWrong", value: 1 });
    throw new ToolError("INVALID", `the code is not right: ${result.left ?? 0} attempts left`, "CODE_WRONG");
  }
  if (result.check !== "MATCH") throw CODE_ERRORS[result.check]();
  if (result.code === undefined) throw CODE_ERRORS.NONE();
  const code = result.code;
  if (code.purpose === "ENROL") {
    if (code.phone === undefined || user.phoneVerifiedAt !== undefined) throw CODE_ERRORS.EXPIRED();
    await claimNumber(ports.client, code.phoneHash, principal.userId, now);
    await recordOnRow(ports.client, user, code.phone, now);
    const lead = await recordOnLead(ports, { sub: principal.sub, email: principal.email }, code.phone, now);
    caller.log.info("phone.enrolled", { userId: principal.userId, lead, metric: "PhoneEnrolled", value: 1 });
  } else if (user.phone === undefined || accountPhoneHash(ports.keys.phone(), user.phone) !== code.phoneHash) {
    // The verified number changed (an operator's reset) after this code went out.
    throw CODE_ERRORS.EXPIRED();
  }
  await markSessionPassed(ports.client, sessionOf(principal), now);
  await ports.client.delete("Runtime", key);
  caller.log.info("phone.session.passed", { userId: principal.userId, purpose: code.purpose, metric: "PhoneSessionPassed", value: 1 });
  try {
    await ports.afterPass(principal, caller.log);
  } catch (error) {
    caller.log.error("phone.after_pass.failed", { userId: principal.userId, errorName: error instanceof Error ? error.name : "Unknown" });
  }
  return PASSED;
}

/**
 * The password asked again inside a passed session (the recent sign-in of ADR-0011, `stepUp` of the
 * console): the new session of the same user inherits the pass of the session whose still valid id token
 * the browser shows. Anything else (another user, a session that never passed) is refused.
 */
export async function carryPhoneSession(ports: PhonePorts, caller: Pick<PhoneCaller, "principal" | "log">, previous: Principal): Promise<PhoneStatus> {
  const { principal } = caller;
  const now = ports.now();
  const same = previous.origin === "COGNITO" && previous.sub === principal.sub && previous.userId === principal.userId;
  if (!same || !(await isSessionPassed(ports.client, sessionOf(previous), now))) throw new ToolError("FORBIDDEN", "enter the code sent to your phone to continue", "SESSION_NOT_CARRIED");
  await markSessionPassed(ports.client, sessionOf(principal), now);
  caller.log.info("phone.session.carried", { userId: principal.userId, metric: "PhoneSessionCarried", value: 1 });
  return PASSED;
}

/** The sign-out: this session's mark and code go away. */
export async function endPhoneSession(ports: PhonePorts, caller: Pick<PhoneCaller, "principal">): Promise<{ readonly ended: true }> {
  const session = sessionOf(caller.principal);
  await clearSession(ports.client, session);
  await ports.client.delete("Runtime", keyOf(caller.principal));
  ports.gate.forget(session);
  return { ended: true };
}
