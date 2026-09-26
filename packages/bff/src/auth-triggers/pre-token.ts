// Cognito pre token generation trigger (event V2_0; infra/auth.ts points `AuthPreToken` at
// `packages/bff/src/auth-triggers/pre-token.handler`). On every sign-in and every refresh it finds
// the console user of the token's `sub` in the registry (`Isps/USER#`, GSI1 `SUB#<sub>`) and stamps
// what the BFF trusts (auth/principal.ts):
//
//   ispId, userId, role, isJudge    from the registry row, never from the `custom:ispId` attribute
//   cognito:groups                  overridden with the registry role, so the token tells one story
//   custom:ispId                    suppressed from the id token: nothing downstream can read it
//
// A `custom:ispId` that differs from the registry is ignored and audited (`AuditLog DENY
// CUSTOM_ISP_ID_IGNORED` in the registry operator; FL-081). A `sub` with no row, with two rows, or
// with a row that breaks the console's rules (a judge outside a judge operator, a user of a QA or
// evaluation operator) gets no operator and no role: its token opens nothing (PRINCIPAL_INCOMPLETE).
// An inactive user is stamped like any other; the BFF refuses it on every request (USER_INACTIVE).
// Registry or audit failures fail the sign-in (Cognito waits 5 s; the deadline here is shorter).
import type { ClaimsAndScopeOverrideDetails, PreTokenGenerationV2TriggerEvent } from "aws-lambda";
import { z } from "zod";
import { IspId, clockIdOfIsp, ispKindOfIspId } from "@cuadrilla/shared";
import { connector } from "../connector/index";
import type { AuditPort } from "../connector/ports";
import { userActor } from "../domain/common";
import type { ConsoleUser } from "../domain/isps";
import { withDeadline } from "../lib/deadline";
import { type Logger, createLogger } from "../lib/log";
import { describeError } from "../auth/errors";
import { roleWorldMismatch, TOKEN_OPERATOR_KINDS } from "../auth/principal";

/** The informative attribute the invitation sets; never trusted, never forwarded. */
export const CUSTOM_ISP_ID_ATTRIBUTE = "custom:ispId";

/** Below the 5 s Cognito gives the trigger, so a slow registry fails with a clear log line. */
export const PRE_TOKEN_DEADLINE_MS = 4_000;

// zod at the edge: only what the trigger reads; Cognito sends more (and more over time).
const PreTokenEvent = z.looseObject({
  triggerSource: z.string().startsWith("TokenGeneration_"),
  request: z.looseObject({
    userAttributes: z.record(z.string(), z.string()).refine((attributes) => (attributes.sub ?? "") !== "", "the event carries no sub"),
  }),
});

export interface PreTokenDeps {
  /** The console user of a Cognito `sub` (`Isps` GSI1); `undefined` for none or more than one. */
  readonly findUserBySub: (sub: string) => Promise<ConsoleUser | undefined>;
  readonly audit: Pick<AuditPort, "append">;
  /** A logger per invocation (its own correlation id). */
  readonly newLogger: () => Logger;
}

/** What the trigger decided for one user, before it becomes Cognito's response. */
export type TokenDecision =
  | { readonly kind: "STAMP"; readonly user: ConsoleUser; readonly ignoredIspId?: string }
  | { readonly kind: "NO_PRINCIPAL"; readonly why: "UNREGISTERED" | "INCONSISTENT" };

/** Pure: the registry row (if any) and the attribute → what the token may say. */
export function decideTokenClaims(user: ConsoleUser | undefined, attributeIspId: string | undefined): TokenDecision {
  if (user === undefined) return { kind: "NO_PRINCIPAL", why: "UNREGISTERED" };
  const kind = ispKindOfIspId(user.ispId);
  if (!TOKEN_OPERATOR_KINDS.includes(kind) || roleWorldMismatch(user.role, kind) !== undefined) return { kind: "NO_PRINCIPAL", why: "INCONSISTENT" };
  const differs = attributeIspId !== undefined && attributeIspId !== "" && attributeIspId !== user.ispId;
  return differs ? { kind: "STAMP", user, ignoredIspId: attributeIspId } : { kind: "STAMP", user };
}

/** Cognito's `claimsAndScopeOverrideDetails` for a decision. */
export function overrideDetails(decision: TokenDecision): ClaimsAndScopeOverrideDetails {
  if (decision.kind === "NO_PRINCIPAL") {
    return { idTokenGeneration: { claimsToSuppress: [CUSTOM_ISP_ID_ATTRIBUTE] }, groupOverrideDetails: { groupsToOverride: [] } };
  }
  const { user } = decision;
  return {
    idTokenGeneration: {
      claimsToAddOrOverride: { ispId: user.ispId, userId: user.userId, role: user.role, isJudge: String(user.role === "JUDGE") },
      claimsToSuppress: [CUSTOM_ISP_ID_ATTRIBUTE],
    },
    groupOverrideDetails: { groupsToOverride: [user.role] },
  };
}

async function auditIgnoredAttribute(deps: PreTokenDeps, user: ConsoleUser, ignoredIspId: string): Promise<void> {
  await deps.audit.append({
    ispId: user.ispId,
    clockId: clockIdOfIsp(user.ispId),
    decision: "DENY",
    action: "CUSTOM_ISP_ID_IGNORED",
    actor: userActor(user.userId),
    reason: "the custom:ispId attribute differs from the registry; the token carries the registry's operator",
    refs: { userId: user.userId },
    // An operator id is not personal data; anything that is not one is not repeated.
    detail: { attributeIspId: IspId.safeParse(ignoredIspId).success ? ignoredIspId : "(not an operator id)" },
  });
}

export function createPreTokenHandler(resolveDeps: () => PreTokenDeps) {
  return async (event: PreTokenGenerationV2TriggerEvent): Promise<PreTokenGenerationV2TriggerEvent> => {
    const deps = resolveDeps();
    const log = deps.newLogger();
    const parsed = PreTokenEvent.safeParse(event);
    if (!parsed.success) {
      log.error("auth.pretoken.invalid_event", { triggerSource: event.triggerSource });
      throw new Error("pre token generation: unexpected event");
    }
    const { triggerSource, request } = parsed.data;
    const attributes = request.userAttributes;

    let decision: TokenDecision;
    try {
      decision = await withDeadline("auth.pretoken", PRE_TOKEN_DEADLINE_MS, async () => {
        const outcome = decideTokenClaims(await deps.findUserBySub(attributes.sub ?? ""), attributes[CUSTOM_ISP_ID_ATTRIBUTE]);
        if (outcome.kind === "STAMP" && outcome.ignoredIspId !== undefined) await auditIgnoredAttribute(deps, outcome.user, outcome.ignoredIspId);
        return outcome;
      });
    } catch (error) {
      // Fails the sign-in: a token is never issued without the registry's answer (and its audit).
      log.error("auth.pretoken.failed", { triggerSource, ...describeError(error) });
      throw error;
    }

    if (decision.kind === "STAMP") {
      const { user } = decision;
      const fields = { triggerSource, userId: user.userId, ispId: user.ispId, role: user.role, active: user.active };
      if (decision.ignoredIspId !== undefined) log.warn("auth.pretoken.custom_ispid_ignored", fields);
      else log.info("auth.pretoken.stamped", fields);
    } else {
      log.warn("auth.pretoken.no_principal", { triggerSource, why: decision.why });
    }
    return { ...event, response: { claimsAndScopeOverrideDetails: overrideDetails(decision) } };
  };
}

let defaults: PreTokenDeps | undefined;

function defaultPreTokenDeps(): PreTokenDeps {
  if (defaults) return defaults;
  const data = connector();
  defaults = {
    findUserBySub: (sub) => data.isps.findUserBySub(sub),
    audit: data.audit,
    newLogger: () => createLogger({ bindings: { service: "auth-pre-token" } }),
  };
  return defaults;
}

export const handler = createPreTokenHandler(defaultPreTokenDeps);
