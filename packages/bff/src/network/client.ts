// Client of the network orchestrator (docs/architecture-integrations.md §6), the one module that
// talks to `NetworkMock`: SigV4 over its Function URL with `X-World`, 3 s per attempt, 2 retries that
// honour `Retry-After`, and every failure mapped to an outcome instead of an exception. Exhausted
// retries are `UNAVAILABLE`, which `get_onu_status` reports as `available: false` so the agent says
// it cannot see the network right now and goes on with the manual (FL-026).
//
// Callers: `get_onu_status` and `close_installation` (reads), the validator's cross-check
// (`VAL-CROSSCHECK`), the console's `orders.onuStatus`, the worker's physical action, and the demo
// and QA controls. Reads never change an ONU; only `reportPhysicalAction` and `setBehaviour` do.
import {
  BehaviourRequest,
  CONTROL_ROUTES,
  MOCK_HEADERS,
  NetworkReader,
  OnuControlState,
  PhysicalActionKind,
  RETRY_AFTER_HEADER,
  WORLD_HEADER,
  WorldTime,
  onuPath,
  type OnuStatus,
} from "@cuadrilla/network-contract";
import { ClockId } from "@cuadrilla/shared";
import { z } from "zod";
import { DeadlineError, withDeadline } from "../lib/deadline";
import { createLogger, type Logger } from "../lib/log";
import { readLinked } from "../lib/resource";
import { withRetry } from "../lib/retry";
import { CLIENT_CONTRACT } from "./contract";
import { mayHaveFaults, runtimeFaultReader, type NetworkFaultReader } from "./faults";
import { sigv4Transport, type HttpRequest, type HttpResponse, type HttpTransport } from "./sigv4";

export const NETWORK_TIMEOUT_MS = 3_000;
export const NETWORK_RETRIES = 2;
/** A `Retry-After` longer than this is shortened: a tool turn cannot wait minutes for the network. */
export const MAX_RETRY_AFTER_MS = 2_000;

export type UnavailableReason = "HTTP_5XX" | "THROTTLED" | "CONFLICT" | "TIMEOUT" | "NETWORK_ERROR" | "FORBIDDEN" | "BAD_REQUEST" | "INVALID_RESPONSE" | "NOT_CONFIGURED";

export type NetworkOutcome<T> =
  | { readonly kind: "OK"; readonly value: T; readonly attempts: number }
  | { readonly kind: "NOT_FOUND"; readonly attempts: number }
  | { readonly kind: "UNAVAILABLE"; readonly reason: UnavailableReason; readonly attempts: number };

/** Every call is inside one world, at the world's simulated time, on behalf of one principal kind. */
const WorldCall = z.object({
  clockId: ClockId,
  serial: CLIENT_CONTRACT.serial,
  caller: NetworkReader,
  atSim: WorldTime,
});
export type WorldCall = z.infer<typeof WorldCall> & { readonly logger?: Logger };
export type PhysicalActionCall = WorldCall & { readonly kind: PhysicalActionKind };
export type BehaviourCall = WorldCall & { readonly change: BehaviourRequest };

export interface NetworkClient {
  /** `GET /v1/onus/{serial}`: the ONU's status in the caller's world. Reading changes nothing. */
  getOnuStatus(call: WorldCall): Promise<NetworkOutcome<OnuStatus>>;
  /** The installer acted on the installation, or the supervisor's fix was carried out (world event). */
  reportPhysicalAction(call: PhysicalActionCall): Promise<NetworkOutcome<OnuControlState>>;
  /** Demo control of the console and `network.setBehaviour` of the `QaDriver`. */
  setBehaviour(call: BehaviourCall): Promise<NetworkOutcome<OnuControlState>>;
  /** `GET /v1/health`, for the smoke's probe of the mocks. */
  health(logger?: Logger): Promise<NetworkOutcome<unknown>>;
}

export interface NetworkClientDeps {
  readonly transport: HttpTransport;
  readonly faults: NetworkFaultReader;
  readonly logger?: Logger;
  readonly timeoutMs?: number;
  readonly retries?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  /** Real time, only to read a `Retry-After` given as an HTTP date. */
  readonly now?: () => Date;
}

class CallFailure extends Error {
  override readonly name = "NetworkCallFailure";
  constructor(
    readonly reason: UnavailableReason,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(reason);
  }
}

function headerOf(response: HttpResponse, name: string): string | undefined {
  const wanted = name.toLowerCase();
  return Object.entries(response.headers).find(([key]) => key.toLowerCase() === wanted)?.[1];
}

/** `Retry-After` as delay-seconds or HTTP-date (RFC 9110 §10.2.3), capped at `MAX_RETRY_AFTER_MS`. */
export function retryAfterMs(value: string | undefined, nowMs: number): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const trimmed = value.trim();
  const ms = /^\d+$/.test(trimmed) ? Number(trimmed) * 1000 : Date.parse(trimmed) - nowMs;
  return Number.isNaN(ms) ? undefined : Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
}

/** A response worth reading (2xx or 404) or the failure it means; 5xx, 409, 429 and timeouts retry. */
function classify(response: HttpResponse, nowMs: number): HttpResponse {
  const { status } = response;
  if ((status >= 200 && status < 300) || status === 404) return response;
  const wait = retryAfterMs(headerOf(response, RETRY_AFTER_HEADER), nowMs);
  if (status === 429) throw new CallFailure("THROTTLED", true, wait);
  if (status === 409) throw new CallFailure("CONFLICT", true, wait);
  if (status >= 500) throw new CallFailure("HTTP_5XX", true, wait);
  if (status === 401 || status === 403) throw new CallFailure("FORBIDDEN", false);
  throw new CallFailure("BAD_REQUEST", false);
}

function asFailure(error: unknown): CallFailure {
  if (error instanceof CallFailure) return error;
  if (error instanceof DeadlineError) return new CallFailure("TIMEOUT", true);
  return new CallFailure("NETWORK_ERROR", true);
}

function parseJson<T>(body: string, schema: z.ZodType<T>): T | undefined {
  try {
    const parsed = schema.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

const serialTail = (serial: string) => serial.slice(-4);

export function createNetworkClient(deps: NetworkClientDeps): NetworkClient {
  const timeoutMs = deps.timeoutMs ?? NETWORK_TIMEOUT_MS;
  const attempts = 1 + (deps.retries ?? NETWORK_RETRIES);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => new Date());
  const baseLogger = deps.logger ?? createLogger({ bindings: { component: "network-client" } });

  async function exchange<T>(operation: string, request: HttpRequest, schema: z.ZodType<T>, log: Logger): Promise<NetworkOutcome<T>> {
    let tries = 0;
    let wait: number | undefined;
    try {
      const response = await withRetry(
        async (attempt) => {
          tries = attempt + 1;
          try {
            const answer = await withDeadline(`network.${operation}`, timeoutMs, (signal) => deps.transport(request, signal));
            return classify(answer, now().getTime());
          } catch (error) {
            throw asFailure(error);
          }
        },
        {
          attempts,
          baseDelayMs: 200,
          maxDelayMs: 1_000,
          ...(deps.random === undefined ? {} : { random: deps.random }),
          // The delay of the next attempt is the orchestrator's Retry-After when it sent one.
          shouldRetry: (error) => {
            if (!(error instanceof CallFailure) || !error.retryable) return false;
            wait = error.retryAfterMs;
            return true;
          },
          sleep: (backoffMs) => sleep(wait ?? backoffMs),
        },
      );
      if (response.status === 404) return { kind: "NOT_FOUND", attempts: tries };
      const value = parseJson(response.body, schema);
      if (value !== undefined) return { kind: "OK", value, attempts: tries };
      log.error("network orchestrator answered outside the contract", { operation, status: response.status });
      return { kind: "UNAVAILABLE", reason: "INVALID_RESPONSE", attempts: tries };
    } catch (error) {
      const failure = asFailure(error);
      log.warn("network orchestrator unavailable", { operation, reason: failure.reason, attempts: tries });
      return { kind: "UNAVAILABLE", reason: failure.reason, attempts: tries };
    }
  }

  function baseHeaders(log: Logger): Record<string, string> {
    return { accept: "application/json", [MOCK_HEADERS.correlation]: log.correlationId };
  }

  function worldHeaders(call: z.infer<typeof WorldCall>, log: Logger): Record<string, string> {
    return { ...baseHeaders(log), [WORLD_HEADER]: call.clockId, [MOCK_HEADERS.caller]: call.caller, [MOCK_HEADERS.worldTime]: call.atSim };
  }

  // Faults exist only in qa-* worlds; a failed read of them never fails the call itself.
  async function faultHeaders(clockId: string, log: Logger): Promise<Record<string, string>> {
    if (!mayHaveFaults(clockId)) return {};
    try {
      const fault = await deps.faults.networkFault(clockId);
      return fault === undefined ? {} : { [MOCK_HEADERS.fault]: fault };
    } catch (error) {
      log.warn("could not read the faults of the world", { clockId, error });
      return {};
    }
  }

  /** The call checked against the contract, and a logger bound to its world and serial tail. */
  function scoped(call: WorldCall) {
    const world = WorldCall.parse(call);
    return { world, log: (call.logger ?? baseLogger).child({ clockId: world.clockId, serialTail: serialTail(world.serial) }) };
  }

  async function control(route: "physicalAction" | "behaviour", call: WorldCall, body: unknown): Promise<NetworkOutcome<OnuControlState>> {
    const { world, log } = scoped(call);
    const path = onuPath(world.serial, CONTROL_ROUTES[route].suffix);
    const request: HttpRequest = { method: CONTROL_ROUTES[route].method, path, headers: worldHeaders(world, log), body: JSON.stringify(body) };
    return exchange(route, request, OnuControlState, log);
  }

  return {
    async getOnuStatus(call) {
      const { world, log } = scoped(call);
      const headers = { ...worldHeaders(world, log), ...(await faultHeaders(world.clockId, log)) };
      const { getOnu } = CLIENT_CONTRACT.operations;
      return exchange(getOnu.operationId, { method: getOnu.method, path: onuPath(world.serial), headers }, CLIENT_CONTRACT.onuStatus, log);
    },
    reportPhysicalAction: async (call) => control("physicalAction", call, { kind: PhysicalActionKind.parse(call.kind) }),
    setBehaviour: async (call) => control("behaviour", call, BehaviourRequest.parse(call.change)),
    async health(logger) {
      const { health } = CLIENT_CONTRACT.operations;
      const log = logger ?? baseLogger;
      return exchange(health.operationId, { method: health.method, path: health.path, headers: baseHeaders(log) }, z.unknown(), log);
    },
  };
}

const LinkedFunctionUrl = z.object({ url: z.url() });

/** SigV4 transport to the `NetworkMock` Function URL linked to this Lambda, resolved on first use. */
function linkedTransport(): HttpTransport {
  let transport: HttpTransport | undefined;
  return (request, signal) => {
    if (transport === undefined) {
      try {
        transport = sigv4Transport({ baseUrl: readLinked("NetworkMock", LinkedFunctionUrl).url });
      } catch {
        return Promise.reject(new CallFailure("NOT_CONFIGURED", false));
      }
    }
    return transport(request, signal);
  };
}

let shared: NetworkClient | undefined;

/** The client of a deployed Lambda: linked `NetworkMock` URL, role credentials, faults from `Runtime`. */
export function networkClient(): NetworkClient {
  shared ??= createNetworkClient({ transport: linkedTransport(), faults: runtimeFaultReader() });
  return shared;
}
