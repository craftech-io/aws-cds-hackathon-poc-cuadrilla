// What a step (or part) runs with (docs/test-plan.md §4.3 and §4.4): the `QaDriver` as its only way into
// the stage, the scenario's shared state, waits that record their latency without asserting it, and the
// rules of the report:
//
//   - every call carries `<runId>/<scenario>/<unit>/<label>`; changing calls are labelled `m1`, `m2`… in
//     order and reads `r1`, `r2`…, so a unit re-run under the same run id replays its effects;
//   - a negative (`none`) or an exact count (`exactly`) is asserted only on a snapshot taken by `settled()`
//     after the last changing call of the unit: anything else is a bug of the scenario (§4.3 "Quiescencia");
//   - what the model decided and the test only reports (a reason code, where a block came from, a
//     latency) goes to `inform`, `blocked` and `latency`, never to an assert of a `det` unit.
import { READ_ONLY_ACTIONS, type QaActionName, type QaResponse, idempotencyKeyOf } from "../../../packages/bff/src/qa-driver/contract";
import type { QaInput } from "../../../packages/bff/src/qa-driver/contract-inputs";
import type { QaSnapshot } from "../../../packages/bff/src/qa-driver/snapshot";
import type { DriverClient } from "./driver-client";
import { WAITS, eventually } from "./eventually";
import type { ScenarioDef } from "./steps";

export type BlockOrigin = "PREFILTER" | "HARNESS_G1" | "CEDAR" | "LAMBDA_FENCE" | "OUTBOUND_VERIFY" | "VAL_CHECK" | "MODEL_REFUSAL" | "POLICY" | "NONE";

export class DriverRefusal extends Error {
  override readonly name = "DriverRefusal";
  constructor(
    readonly action: QaActionName,
    readonly code: string,
    readonly reason: string | undefined,
    message: string,
  ) {
    super(`${action}: ${code}${reason === undefined ? "" : `/${reason}`} ${message}`);
  }
}

/** A step of the scenario asked something §4.3 forbids (a negative without settling, a bad input). */
export class ScenarioBug extends Error {
  override readonly name = "ScenarioBug";
}

/** What the unit needs is not available in this run (a link, an input of the runner): BLOCKED, never a pass. */
export class Blocked extends Error {
  override readonly name = "Blocked";
}

export class AssertionFailed extends Error {
  override readonly name = "AssertionFailed";
}

/** An assertion that also narrows the type. */
export function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AssertionFailed(message);
}

export interface UnitRecord {
  readonly informed: Record<string, string>;
  readonly latencies: Record<string, number>;
  readonly blocks: Array<{ readonly origin: BlockOrigin; readonly detail: string }>;
  readonly warnings: string[];
}

export interface SnapshotRequest {
  readonly clockId: string;
  readonly workOrderIds?: readonly string[];
  readonly personIds?: readonly string[];
  readonly caseIds?: readonly string[];
  readonly audit?: boolean;
}

export type SettleTarget = { readonly installerId: string } | { readonly clockId: string };

export interface ScenarioContext {
  readonly runId: string;
  readonly scenario: ScenarioDef;
  /** `4`, `4.b`, or `999` for the cleanup. */
  readonly unit: string;
  /** Values steps pass to later steps (the world, ids, baselines). */
  readonly state: Record<string, unknown>;
  /** The policy audits of the scenarios that ran before (`SC-16/2` adds them up). */
  readonly previous: ReadonlyArray<{ readonly scenario: string; readonly violations: number; readonly unaudited: number }>;
  qa<A extends QaActionName>(action: A, input: QaInput<A>): Promise<any>;
  /** The driver's answer as it is, for an expected refusal. */
  attempt<A extends QaActionName>(action: A, input: QaInput<A>): Promise<QaResponse<any>>;
  snapshot(request: SnapshotRequest): Promise<QaSnapshot>;
  /** `installer.settle` or `world.settle`, then a snapshot: the only one negatives and exact counts accept. */
  settled(target: SettleTarget, request: SnapshotRequest, timeoutSec?: number): Promise<QaSnapshot>;
  eventually<T>(what: string, probe: () => Promise<T | undefined | false>, timeoutSec: number, everySec?: number): Promise<T>;
  check(condition: unknown, message: string): void;
  none<T>(snapshot: QaSnapshot, what: string, items: readonly T[]): void;
  exactly<T>(snapshot: QaSnapshot, count: number, what: string, items: readonly T[]): T[];
  /** What the model decided and the step only reports (a reason code, an alternative of the oracle). */
  inform(name: string, value: string): void;
  latency(name: string, ms: number): void;
  /**
   * A fixed real wait, only where no quiescence tracks what must pass (the 30 s cache of the kill switch in
   * the other Lambdas): never as a way to wait for a turn or an email.
   */
  pause(seconds: number): Promise<void>;
  blocked(origin: BlockOrigin, detail: string): void;
  warn(message: string): void;
  /** Real time in ms. */
  now(): number;
}

export interface ContextOptions {
  readonly runId: string;
  readonly scenario: ScenarioDef;
  readonly driver: DriverClient;
  readonly state: Record<string, unknown>;
  readonly previous?: ScenarioContext["previous"];
  readonly waitOptions?: { readonly now?: () => number; readonly sleep?: (ms: number) => Promise<void> };
}

export function emptyRecord(): UnitRecord {
  return { informed: {}, latencies: {}, blocks: [], warnings: [] };
}

/** Context of one unit; `record` collects what the report shows for it. */
export function unitContext(options: ContextOptions, unit: string, record: UnitRecord): ScenarioContext {
  let changes = 0;
  let reads = 0;
  const settledAt = new WeakMap<object, number>();
  const now = options.waitOptions?.now ?? Date.now;

  async function call<A extends QaActionName>(action: A, input: QaInput<A>): Promise<QaResponse> {
    const procedure = action === "console" ? String((input as { procedure?: string }).procedure ?? "") : "";
    const reading = READ_ONLY_ACTIONS.has(action) || (action === "console" && /\.(?:get|list|timeline|summary|violations|decisionsByRule|export|identities|thread|steps|session|world|queue|section|sections|catalog|quickMessages|kit|onuStatus|mediaUrl|certificateUrl)$/.test(procedure));
    const label = reading ? `r${++reads}` : `m${++changes}`;
    return options.driver.call(action, input, idempotencyKeyOf({ runId: options.runId, scenario: options.scenario.slug, step: unit, label }));
  }

  function requireSettled(snapshot: QaSnapshot, what: string): void {
    const at = settledAt.get(snapshot);
    if (at === undefined || at !== changes) throw new ScenarioBug(`"${what}" is a negative or an exact count: assert it on a snapshot from settled() taken after the last change`);
  }

  const ctx: ScenarioContext = {
    runId: options.runId,
    scenario: options.scenario,
    unit,
    state: options.state,
    previous: options.previous ?? [],
    async qa(action, input) {
      const answer = await call(action, input);
      if (!answer.ok) throw new DriverRefusal(action, answer.error.code, answer.error.reason, answer.error.message);
      return answer.result;
    },
    attempt: call,
    snapshot: (request) => ctx.qa("snapshot", { ...request, workOrderIds: [...(request.workOrderIds ?? [])], personIds: [...(request.personIds ?? [])], caseIds: [...(request.caseIds ?? [])] }) as Promise<QaSnapshot>,
    async settled(target, request, timeoutSec = WAITS.settleSec) {
      const started = now();
      if ("installerId" in target) await ctx.qa("installer.settle", { installerId: target.installerId, timeoutSec });
      else await ctx.qa("world.settle", { clockId: target.clockId, timeoutSec });
      record.latencies.settleMs = now() - started;
      const snapshot = await ctx.snapshot(request);
      settledAt.set(snapshot, changes);
      return snapshot;
    },
    eventually(what, probe, timeoutSec, everySec) {
      const started = now();
      return eventually(what, probe, { timeoutSec, ...(everySec === undefined ? {} : { everySec }), ...options.waitOptions }).then((value) => {
        record.latencies[what] = now() - started;
        return value;
      });
    },
    check(condition, message) {
      ensure(condition, message);
    },
    none(snapshot, what, items) {
      requireSettled(snapshot, what);
      if (items.length > 0) throw new AssertionFailed(`expected no ${what}, found ${items.length}`);
    },
    exactly(snapshot, count, what, items) {
      requireSettled(snapshot, what);
      if (items.length !== count) throw new AssertionFailed(`expected exactly ${count} ${what}, found ${items.length}`);
      return [...items];
    },
    inform(name, value) {
      record.informed[name] = value;
    },
    latency(name, ms) {
      record.latencies[name] = ms;
    },
    pause(seconds) {
      const sleep = options.waitOptions?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
      return sleep(seconds * 1_000);
    },
    blocked(origin, detail) {
      record.blocks.push({ origin, detail });
    },
    warn(message) {
      record.warnings.push(message);
    },
    now,
  };
  return ctx;
}
