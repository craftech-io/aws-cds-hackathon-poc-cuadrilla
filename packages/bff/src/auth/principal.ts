// The principal of a console request (docs/architecture.md §10). Every field comes from the verified
// id token, never from the request input: `ispId`, `userId` and `role` are the claims the pre-token
// trigger stamps from `Isps/USER#` (found by `SUB#<sub>`, auth-triggers/pre-token.ts). The Cognito
// attribute `custom:ispId` is informative only and never read here, and neither are the Cognito
// groups: a user who could change either would still land in the operator and role of the registry.
//
// Each operator has exactly one world (packages/shared/src/clock-ids.ts), so the principal is bound
// to one world: `GLOBAL#isp-demo` for the demo's staff, `GUEST#isp-guest-<nn>` for a guest. The
// `QaDriver` builds its principals on the server instead (auth/qa-principal.ts), bound to the world
// each call names.
import { z } from "zod";
import { ClockId, ConsoleRole, ConsoleUserId, IspId, IspKind, clockIdOfIsp, ispKindOfIspId } from "@cuadrilla/shared";
import { AUTH_REASON, AuthError } from "./errors";
import type { IdTokenClaims } from "./jwt";

/** Where a principal comes from: a verified Cognito id token, or the `QaDriver`, which builds it on the server. */
export type PrincipalOrigin = "COGNITO" | "QA";

export interface Principal {
  readonly origin: PrincipalOrigin;
  /** Cognito `sub`: stable id of the user in the pool (for a QA principal, a fixed marker). */
  readonly sub: string;
  /** Cognito username, the handle AdminGetUser expects. */
  readonly username: string;
  /** Console user of the registry (`Isps/USER#`): the actor of every audit entry. */
  readonly userId: ConsoleUserId;
  /** The only operator this user may read or write. */
  readonly ispId: IspId;
  /** The world of that operator, the only one this principal acts on. */
  readonly clockId: ClockId;
  readonly role: ConsoleRole;
  /** Guest accounts act as supervisors inside their own guest world, without TOTP or password change. */
  readonly isGuest: boolean;
  /** Epoch seconds of the last interactive sign-in (`auth_time`). */
  readonly authTime: number;
  /** One sign-in (`origin_jti`, kept across refreshes): "one session per world" tells two apart. */
  readonly sessionId: string;
}

/** Operators whose staff sign in to the console: the demo and each guest (QA and evaluation worlds have none). */
export const TOKEN_OPERATOR_KINDS: readonly IspKind[] = ["DEMO", "GUEST"];

// What the trigger stamps; a token without all three describes no principal.
const StampedClaims = z.object({
  ispId: IspId,
  userId: ConsoleUserId,
  role: ConsoleRole,
  isGuest: z.enum(["true", "false"]).optional(),
});

/**
 * A guest acts only inside a guest world, and a guest world has only guests (the same rule as the
 * `CONSOLE` caller of packages/shared/src/caller.ts). Returns why the pair does not fit, if it does not.
 */
export function roleWorldMismatch(role: ConsoleRole, kind: IspKind): string | undefined {
  if ((role === "GUEST") !== (kind === "GUEST")) return "a guest belongs to a guest operator, and only guests do";
  return undefined;
}

function incomplete(message: string): AuthError {
  return new AuthError(AUTH_REASON.PRINCIPAL_INCOMPLETE, message);
}

/** The principal of a verified id token; `PRINCIPAL_INCOMPLETE` when the stamped claims do not form one. */
export function principalFromClaims(claims: IdTokenClaims): Principal {
  const stamped = StampedClaims.safeParse(claims);
  if (!stamped.success) throw incomplete("the token carries no operator, console user or console role");
  const { ispId, userId, role, isGuest } = stamped.data;
  const kind = ispKindOfIspId(ispId);
  if (!TOKEN_OPERATOR_KINDS.includes(kind)) throw incomplete("console accounts belong to the demo operator or to a guest");
  const mismatch = roleWorldMismatch(role, kind);
  if (mismatch !== undefined) throw incomplete(mismatch);
  if (isGuest !== undefined && (isGuest === "true") !== (role === "GUEST")) throw incomplete("the guest flag contradicts the console role");
  return {
    origin: "COGNITO",
    sub: claims.sub,
    username: claims["cognito:username"],
    userId,
    ispId,
    clockId: clockIdOfIsp(ispId),
    role,
    isGuest: role === "GUEST",
    authTime: claims.auth_time,
    sessionId: claims.origin_jti ?? `auth-${claims.auth_time}`,
  };
}

/** How long after an interactive sign-in the manual evidence validation stays open (ADR-0011). */
export const RECENT_LOGIN_MAX_AGE_SECONDS = 15 * 60;

// Tolerated clock difference between Cognito and the Lambda.
const CLOCK_SKEW_SECONDS = 60;

/** True while the last interactive sign-in is inside the recent-login window (real clock). */
export function isSignInFresh(principal: Pick<Principal, "authTime">, now: Date, maxAgeSeconds: number = RECENT_LOGIN_MAX_AGE_SECONDS): boolean {
  const ageSeconds = Math.floor(now.getTime() / 1000) - principal.authTime;
  return ageSeconds >= -CLOCK_SKEW_SECONDS && ageSeconds <= maxAgeSeconds;
}
