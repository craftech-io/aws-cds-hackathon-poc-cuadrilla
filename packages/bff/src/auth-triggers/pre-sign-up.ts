/// <reference path="../../sst-env.d.ts" />
// Cognito pre sign-up trigger (ADR-0025 §1, infra/auth.ts `AuthPreSignUp`). Denies by default:
//
//   PreSignUp_AdminCreateUser   the operator's invitations (`console:invite`): pass, no ticket
//   PreSignUp_SignUp            only with the sign-up ticket of `signup.start` in
//                               `clientMetadata.signupTicket` (signup/ticket.ts): a valid HMAC, not
//                               expired, the `emailHash` of this email, this very `userName`, and at
//                               most two uses, always for that user; no `custom:*` attribute; a
//                               `locale` in {es-MX, en}; the email without a confirmed lead
//                               (EMAIL_TAKEN); the sign-up not cut and today's starts not over the cap
//                               (CAP_REACHED), both READ, never incremented (only `signup.start` counts)
//   anything else               refused (an external provider, a migration)
//
// It never confirms nor verifies anything (`autoConfirmUser`, `autoVerifyEmail` stay false). A refusal
// throws an error whose message is only its code, so Cognito answers the browser with
// `PreSignUp failed with error <CODE>.` and the web shows its neutral text. The only write is the use
// of the ticket (`SIGNUPTICKET#<nonce>`). Works within 4 s of the 5 Cognito waits; the email is hashed
// at once and never logged.
import type { PreSignUpTriggerEvent } from "aws-lambda";
import { z } from "zod";
import { LEGAL_LOCALES } from "@cuadrilla/shared/legal/consents";
import { describeError } from "../auth/errors";
import { tableClient } from "../connector/index";
import type { TableClient } from "../connector/table-client";
import { dynamoLeadStore } from "../leads/dynamo-table";
import { hashPrefix, leadEmailHash, normalizeLeadEmail } from "../leads/keys";
import type { LeadStore } from "../leads/store";
import { withDeadline } from "../lib/deadline";
import { type Logger, createLogger } from "../lib/log";
import { subkey } from "../lib/secrets";
import { killSwitchReader } from "../ops/defaults";
import { type KillSwitchReader, blockingScope } from "../ops/kill-switch";
import { SIGNUP_LIMITS, startsToday } from "../signup/limits";
import { readTicket, spendTicketUse } from "../signup/ticket";

/** Below the 5 s Cognito gives a trigger. */
export const PRE_SIGN_UP_DEADLINE_MS = 4_000;

/** The codes the browser can read in Cognito's answer (lib/auth/errors.ts of the web). */
export type PreSignUpRefusal = "TICKET_INVALID" | "EMAIL_TAKEN" | "CAP_REACHED" | "ATTRIBUTE_NOT_ALLOWED" | "LOCALE_NOT_ALLOWED" | "SOURCE_NOT_ALLOWED" | "UNAVAILABLE";

export class PreSignUpRefused extends Error {
  override readonly name = "PreSignUpRefused";
  constructor(readonly code: PreSignUpRefusal) {
    super(code);
  }
}

const ALLOWED_SOURCES = new Set(["PreSignUp_SignUp", "PreSignUp_AdminCreateUser"]);

// zod at the edge: only what the trigger reads.
const PreSignUpEvent = z.looseObject({
  triggerSource: z.string().min(1).max(64),
  userName: z.string().min(1).max(128),
  request: z.looseObject({
    userAttributes: z.record(z.string(), z.string()),
    clientMetadata: z.record(z.string(), z.string()).nullish(),
  }),
});

export interface PreSignUpDeps {
  readonly runtime: Pick<TableClient, "get" | "increment">;
  readonly leads: Pick<LeadStore, "get">;
  readonly kill: Pick<KillSwitchReader, "status">;
  readonly emailHashKey: () => Uint8Array | string;
  readonly ticketKey: () => Uint8Array | string;
  /** Real clock: tickets and the daily cap are real time. */
  readonly now: () => Date;
  readonly log: Logger;
}

export type PreSignUpDecision = { readonly kind: "ADMIN_CREATE_USER" } | { readonly kind: "SIGN_UP"; readonly emailHash: string };

/** The checks of a `SignUp`, cheapest and without writes first; the ticket's use is spent last. */
async function checkSignUp(deps: PreSignUpDeps, userName: string, attributes: Readonly<Record<string, string>>, metadata: Readonly<Record<string, string>>): Promise<PreSignUpDecision> {
  if (Object.keys(attributes).some((name) => name.startsWith("custom:"))) throw new PreSignUpRefused("ATTRIBUTE_NOT_ALLOWED");
  const locale = attributes.locale;
  if (locale !== undefined && !(LEGAL_LOCALES as readonly string[]).includes(locale)) throw new PreSignUpRefused("LOCALE_NOT_ALLOWED");
  const now = deps.now();
  const read = readTicket(deps.ticketKey(), metadata.signupTicket, now);
  if (!read.ok) throw new PreSignUpRefused("TICKET_INVALID");
  let email: string;
  try {
    email = normalizeLeadEmail(attributes.email ?? "");
  } catch {
    throw new PreSignUpRefused("TICKET_INVALID");
  }
  const emailHash = leadEmailHash(deps.emailHashKey(), email);
  if (read.ticket.emailHash !== emailHash || read.ticket.username !== userName) throw new PreSignUpRefused("TICKET_INVALID");
  if (blockingScope(await deps.kill.status(), "SIGNUP") !== undefined) throw new PreSignUpRefused("CAP_REACHED");
  // The day's starts were reserved by `signup.start`; a day over its cap (the cap lowered, or a start
  // that raced it) takes no more accounts. Read only: nothing here counts.
  if ((await startsToday(deps.runtime, { kind: "PUBLIC" }, now)) > SIGNUP_LIMITS.startsPerDay) throw new PreSignUpRefused("CAP_REACHED");
  if ((await deps.leads.get(emailHash))?.status === "CONFIRMED") throw new PreSignUpRefused("EMAIL_TAKEN");
  if (!(await spendTicketUse(deps.runtime, read.ticket, now))) throw new PreSignUpRefused("TICKET_INVALID");
  return { kind: "SIGN_UP", emailHash };
}

export async function decidePreSignUp(deps: PreSignUpDeps, event: z.infer<typeof PreSignUpEvent>): Promise<PreSignUpDecision> {
  if (!ALLOWED_SOURCES.has(event.triggerSource)) throw new PreSignUpRefused("SOURCE_NOT_ALLOWED");
  if (event.triggerSource === "PreSignUp_AdminCreateUser") return { kind: "ADMIN_CREATE_USER" };
  return checkSignUp(deps, event.userName, event.request.userAttributes, event.request.clientMetadata ?? {});
}

export function createPreSignUpHandler(depsOf: (log: Logger) => PreSignUpDeps, newLogger: () => Logger) {
  return async (event: PreSignUpTriggerEvent): Promise<PreSignUpTriggerEvent> => {
    const log = newLogger();
    const parsed = PreSignUpEvent.safeParse(event);
    const source = typeof event?.triggerSource === "string" ? event.triggerSource.slice(0, 64) : "unknown";
    let decision: PreSignUpDecision;
    try {
      if (!parsed.success) throw new PreSignUpRefused("SOURCE_NOT_ALLOWED");
      decision = await withDeadline("auth.presignup", PRE_SIGN_UP_DEADLINE_MS, () => decidePreSignUp(depsOf(log), parsed.data));
    } catch (error) {
      if (error instanceof PreSignUpRefused) {
        log.warn("auth.presignup.refused", { triggerSource: source, reason: error.code, metric: "SignupRejected", value: 1 });
        throw error;
      }
      log.error("auth.presignup.failed", { triggerSource: source, ...describeError(error) });
      throw new PreSignUpRefused("UNAVAILABLE");
    }
    log.info("auth.presignup.accepted", { triggerSource: source, kind: decision.kind, ...(decision.kind === "SIGN_UP" ? { emailHash: hashPrefix(decision.emailHash) } : {}) });
    // Never confirmed nor verified here: the code the visitor receives does that.
    event.response.autoConfirmUser = false;
    event.response.autoVerifyEmail = false;
    event.response.autoVerifyPhone = false;
    return event;
  };
}

let defaults: Omit<PreSignUpDeps, "log"> | undefined;

function defaultDeps(log: Logger): PreSignUpDeps {
  defaults ??= {
    runtime: tableClient(),
    leads: dynamoLeadStore(),
    kill: killSwitchReader(),
    emailHashKey: () => subkey("email-hash"),
    ticketKey: () => subkey("signup-ticket"),
    now: () => new Date(),
  };
  return { ...defaults, log };
}

export const handler = createPreSignUpHandler(defaultDeps, () => createLogger({ bindings: { service: "auth-pre-sign-up" } }));
