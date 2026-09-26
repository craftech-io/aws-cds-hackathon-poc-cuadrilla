// What a console request needs besides its input. Procedures reach the domain through `ctx.deps`
// so tests swap every adapter; the defaults are built once per Lambda container, read the linked
// resources lazily (`Resource`, never `process.env`) and are frozen: nothing a request carries, and
// nothing the process environment says, can replace the token verifier or the keys it trusts
// (auth/no-jwks-override.test.ts). The local UI server and the tests build their own dependencies
// from their own entry and pass them to `createContextFactory`.
import { ConnectorError } from "@cuadrilla/shared";
import { z } from "zod";
import { authConfig } from "../auth/config";
import { type IdTokenVerifier, createCognitoIdTokenVerifier } from "../auth/jwt";
import { type UserDirectory, createUserDirectory } from "../auth/staff";
import { connector } from "../connector/index";
import type { Connector } from "../connector/ports";
import { withDeadline } from "../lib/deadline";
import { type Logger, createLogger } from "../lib/log";
import { readLinked } from "../lib/resource";
import { withRetry } from "../lib/retry";
import { type NetworkClient, networkClient } from "../network/client";
import { type HttpResponse, type HttpTransport, sigv4Transport } from "../network/sigv4";

export type MockHealth = "OK" | "UNAVAILABLE";

/** `GET /v1/health` of the two simulated systems, called with the BFF's own role (`health.ping`). */
export interface MockHealthReport {
  readonly network: MockHealth;
  readonly dispatch: MockHealth;
}

/** Never throws: an unreachable mock is `UNAVAILABLE`. */
export type MockHealthProbe = (log: Logger) => Promise<MockHealthReport>;

export interface ContextDeps {
  readonly verifier: IdTokenVerifier;
  /** Every table of the app (docs/architecture.md §5): the fence, the audit log and the feature routers read it. */
  readonly connector: Connector;
  /** Console users by Cognito `sub` over `Isps` (GSI1 `SUB#<sub>`): deactivation applies within a minute. */
  readonly users: UserDirectory;
  readonly mocks: MockHealthProbe;
  /** Real time: `auth_time` comes from Cognito's clock, never from a world clock. */
  readonly wallClock: () => Date;
  /** One logger per request, bound to its correlation id. */
  readonly loggerFor: (correlationId: string) => Logger;
}

// Same budget as the network client (docs/architecture-integrations.md §6): 3 s per attempt, 2 retries.
const DISPATCH_TIMEOUT_MS = 3_000;
const DISPATCH_ATTEMPTS = 3;
const HEALTH_PATH = "/v1/health";

class ProbeFailure extends Error {
  override readonly name = "ProbeFailure";
  constructor(readonly retryable: boolean) {
    super(retryable ? "retryable" : "final");
  }
}

export interface MockHealthPorts {
  readonly network: Pick<NetworkClient, "health">;
  /** Transport to the dispatch mock's Function URL (SigV4 in a Lambda). */
  readonly dispatch: HttpTransport;
  readonly timeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export function createMockHealthProbe(ports: MockHealthPorts): MockHealthProbe {
  const timeoutMs = ports.timeoutMs ?? DISPATCH_TIMEOUT_MS;
  const request = { method: "GET", path: HEALTH_PATH, headers: { accept: "application/json" } } as const;

  async function attempt(): Promise<void> {
    let response: HttpResponse;
    try {
      response = await withDeadline("dispatch.health", timeoutMs, (signal) => ports.dispatch(request, signal));
    } catch (error) {
      // A mock that is not linked (or not a Function URL) will not be one on the next attempt.
      throw new ProbeFailure(!(error instanceof ConnectorError || error instanceof RangeError));
    }
    if (response.status !== 200) throw new ProbeFailure(response.status >= 500 || response.status === 429);
  }

  async function dispatchHealth(log: Logger): Promise<MockHealth> {
    try {
      await withRetry(attempt, {
        attempts: DISPATCH_ATTEMPTS,
        baseDelayMs: 200,
        shouldRetry: (error) => error instanceof ProbeFailure && error.retryable,
        ...(ports.sleep ? { sleep: ports.sleep } : {}),
      });
      return "OK";
    } catch {
      log.warn("health.mock.unavailable", { mock: "dispatch" });
      return "UNAVAILABLE";
    }
  }

  // The network client maps its own failures to outcomes (network/client.ts); anything else is an outage too.
  async function networkHealth(log: Logger): Promise<MockHealth> {
    const outcome = await ports.network.health(log).catch(() => undefined);
    return outcome?.kind === "OK" ? "OK" : "UNAVAILABLE";
  }

  return async (log) => {
    const [network, dispatch] = await Promise.all([networkHealth(log), dispatchHealth(log)]);
    return { network, dispatch };
  };
}

const LinkedFunctionUrl = z.object({ url: z.url() });

/** SigV4 transport to the `DispatchMock` Function URL linked to the BFF, resolved on first use. */
function linkedDispatchTransport(): HttpTransport {
  let transport: HttpTransport | undefined;
  return (request, signal) => {
    try {
      transport ??= sigv4Transport({ baseUrl: readLinked("DispatchMock", LinkedFunctionUrl).url });
    } catch (error) {
      return Promise.reject(error);
    }
    return transport(request, signal);
  };
}

let cached: ContextDeps | undefined;

export function defaultDeps(): ContextDeps {
  if (cached) return cached;
  const config = authConfig();
  const data = connector();
  cached = Object.freeze({
    // The pool's own keys, from its issuer: this call never takes a fetcher (no JWKS override).
    verifier: createCognitoIdTokenVerifier(config),
    connector: data,
    users: createUserDirectory(data.isps),
    mocks: createMockHealthProbe({ network: networkClient(), dispatch: linkedDispatchTransport() }),
    wallClock: () => new Date(),
    loggerFor: (correlationId: string) => createLogger({ correlationId, bindings: { service: "bff" } }),
  });
  return cached;
}

/** Test seam: forget the container's dependencies (they are rebuilt from the links on next use). */
export function resetDefaultDeps(): void {
  cached = undefined;
}
