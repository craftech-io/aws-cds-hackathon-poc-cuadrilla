// What a console request needs besides its input. Procedures reach the domain through `ctx.deps`
// so tests swap every adapter; the defaults are built once per Lambda container and read the
// linked resources lazily, on the first request. WP-13 adds the connector, the user directory
// over `Isps` and the world clock.
import { authConfig } from "../auth/config";
import { type IdTokenVerifier, createCognitoIdTokenVerifier } from "../auth/jwt";
import type { UserDirectory } from "../auth/staff";
import { type TotpStatusReader, createCognitoTotpReader } from "../auth/totp";
import { type Logger, createLogger } from "../lib/log";

export interface ContextDeps {
  readonly verifier: IdTokenVerifier;
  /** Console users by Cognito `sub`; absent until the connector exists (WP-07/WP-13). */
  readonly users?: UserDirectory;
  readonly totp: TotpStatusReader;
  /** Real time: `auth_time` comes from Cognito's clock, never from a world clock. */
  readonly wallClock: () => Date;
  /** One logger per request, bound to its correlation id. */
  readonly loggerFor: (correlationId: string) => Logger;
}

let cached: ContextDeps | undefined;

export function defaultDeps(): ContextDeps {
  if (cached) return cached;
  const config = authConfig();
  cached = {
    verifier: createCognitoIdTokenVerifier(config),
    totp: createCognitoTotpReader(config),
    wallClock: () => new Date(),
    loggerFor: (correlationId) => createLogger({ correlationId, bindings: { service: "bff" } }),
  };
  return cached;
}

/** Test seam. */
export function resetDefaultDeps(): void {
  cached = undefined;
}
