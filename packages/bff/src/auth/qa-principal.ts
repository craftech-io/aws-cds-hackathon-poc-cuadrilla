// Principals the `QaDriver` builds on the server for its `console.*` actions (ADR-0007,
// docs/tool-catalog.md "Acciones del QaDriver"): `appRouter.createCaller(ctx)` runs the real
// middlewares with a `SUPERVISOR` (`usr-qa-sup`) or `OPS` (`usr-qa-ops`) of the scenario's QA
// operator, or the `GUEST` `usr-qa-guest` of `isp-guest-test`, always bound to the world the call
// names. No password, no token: nothing a request carries can produce one of these (routers/trpc.ts
// builds principals from requests only out of verified id tokens).
import { Caller, type ConsoleRole, ispIdOfClock, parseClockId } from "@cuadrilla/shared";
import { AUTH_REASON, AuthError } from "./errors";
import type { Principal } from "./principal";

/** The logical console users of the `QaDriver` (docs/seed-spec.md §4). */
export const QA_USER_BY_ROLE = {
  SUPERVISOR: "usr-qa-sup",
  OPS: "usr-qa-ops",
  GUEST: "usr-qa-guest",
} as const satisfies Record<ConsoleRole, string>;

/** `sub` and username of every QA principal: never a Cognito identity. */
export const QA_SUBJECT = "qa-driver";

export interface QaPrincipalInput {
  readonly role: ConsoleRole;
  /** The world the call names: `qa-*`, `eval-*`, or `GUEST#isp-guest-test` (as `GUEST` only). */
  readonly clockId: string;
  /** Epoch seconds of the "sign-in"; defaults to now (a recent login). `SC-13/2` sets it 20 min back. */
  readonly authTime?: number;
  /** Tells two sessions of the same principal apart (`SC-19` opens A and B). */
  readonly sessionId?: string;
}

/**
 * The principal of one `QaDriver` call. The world rules are the shared `QA` caller's (qa-*, eval-*
 * and `GUEST#isp-guest-test` as `GUEST` only); anything else is `ROLE_NOT_ALLOWED`.
 */
export function qaPrincipal(input: QaPrincipalInput, now: Date): Principal {
  if (parseClockId(input.clockId) === undefined) throw new AuthError(AUTH_REASON.ROLE_NOT_ALLOWED, "the QA principal needs a valid world");
  const ispId = ispIdOfClock(input.clockId);
  const userId = QA_USER_BY_ROLE[input.role];
  const caller = Caller.safeParse({ kind: "QA", ispId, clockId: input.clockId, userId, role: input.role });
  if (!caller.success) {
    throw new AuthError(AUTH_REASON.ROLE_NOT_ALLOWED, `the QA principal ${input.role} cannot act on this world`, { cause: caller.error });
  }
  const authTime = input.authTime ?? Math.floor(now.getTime() / 1000);
  return {
    origin: "QA",
    sub: QA_SUBJECT,
    username: QA_SUBJECT,
    userId,
    ispId,
    clockId: input.clockId,
    role: input.role,
    isGuest: input.role === "GUEST",
    authTime,
    sessionId: input.sessionId ?? `qa-${userId}`,
  };
}
