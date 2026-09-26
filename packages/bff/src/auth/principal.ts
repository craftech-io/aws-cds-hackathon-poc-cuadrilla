// The principal of a console request. Every field comes from the verified id token, never from the
// request input (docs/architecture.md §10). `ispId`, `userId`, `role` and `isJudge` are the claims
// the pre-token trigger stamps from `Isps/USER#` (found by `SUB#<sub>`); the Cognito attribute
// `custom:ispId` is informative only and is never read here, so a user who could change it would
// still land in the operator of the registry.
import { z } from "zod";
import { ConsoleRole } from "@cuadrilla/shared";
import { AUTH_REASON, AuthError } from "./errors";
import type { IdTokenClaims } from "./jwt";

/** Operator ids are `isp-<slug>` (docs/seed-spec.md §2). */
export const IspId = z.string().regex(/^isp-[a-z0-9]+(?:-[a-z0-9]+)*$/);
export type IspId = z.infer<typeof IspId>;

export interface Principal {
  /** Cognito `sub`: stable id of the user in the pool. */
  readonly sub: string;
  /** Cognito username, the handle AdminGetUser expects. */
  readonly username: string;
  /** Console user of the registry (`Isps/USER#`), once stamped or matched by the user directory. */
  readonly userId?: string;
  /** The only operator this user may read or write. */
  readonly ispId: IspId;
  readonly role: ConsoleRole;
  readonly groups: readonly ConsoleRole[];
  /** Judge accounts act as supervisors inside their own judge world, without TOTP or password change. */
  readonly isJudge: boolean;
  /** Epoch seconds of the last interactive sign-in (`auth_time`). */
  readonly authTime: number;
}

// `ConsoleRole` is declared in precedence order, SUPERVISOR first.
const ROLE_PRECEDENCE: readonly ConsoleRole[] = ConsoleRole.options;

/** Cognito group names that are console roles, highest precedence first. */
export function consoleRolesOf(groupNames: readonly string[] | undefined): ConsoleRole[] {
  return (groupNames ?? [])
    .flatMap((group) => {
      const parsed = ConsoleRole.safeParse(group);
      return parsed.success ? [parsed.data] : [];
    })
    .sort((a, b) => ROLE_PRECEDENCE.indexOf(a) - ROLE_PRECEDENCE.indexOf(b));
}

/**
 * Same resolution the console uses to draw its menu (packages/web/src/lib/auth-claims.ts): the
 * stamped `role` wins, otherwise the highest-precedence group.
 */
export function principalFromClaims(claims: IdTokenClaims): Principal {
  const ispId = IspId.safeParse(claims.ispId);
  if (!ispId.success) {
    throw new AuthError(AUTH_REASON.PRINCIPAL_INCOMPLETE, "the token carries no operator");
  }
  const groups = consoleRolesOf(claims["cognito:groups"]);
  const stampedRole = ConsoleRole.safeParse(claims.role);
  const role = stampedRole.success ? stampedRole.data : groups[0];
  if (!role) {
    throw new AuthError(AUTH_REASON.PRINCIPAL_INCOMPLETE, "the token carries no console role");
  }
  return {
    sub: claims.sub,
    username: claims["cognito:username"],
    ...(claims.userId ? { userId: claims.userId } : {}),
    ispId: ispId.data,
    role,
    groups,
    isJudge: role === "JUDGE" || claims.isJudge === "true",
    authTime: claims.auth_time,
  };
}

/** How long after an interactive sign-in the manual evidence validation stays open (ADR-0011). */
export const RECENT_LOGIN_MAX_AGE_SECONDS = 15 * 60;

// Tolerated clock difference between Cognito and the Lambda.
const CLOCK_SKEW_SECONDS = 60;

/** True while the last interactive sign-in is inside the recent-login window. */
export function isSignInFresh(principal: Pick<Principal, "authTime">, now: Date, maxAgeSeconds: number = RECENT_LOGIN_MAX_AGE_SECONDS): boolean {
  const ageSeconds = Math.floor(now.getTime() / 1000) - principal.authTime;
  return ageSeconds >= -CLOCK_SKEW_SECONDS && ageSeconds <= maxAgeSeconds;
}
