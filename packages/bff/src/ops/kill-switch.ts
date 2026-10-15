// The runtime kill switch (ADR-0019): stops spending without a deploy. It is data in `Runtime`:
//
//   KILL#ALL             the agent, the simulator, every console write and the own sign-up
//   KILL#SIMULATOR       the phone simulator stops accepting messages
//   KILL#AGENT           no Harness turn, transcription or photo validation in any world
//   KILL#AGENT#<clockId> the same for one world (the only one the QaDriver may write, `qa-*` only)
//   KILL#SIGNUP          the own sign-up (ADR-0025 §4): `signup.start` and the pre sign-up answer
//                        CAP_REACHED and no sign-up code nor resend is sent; sign-in, recovery and the
//                        worlds that exist go on
//
// The BFF, the worker, `InboundWhatsApp`, `createToolHandler` and the sign-up triggers read it
// through a reader that caches each item for at most 30 seconds. Physical safety is never cut: the classifier, the fixed
// §SEG-01 instruction and the alerts use no model and never ask this module (`report_safety_hazard`
// is exempt from the tool gate). The operator (`npm run ops:kill`) turns it on and off (no alarm nor
// budget turns it on: P-07, closed by the CTO on 2026-10-14); the QaDriver only the switch of a `qa-*`
// world. Cedar's `CED-KILL-SWITCH` is the second layer and needs a deploy.
import { z } from "zod";
import { ClockId, IsoInstant, KillScope, type ToolFailure, ToolError, fail, ispKindOfClock } from "@cuadrilla/shared";
import { type Clock, systemClock } from "../lib/clock";
import type { Logger } from "../lib/log";

/** The longest a reader trusts a cached item (ADR-0019, docs/design-brief.md §5.6 `LAM-KILL`). */
export const KILL_CACHE_TTL_MS = 30_000;
/** How long a reader keeps answering from expired items when `Runtime` cannot be read. */
export const KILL_STALE_IF_ERROR_MS = 5 * 60_000;
/** TTL of the switch of a QA or evaluation world (docs/architecture.md §5); the others never expire. */
export const WORLD_KILL_TTL_SECONDS = 48 * 3_600;

export const KillState = z.enum(["on", "off"]);
export type KillState = z.infer<typeof KillState>;

/** Who may flip it: the operator's script and the scenario runner. */
export const KillActor = z.enum(["OPERATOR", "QA"]);
export type KillActor = z.infer<typeof KillActor>;

export const KillSwitchRecord = z
  .object({
    scope: KillScope,
    /** Only with scope AGENT: the switch of one world. */
    clockId: ClockId.optional(),
    state: KillState,
    setBy: KillActor,
    setAtReal: IsoInstant,
    reason: z.string().trim().min(1).max(200).optional(),
  })
  .superRefine((record, ctx) => {
    if (record.clockId !== undefined && record.scope !== "AGENT") ctx.addIssue({ code: "custom", path: ["clockId"], message: "only the AGENT switch exists per world" });
  });
export type KillSwitchRecord = z.infer<typeof KillSwitchRecord>;

/** Partition key of a switch (sort key `META`). */
export function killSwitchKey(scope: KillScope, clockId?: string): string {
  if (clockId === undefined) return `KILL#${KillScope.parse(scope)}`;
  if (scope !== "AGENT") throw new RangeError("only the AGENT switch exists per world");
  return `KILL#AGENT#${ClockId.parse(clockId)}`;
}

/** `Runtime` access of the switch; adapters in ops/dynamo-runtime-store.ts and ops/memory-runtime-store.ts. */
export interface KillSwitchStore {
  /** The stored items by key; a key without an item is absent from the map. */
  read(keys: readonly string[]): Promise<ReadonlyMap<string, unknown>>;
  /** Writes the whole item (a `PutItem`), with its TTL if any. */
  write(key: string, record: KillSwitchRecord, expiresAt?: number): Promise<void>;
}

/** What the switch blocks. The console is only blocked by `KILL#ALL` (it goes read-only). */
export type KillSurface = "AGENT" | "SIMULATOR" | "CONSOLE" | "SIGNUP";

export interface KillStatus {
  readonly all: boolean;
  readonly simulator: boolean;
  readonly agent: boolean;
  /** `KILL#SIGNUP`; the reader always answers it, a status built by hand may leave it out (off). */
  readonly signup?: boolean;
  /** The AGENT switch of the world asked about, when a world was named. */
  readonly world?: { readonly clockId: string; readonly agent: boolean };
}

/** The scope that blocks `surface`, or `undefined` when nothing does. `ALL` wins over the others. */
export function blockingScope(status: KillStatus, surface: KillSurface): KillScope | undefined {
  if (status.all) return "ALL";
  if (surface === "SIMULATOR" && status.simulator) return "SIMULATOR";
  if (surface === "AGENT" && (status.agent || status.world?.agent === true)) return "AGENT";
  if (surface === "SIGNUP" && status.signup === true) return "SIGNUP";
  return undefined;
}

export function isBlocked(status: KillStatus, surface: KillSurface): boolean {
  return blockingScope(status, surface) !== undefined;
}

export interface KillSwitchReader {
  /** The global switches and, with `clockId`, the one of that world; at most 30 s old. */
  status(clockId?: string): Promise<KillStatus>;
  /** Forgets the cache (a write from this container is seen at once). */
  invalidate(): void;
}

export interface KillSwitchReaderDeps {
  readonly store: KillSwitchStore;
  /** Real time: the cache age is real, never a world's simulated time. */
  readonly realClock?: Clock;
  readonly ttlMs?: number;
  readonly logger?: Logger;
}

interface Cached {
  readonly on: boolean;
  readonly fetchedAtMs: number;
}

// An item counts as on when its `state` says "on", even if another field is malformed: the switch
// fails closed on the one field that matters, and the reader logs the item it could not parse.
function isOn(raw: unknown): boolean {
  return typeof raw === "object" && raw !== null && Reflect.get(raw, "state") === "on";
}

export function createKillSwitchReader(deps: KillSwitchReaderDeps): KillSwitchReader {
  const ttlMs = deps.ttlMs ?? KILL_CACHE_TTL_MS;
  if (!Number.isInteger(ttlMs) || ttlMs < 0 || ttlMs > KILL_CACHE_TTL_MS) throw new RangeError(`the kill switch cache lives 0 to ${KILL_CACHE_TTL_MS} ms, got ${ttlMs}`);
  const realClock = deps.realClock ?? systemClock;
  const cache = new Map<string, Cached>();

  async function load(keys: readonly string[], nowMs: number): Promise<void> {
    const stale = keys.filter((key) => {
      const hit = cache.get(key);
      return hit === undefined || nowMs - hit.fetchedAtMs >= ttlMs;
    });
    if (stale.length === 0) return;
    let items: ReadonlyMap<string, unknown>;
    try {
      items = await deps.store.read(stale);
    } catch (error) {
      const usable = stale.every((key) => {
        const hit = cache.get(key);
        return hit !== undefined && nowMs - hit.fetchedAtMs < KILL_STALE_IF_ERROR_MS;
      });
      if (!usable) throw error;
      deps.logger?.warn("kill switch read failed; answering from the cache", { error, staleItems: stale.length });
      return;
    }
    for (const key of stale) {
      const raw = items.get(key);
      if (raw !== undefined && !KillSwitchRecord.safeParse(raw).success) deps.logger?.warn("kill switch item does not match its schema", { item: key, on: isOn(raw) });
      cache.set(key, { on: isOn(raw), fetchedAtMs: nowMs });
    }
  }

  return {
    async status(clockId) {
      const worldKey = clockId === undefined ? undefined : killSwitchKey("AGENT", clockId);
      const keys = [killSwitchKey("ALL"), killSwitchKey("SIMULATOR"), killSwitchKey("AGENT"), killSwitchKey("SIGNUP"), ...(worldKey === undefined ? [] : [worldKey])];
      await load(keys, (await realClock.now()).getTime());
      const on = (key: string): boolean => cache.get(key)?.on === true;
      const status: KillStatus = { all: on("KILL#ALL"), simulator: on("KILL#SIMULATOR"), agent: on("KILL#AGENT"), signup: on("KILL#SIGNUP") };
      return worldKey === undefined || clockId === undefined ? status : { ...status, world: { clockId, agent: on(worldKey) } };
    },
    invalidate: () => cache.clear(),
  };
}

export interface SetKillSwitchRequest {
  readonly scope: KillScope;
  readonly clockId?: string;
  readonly on: boolean;
  readonly actor: KillActor;
  readonly reason?: string;
}

/** `KILL_SWITCH_SET` (docs/tool-catalog.md, `set_kill_switch`); the caller's adapter writes `AuditLog`. */
export interface KillSwitchAuditEvent {
  readonly action: "KILL_SWITCH_SET";
  readonly record: KillSwitchRecord;
}

export interface SetKillSwitchDeps {
  readonly store: KillSwitchStore;
  readonly realClock?: Clock;
  readonly audit?: (event: KillSwitchAuditEvent) => Promise<void>;
  /** The reader of this container, so its own write is seen without waiting for the cache. */
  readonly reader?: KillSwitchReader;
  readonly logger?: Logger;
}

function forbidden(message: string): ToolError {
  return new ToolError("FORBIDDEN", message);
}

function checkActor(request: SetKillSwitchRequest): void {
  if (request.clockId !== undefined && request.scope !== "AGENT") throw forbidden("only the AGENT switch exists per world");
  if (request.actor === "QA" && (request.clockId === undefined || ispKindOfClock(request.clockId) !== "QA")) {
    throw forbidden("the QaDriver may only flip the AGENT switch of a qa-* world");
  }
}

/** `set_kill_switch`: validates the actor, writes the item and audits it. */
export async function setKillSwitch(deps: SetKillSwitchDeps, request: SetKillSwitchRequest): Promise<KillSwitchRecord> {
  checkActor(request);
  const now = await (deps.realClock ?? systemClock).now();
  const record = KillSwitchRecord.parse({
    scope: request.scope,
    ...(request.clockId === undefined ? {} : { clockId: request.clockId }),
    state: request.on ? "on" : "off",
    setBy: request.actor,
    setAtReal: now.toISOString(),
    ...(request.reason === undefined ? {} : { reason: request.reason }),
  });
  const kind = record.clockId === undefined ? undefined : ispKindOfClock(record.clockId);
  const expiresAt = kind === "QA" || kind === "EVAL" ? Math.floor(now.getTime() / 1000) + WORLD_KILL_TTL_SECONDS : undefined;
  await deps.store.write(killSwitchKey(record.scope, record.clockId), record, expiresAt);
  deps.reader?.invalidate();
  deps.logger?.warn("kill switch set", { action: "KILL_SWITCH_SET", metric: "KillSwitchActive", value: request.on ? 1 : 0, scope: record.scope, clockId: record.clockId, actor: record.setBy });
  await deps.audit?.({ action: "KILL_SWITCH_SET", record });
  return record;
}

/** Fixed notice of copy/es-MX.ts the worker sends instead of a turn while the agent is cut. */
export const SERVICE_PAUSED_NOTICE = "servicePaused";

/** The one tool that keeps working while the agent is cut: physical safety (`LAM-KILL`). */
export const KILL_EXEMPT_TOOLS: ReadonlySet<string> = new Set(["report_safety_hazard"]);

/** `LAM-KILL` for `createToolHandler`: `UNAVAILABLE` without effects while the agent is cut, safety excepted. */
export function toolKillGate(status: KillStatus, toolName: string): ToolFailure | undefined {
  if (KILL_EXEMPT_TOOLS.has(toolName) || !isBlocked(status, "AGENT")) return undefined;
  return fail("UNAVAILABLE", "the service is paused", "KILL_SWITCH_ACTIVE");
}

export type AgentKillDecision = { readonly proceed: true } | { readonly proceed: false; readonly notice: typeof SERVICE_PAUSED_NOTICE; readonly scope: KillScope };

/**
 * What the worker does with an `AGENT_TURN`, a voice note or a validation while the agent is cut:
 * the fixed `servicePaused` notice, never the Harness, Transcribe or the validator. The safety
 * classifier runs before this decision and is never gated by it.
 */
export function agentKillDecision(status: KillStatus): AgentKillDecision {
  const scope = blockingScope(status, "AGENT");
  return scope === undefined ? { proceed: true } : { proceed: false, notice: SERVICE_PAUSED_NOTICE, scope };
}
