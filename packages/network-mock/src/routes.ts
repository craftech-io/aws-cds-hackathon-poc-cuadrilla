// Requests of the mock, independent of Lambda (handler.ts adapts the Function URL event): the
// contract's `GET /v1/onus/{serial}` and `GET /v1/health`, and the control routes of world events.
// The request and response shapes are the ones the BFF client's transport uses, so a local flow can
// plug the client straight into `handleNetworkRequest`.
import {
  BehaviourRequest,
  CONTROL_ROUTES,
  MOCK_HEADERS,
  NetworkReader,
  OnuControlState,
  PhysicalActionRequest,
  RETRY_AFTER_HEADER,
  WORLD_HEADER,
  WorldTime,
  type ControlRouteName,
} from "@cuadrilla/network-contract";
import { ClockId } from "@cuadrilla/shared";
import type { z } from "zod";
import { behaviourControlPatch, physicalActionPatch, resolveOnuStatus, withPatch, type OnuStatePatch } from "./behaviours";
import { MOCK_CONTRACT } from "./contract";
import { FAULT_LATENCY_MS, FAULT_RETRY_AFTER_SECONDS, FAULT_TIMEOUT_MS, requestedFault } from "./faults";
import { onuKey, type OnuKey, type OnuRow } from "./rows";
import type { OnuStore } from "./store";

export interface MockRequest {
  readonly method: string;
  /** Path without query string, e.g. `/v1/onus/DEMO3F2C19A0`. */
  readonly path: string;
  /** Header names in any case. */
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body?: string;
}

export interface MockResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface MockDeps {
  readonly store: OnuStore;
  /** Real time, only for record metadata and for a read that does not say the world's time. */
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
}

/** Attempts of a control event against concurrent writes before answering 409. */
const CONTROL_ATTEMPTS = 3;
const JSON_HEADERS = { "content-type": "application/json" } as const;

const reply = (status: number, body: unknown, headers: Record<string, string> = {}): MockResponse => ({
  status,
  headers: { ...JSON_HEADERS, ...headers },
  body: JSON.stringify(body),
});
const problem = (status: number, error: string, headers?: Record<string, string>) => reply(status, { error }, headers);

function header(request: MockRequest, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(request.headers)) if (key.toLowerCase() === wanted) return value;
  return undefined;
}

interface Target {
  readonly clockId: string;
  readonly serial: string;
  readonly key: OnuKey;
  readonly reader: NetworkReader | undefined;
  readonly worldTime: string | undefined;
}

/** World, serial, reader and world time of a request, or the 400 that explains what is wrong. */
function target(request: MockRequest, rawSerial: string): Target | MockResponse {
  const world = ClockId.safeParse(header(request, WORLD_HEADER));
  if (!world.success) return problem(400, `missing or invalid ${WORLD_HEADER}`);
  const serial = MOCK_CONTRACT.serial.safeParse(rawSerial);
  if (!serial.success) return problem(400, "invalid serial");
  const rawReader = header(request, MOCK_HEADERS.caller);
  const reader = rawReader === undefined ? undefined : NetworkReader.safeParse(rawReader);
  if (reader !== undefined && !reader.success) return problem(400, `invalid ${MOCK_HEADERS.caller}`);
  const rawTime = header(request, MOCK_HEADERS.worldTime);
  const worldTime = rawTime === undefined ? undefined : WorldTime.safeParse(rawTime);
  if (worldTime !== undefined && !worldTime.success) return problem(400, `invalid ${MOCK_HEADERS.worldTime}`);
  return {
    clockId: world.data,
    serial: serial.data,
    key: onuKey(world.data, serial.data),
    reader: reader?.data,
    worldTime: worldTime?.data,
  };
}

async function readOnu(request: MockRequest, at: Target, deps: MockDeps): Promise<MockResponse> {
  const fault = requestedFault(at.clockId, header(request, MOCK_HEADERS.fault));
  if (fault.kind === "invalid") return problem(400, `invalid ${MOCK_HEADERS.fault}`);
  if (fault.kind === "fault") {
    if (fault.fault === "LATENCY") {
      await deps.sleep(FAULT_LATENCY_MS);
    } else {
      await deps.store.countFault(at.key);
      // A timed-out attempt is abandoned by the client before this answer; it stays in the contract.
      if (fault.fault === "TIMEOUT") await deps.sleep(FAULT_TIMEOUT_MS);
      return problem(503, "temporarily unavailable", { [RETRY_AFTER_HEADER.toLowerCase()]: String(FAULT_RETRY_AFTER_SECONDS) });
    }
  }
  const row = await deps.store.countRead(at.key, at.reader);
  const status = row === undefined ? undefined : resolveOnuStatus(row, at.worldTime ?? deps.now().toISOString());
  return status === undefined ? problem(404, "unknown serial") : reply(200, MOCK_CONTRACT.onuStatus.parse(status));
}

function parseBody<T>(body: string | undefined, schema: z.ZodType<T>): T | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body ?? "");
  } catch {
    return undefined;
  }
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function controlAnswer(row: OnuRow, changed: boolean, observedAt: string): MockResponse {
  const status = resolveOnuStatus(row, observedAt);
  return reply(
    200,
    OnuControlState.parse({
      serial: row.serial,
      behaviour: row.behaviour,
      fixed: row.fixed,
      fixedBy: row.fixedBy,
      fixedAtSim: row.fixedAtSim,
      changed,
      status,
    }),
  );
}

async function applyEvent(route: ControlRouteName, request: MockRequest, at: Target, deps: MockDeps): Promise<MockResponse> {
  const allowed: readonly NetworkReader[] = CONTROL_ROUTES[route].callers;
  if (at.reader === undefined || !allowed.includes(at.reader)) return problem(403, `${MOCK_HEADERS.caller} may not send this event`);
  if (at.worldTime === undefined) return problem(400, `${MOCK_HEADERS.worldTime} is required for a world event`);
  const atSim = at.worldTime;
  let decide: (row: OnuRow) => OnuStatePatch | undefined;
  if (route === "physicalAction") {
    const body = parseBody(request.body, PhysicalActionRequest);
    if (body === undefined) return problem(400, "invalid physical action");
    decide = (row) => physicalActionPatch(row, body.kind, atSim);
  } else {
    const body = parseBody(request.body, BehaviourRequest);
    if (body === undefined) return problem(400, "invalid behaviour");
    decide = (row) => behaviourControlPatch(row, body, atSim);
  }
  for (let attempt = 0; attempt < CONTROL_ATTEMPTS; attempt += 1) {
    const row = await deps.store.get(at.key);
    if (row === undefined) return problem(404, "unknown serial");
    const patch = decide(row);
    if (patch === undefined) return controlAnswer(row, false, atSim);
    if (await deps.store.replace(at.key, row.version, patch, deps.now().toISOString())) return controlAnswer(withPatch(row, patch), true, atSim);
  }
  return problem(409, "the ONU changed while the event was applied, try again");
}

const HEALTH = /^\/v1\/health$/;
const ONU = /^\/v1\/onus\/([^/]+)$/;
const CONTROL = /^\/v1\/onus\/([^/]+)(\/physical-action|\/behaviour)$/;

function controlRouteOf(suffix: string): ControlRouteName | undefined {
  return (Object.keys(CONTROL_ROUTES) as ControlRouteName[]).find((name) => CONTROL_ROUTES[name].suffix === suffix);
}

export async function handleNetworkRequest(request: MockRequest, deps: MockDeps): Promise<MockResponse> {
  const method = request.method.toUpperCase();
  if (HEALTH.test(request.path)) return method === "GET" ? reply(200, { status: "ok" }) : problem(405, "method not allowed");
  const onu = ONU.exec(request.path);
  if (onu !== null) {
    if (method !== "GET") return problem(405, "method not allowed");
    const at = target(request, onu[1] ?? "");
    return "status" in at ? at : readOnu(request, at, deps);
  }
  const control = CONTROL.exec(request.path);
  const route = control === null ? undefined : controlRouteOf(control[2] ?? "");
  if (control === null || route === undefined) return problem(404, "not found");
  if (method !== CONTROL_ROUTES[route].method) return problem(405, "method not allowed");
  const at = target(request, control[1] ?? "");
  return "status" in at ? at : applyEvent(route, request, at, deps);
}
