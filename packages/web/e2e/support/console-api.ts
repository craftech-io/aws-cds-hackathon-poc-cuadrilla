// The procedures the shell reads, answered on `/api/*` in the tRPC batch protocol, for the specs that
// run on Vite alone (login.spec.ts, wave 1): `brand.get`, `clock.get` and the bar's clock controls, and
// `guest.world` (a world READY) for the guest's portada, where every guest lands after signing in.
// The spec sets what they answer (and can refuse the next call of a procedure) and reads every call.
// The specs of the views run against the real router in tests/ui-server/ instead.
import type { Page, Route } from "@playwright/test";

export interface Refusal {
  /** tRPC code: `PRECONDITION_FAILED`, `SERVICE_UNAVAILABLE`, … */
  readonly code: string;
  readonly httpStatus: number;
  readonly reason?: string;
}

export interface ConsoleApiState {
  /** Answer of `brand.get`; undefined makes the procedure fail and the web fall back to neutral. */
  brand: unknown;
  clock: SimClock;
  /** The next call of each path is refused with this. */
  readonly refusals: Map<string, Refusal>;
}

export interface SimClock {
  mode: "PAUSED" | "RUNNING";
  simNow: string;
  busy: boolean;
  pending: Array<{ kind: string; sinceReal: string; detail?: string }>;
  next: Array<{ kind: string; dueAtSim: string; reason?: string }>;
}

export interface ApiCall {
  readonly path: string;
  readonly input: unknown;
}

export interface ConsoleApiMock {
  readonly state: ConsoleApiState;
  readonly calls: ApiCall[];
}

/** The world of the story at 07:00 of Tuesday 13/10, paused, with the start of the day pending. */
export function quietClock(): SimClock {
  return { mode: "PAUSED", simNow: "2026-10-13T07:00:00-06:00", busy: false, pending: [], next: [{ kind: "DAY_START", dueAtSim: "2026-10-13T07:30:00-06:00" }] };
}

/** What `guest.world` answers for a guest whose world is built (packages/bff/src/guest/world-status.ts). */
export function readyWorld() {
  return {
    status: "READY",
    origin: "SIGNUP",
    canDeleteAccount: true,
    canRetry: false,
    refreshSession: false,
    createdAtReal: "2026-10-20T15:00:00.000Z",
    expiresAtReal: "2026-10-27T15:00:00.000Z",
    summary: { operatorName: "Operadora ficticia de prueba", installers: ["Rogelio Méndez"], supervisors: 4, workOrders: 13, simNow: "2026-10-13T07:00:00-06:00" },
  };
}

// The world's offset is fixed at -06:00 (America/Mexico_City has no daylight saving time).
const OFFSET_MS = 6 * 60 * 60_000;

function shiftSim(iso: string, minutes: number): string {
  const local = new Date(Date.parse(iso) + minutes * 60_000 - OFFSET_MS);
  return `${local.toISOString().slice(0, 19)}-06:00`;
}

function data(value: unknown) {
  return { result: { data: value } };
}

function refused(path: string, refusal: Refusal) {
  return { error: { message: refusal.reason ?? refusal.code, code: -32_600, data: { code: refusal.code, httpStatus: refusal.httpStatus, path, reason: refusal.reason ?? null, correlationId: "e2e-correlation" } } };
}

const MINUTES = (input: unknown): number => {
  const value = input !== null && typeof input === "object" ? (input as { minutes?: unknown }).minutes : undefined;
  return typeof value === "number" ? value : 0;
};

function answer(state: ConsoleApiState, path: string, input: unknown) {
  const refusal = state.refusals.get(path);
  if (refusal) {
    state.refusals.delete(path);
    return refused(path, refusal);
  }
  switch (path) {
    case "brand.get":
      return state.brand === undefined ? refused(path, { code: "NOT_FOUND", httpStatus: 404 }) : data(state.brand);
    case "clock.get":
      return data(state.clock);
    case "guest.world":
      return data(readyWorld());
    case "clock.advance":
      state.clock.simNow = shiftSim(state.clock.simNow, MINUTES(input));
      return data({ simNow: state.clock.simNow });
    case "clock.advanceToNext": {
      const [next, ...rest] = state.clock.next;
      if (next) state.clock = { ...state.clock, simNow: next.dueAtSim, next: rest };
      return data({ simNow: state.clock.simNow });
    }
    default:
      return refused(path, { code: "NOT_FOUND", httpStatus: 404 });
  }
}

function inputsOf(route: Route, url: URL): unknown {
  const raw = route.request().method() === "GET" ? url.searchParams.get("input") : route.request().postData();
  return raw ? (JSON.parse(raw) as unknown) : {};
}

async function handle(route: Route, mock: ConsoleApiMock): Promise<void> {
  const url = new URL(route.request().url());
  const paths = url.pathname.slice("/api/".length).split(",");
  const batch = url.searchParams.get("batch") === "1";
  const inputs = inputsOf(route, url) as Record<string, unknown>;
  const items = paths.map((path, index) => {
    const input = batch ? inputs[String(index)] : inputs;
    mock.calls.push({ path, input });
    return answer(mock.state, path, input);
  });
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(batch ? items : items[0]) });
}

/** Routes `/api/*` of the page to a mock whose state the spec changes as it goes. */
export async function routeConsoleApi(page: Page, initial: { readonly brand?: unknown; readonly clock?: SimClock } = {}): Promise<ConsoleApiMock> {
  const mock: ConsoleApiMock = { state: { brand: initial.brand, clock: initial.clock ?? quietClock(), refusals: new Map() }, calls: [] };
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => handle(route, mock));
  return mock;
}
