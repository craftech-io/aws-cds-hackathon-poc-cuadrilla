// Who is signed in at the local UI server. The specs replace Cognito with a route mock
// (packages/web/e2e/support/cognito.ts, src/lib/auth/testing/fake-cognito.ts) whose id tokens are signed
// with the run's ephemeral RSA key; the BFF checks them with its real verifier against that key's JWKS,
// which only this server's entry injects (main.ts; packages/bff/src/auth/no-jwks-override.test.ts).
//
// The mock does not run the pre-token trigger, so its tokens carry the operator and the role but not the
// registry's user. This stand-in of the trigger does what the real one does from the registry
// (auth-triggers/pre-token.ts): the user of the token's `sub`, registered on first sight in the operator
// and role the token names (the fake pool's users are born per spec), and the token's claims stamped with
// that user. A token whose signature, issuer, audience or expiry fails is refused before any of this.
import { type ConsoleRole, guestOriginOfIsp } from "@cuadrilla/shared";
import type { Connector } from "../../packages/bff/src/connector/ports";
import { AUTH_REASON, AuthError } from "../../packages/bff/src/auth/errors";
import type { IdTokenClaims, IdTokenVerifier } from "../../packages/bff/src/auth/jwt";

const ROLES: readonly ConsoleRole[] = ["SUPERVISOR", "OPS", "GUEST"];

/** `usr-e2e-<12 hex of the sub>`: one console user per user of the fake pool. */
export function userIdOfSub(sub: string): string {
  const hex = sub.replace(/[^0-9a-f]/gi, "").toLowerCase().slice(-12).padStart(12, "0");
  return `usr-e2e-${hex}`;
}

/** The first verifier that accepts the token (the fake pool's audience and the console's client). */
function anyOf(verifiers: readonly IdTokenVerifier[]): IdTokenVerifier {
  return {
    async verify(token) {
      let last: unknown;
      for (const verifier of verifiers) {
        try {
          return await verifier.verify(token);
        } catch (error) {
          last = error;
        }
      }
      throw last instanceof AuthError ? last : new AuthError(AUTH_REASON.TOKEN_INVALID, "the token is not valid");
    },
  };
}

export function stampingVerifier(verifiers: readonly IdTokenVerifier[], connector: Pick<Connector, "isps">): IdTokenVerifier {
  const verify = anyOf(verifiers);
  return {
    async verify(token) {
      const claims = await verify.verify(token);
      const stamped = claims as IdTokenClaims & Record<string, unknown>;
      const existing = await connector.isps.findUserBySub(claims.sub);
      if (existing !== undefined) return { ...stamped, ispId: existing.ispId, userId: existing.userId, role: existing.role, isGuest: existing.role === "GUEST" ? "true" : "false" };
      const ispId = typeof stamped.ispId === "string" ? stamped.ispId : undefined;
      const role = ROLES.find((candidate) => candidate === stamped.role);
      // Without an operator and a role there is no principal: the BFF answers as it would to a real token.
      if (ispId === undefined || role === undefined) return claims;
      const userId = typeof stamped.userId === "string" ? stamped.userId : userIdOfSub(claims.sub);
      const name = typeof stamped.name === "string" ? stamped.name : role === "GUEST" ? "Invitado" : role === "OPS" ? "Operaciones" : "Supervisión";
      const guestOrigin = role === "GUEST" ? guestOriginOfIsp(ispId) : undefined;
      await connector.isps.putUser({ ispId, userId, role, name, cognitoSub: claims.sub, ...(guestOrigin === undefined ? {} : { guestOrigin }) });
      return { ...stamped, ispId, userId, role, isGuest: role === "GUEST" ? "true" : "false" };
    },
  };
}
