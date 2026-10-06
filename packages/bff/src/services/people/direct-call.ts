// What every deterministic handler of the console and the channel shares (docs/tool-catalog.md,
// "Handlers de invocación directa"): who may call it, the world it acts on, the world's simulated
// "now" and the audit row. The handlers of services/{consent,people,evidence-override,case-console,
// demo-controls} are invoked in process with an explicit `caller` (never by the Gateway, never by the
// model):
//
//   CHANNEL   InboundWhatsApp and the InstallerWorker for a keyword or a button (ALTA, BAJA, TURNO,
//             "Cliente conforme")
//   CONSOLE   the BFF's routers, with the principal's user, role, operator and world
//   QA        the QaDriver, only in `qa-*`, `eval-*` and `GUEST#isp-guest-test` (the `Caller` schema)
//
// `caller` does not authenticate: the BFF builds it from a verified token and the channel from a
// verified sender. What this module adds is the fence every handler needs: the kind of caller, the
// console role, and that every stored row it touches belongs to the caller's world. A row of another
// world reads as missing (`NOT_FOUND`), so a refusal never tells anything about another world.
// Refusals are `ToolError`s; the routers map them to HTTP (routers/errors.ts).
import type { z } from "zod";
import { Caller, type CallerKind, type ConsoleRole, ERROR_REASON, type ErrorCode, type IspKind, ToolError, ispKindOfClock } from "@cuadrilla/shared";
import { type ToolIdentity, actorOf } from "../../agent-tools/common/context";
import type { Connector, DecisionInput } from "../../connector/ports";
import type { Actor } from "../../domain/common";
import type { Decision } from "../../domain/audit";
import { type Clock, worldClock } from "../../lib/clock";
import type { Logger } from "../../lib/log";
import { MEXICO_CITY_TIME_ZONE, toZonedIso } from "../business-hours/zoned-time";

/** What every deterministic handler runs on. Business time is the world's (ADR-0010). */
export interface ServiceDeps {
  readonly connector: Connector;
  /** Real time: only to read a RUNNING world clock and to stamp ids. */
  readonly realClock: Clock;
  readonly logger?: Logger;
}

/** A caller bound to one world (every kind these handlers accept is). */
export type WorldCaller = Caller & { readonly ispId: string; readonly clockId: string };

export interface DirectCall {
  readonly caller: WorldCaller;
  readonly kind: CallerKind;
  readonly ispId: string;
  readonly clockId: string;
  readonly worldKind: IspKind;
  /** `USER:<id>` for the console, `CHANNEL` or `QA` otherwise (the audit's actor). */
  readonly actor: Actor;
}

export interface CallRule {
  readonly callers: readonly CallerKind[];
  /** Console roles that may call; absent → every console role. */
  readonly consoleRoles?: readonly ConsoleRole[];
}

/** Console roles that act (`supervisorProcedure`): `OPS` sees and never acts (CONTEXT.md). */
export const ACTING_ROLES: readonly ConsoleRole[] = ["SUPERVISOR", "GUEST"];

/** Detail codes of the refusals this module raises. */
export const CALL_REASON = {
  CALLER_INVALID: "CALLER_INVALID",
  CALLER_NOT_ALLOWED: "CALLER_NOT_ALLOWED",
  ROLE_NOT_ALLOWED: ERROR_REASON.ROLE_NOT_ALLOWED,
  VALIDATION: "VALIDATION",
} as const;

/**
 * Checks the caller of a handler: a valid `Caller` of a world, of a kind the handler accepts and, from
 * the console, of a role that may act. Throws `INVALID` or `FORBIDDEN`.
 */
export function openCall(raw: unknown, rule: CallRule): DirectCall {
  const parsed = Caller.safeParse(raw);
  if (!parsed.success) throw new ToolError("INVALID", "the caller is not valid", CALL_REASON.CALLER_INVALID);
  const caller = parsed.data;
  if (!rule.callers.includes(caller.kind)) throw new ToolError("FORBIDDEN", `${caller.kind} may not call this handler`, CALL_REASON.CALLER_NOT_ALLOWED);
  if (caller.ispId === undefined || caller.clockId === undefined) throw new ToolError("INVALID", "the caller names no world", CALL_REASON.CALLER_INVALID);
  if (caller.kind === "CONSOLE" && rule.consoleRoles !== undefined && (caller.role === undefined || !rule.consoleRoles.includes(caller.role))) {
    throw new ToolError("FORBIDDEN", "this role may not do this", CALL_REASON.ROLE_NOT_ALLOWED);
  }
  const bound = caller as WorldCaller;
  const identity = { kind: bound.kind, caller: bound } as ToolIdentity;
  return { caller: bound, kind: bound.kind, ispId: bound.ispId, clockId: bound.clockId, worldKind: ispKindOfClock(bound.clockId), actor: actorOf(identity) };
}

/** Parses a handler's input with its strict schema; a bad input is `INVALID` (never a 500). */
export function parseInput<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ToolError("INVALID", "invalid input", CALL_REASON.VALIDATION);
  return parsed.data;
}

/** A stored row of the caller's world, or `NOT_FOUND` (a row of another world is never told apart from a missing one). */
export function inWorld<T extends { readonly clockId: string; readonly ispId?: string }>(call: DirectCall, row: T | undefined, what: string): T {
  if (row === undefined || row.clockId !== call.clockId || (row.ispId !== undefined && row.ispId !== call.ispId)) {
    throw new ToolError("NOT_FOUND", `${what} not found`);
  }
  return row;
}

export interface WorldNow {
  /** The world's simulated now, as an ISO instant in the world's time zone. */
  readonly atSim: string;
  readonly timeZone: string;
}

/** The simulated "now" of the caller's world (`Runtime/CLOCK#`), in its time zone. */
export async function worldNow(deps: ServiceDeps, call: Pick<DirectCall, "clockId" | "ispId">): Promise<WorldNow> {
  const clock = worldClock(call.clockId, { readClock: (clockId) => deps.connector.runtime.getClock(clockId), realClock: deps.realClock });
  const settings = await deps.connector.isps.getSettings(call.ispId);
  const timeZone = settings?.timezone ?? MEXICO_CITY_TIME_ZONE;
  return { atSim: toZonedIso(await clock.now(), timeZone), timeZone };
}

export type DecisionOf = Omit<DecisionInput, "ispId" | "clockId" | "actor"> & { readonly actor?: Actor };

/** Appends the audit row of a handler's decision, in the caller's operator and world. */
export function recordDecision(deps: ServiceDeps, call: DirectCall, input: DecisionOf): Promise<Decision> {
  return deps.connector.audit.append({ ...input, ispId: call.ispId, clockId: call.clockId, actor: input.actor ?? call.actor });
}

export interface Denial {
  readonly code: ErrorCode;
  readonly message: string;
  /** The fine-grained code: the audit row's `reason` and the error's `reason`. */
  readonly reason: string;
  readonly action: string;
  readonly atSim: string;
  readonly ruleIds?: readonly string[];
  readonly refs?: DecisionInput["refs"];
}

/** Audits a refusal (`DENY <reason>`) and throws it. */
export async function deny(deps: ServiceDeps, call: DirectCall, denial: Denial): Promise<never> {
  await recordDecision(deps, call, {
    decision: "DENY",
    action: denial.action,
    atSim: denial.atSim,
    reason: denial.reason,
    ...(denial.ruleIds === undefined ? {} : { ruleIds: denial.ruleIds }),
    ...(denial.refs === undefined ? {} : { refs: denial.refs }),
  });
  throw new ToolError(denial.code, denial.message, denial.reason);
}
