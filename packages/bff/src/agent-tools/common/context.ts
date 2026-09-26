// What a tool implementation receives from `createToolHandler`: the validated arguments and a context
// with the principal, the scope derived from it (never from the model's input), the dependencies and a
// logger bound to the call. Wave-3 targets write `implementTool(definition, run)` per tool.
import type { z } from "zod";
import { type Caller, type CallerKind, type ToolFailure, type ToolResult, fail } from "@cuadrilla/shared";
import type { Connector } from "../../connector/ports";
import type { Actor } from "../../domain/common";
import type { Clock } from "../../lib/clock";
import type { SecretKey } from "../../lib/crypto";
import type { Logger } from "../../lib/log";
import type { KillSwitchReader } from "../../ops/kill-switch";
import type { ResolvedSession } from "../../services/session/session";
import type { ToolDefinition, ToolTarget } from "./definition";

/** Dependencies every target needs; a target extends it with its own clients and ports. */
export interface ToolRuntime {
  readonly connector: Connector;
  readonly killSwitch: KillSwitchReader;
  /** The `session` subkey (lib/secrets.ts `subkey("session")`), read on first use. */
  readonly sessionKey: () => SecretKey;
  /** Real time: token expiry and latency. Business time is the world's (ADR-0010). */
  readonly realClock: Clock;
  /** The logger of one call, bound to its correlation id (lib/log.ts `createLogger` by default). */
  readonly loggerFor?: (correlationId: string) => Logger;
}

/** The work a trusted direct caller acts on: the channel resolved it from a nonce, QA from its world. */
export interface ToolSubject {
  readonly installerId?: string;
  readonly workOrderId?: string;
}

/** Who invoked the tool: the Harness (through the Gateway, by its signed session) or a direct caller. */
export type ToolIdentity =
  | { readonly kind: "HARNESS"; readonly session: ResolvedSession }
  | { readonly kind: CallerKind; readonly caller: Caller & { readonly ispId: string; readonly clockId: string } };

/**
 * `LAM-SCOPE`: operator, world, installer and work order the call may touch. For the Harness they
 * come from `Runtime/SESSION#`; for a direct caller from the caller and its verified subject.
 */
export interface ToolScope {
  readonly ispId: string;
  readonly clockId: string;
  readonly installerId?: string;
  /** The active order of the session, or the subject's order. */
  readonly workOrderId?: string;
  readonly turnId?: string;
  /** Simulated instant of the event that opened the turn (Harness only). */
  readonly eventAtSim?: string;
  readonly sourceMessageId?: string;
  /** Queue, channel or feed event of a direct call. */
  readonly eventId?: string;
}

export interface ToolContext<D extends ToolRuntime = ToolRuntime> {
  readonly target: ToolTarget;
  readonly tool: string;
  readonly identity: ToolIdentity;
  readonly scope: ToolScope;
  /** `AGENT` for the Harness; `WORKER`, `CHANNEL`, `QA`, `SCHEDULER` or `USER:<id>` for a caller. */
  readonly actor: Actor;
  readonly deps: D;
  readonly logger: Logger;
  readonly correlationId: string;
  /** Real instant the call started. */
  readonly realNow: Date;
}

/** What a tool may answer: its output, a failure, or a failure with its declared extra fields. */
export type ToolRunResult<O extends z.ZodObject, F extends z.ZodObject> = ToolResult<z.input<O>> | (ToolFailure & Partial<z.input<F>>);

export type ToolRun<A extends z.ZodObject, O extends z.ZodObject, F extends z.ZodObject, D extends ToolRuntime> = (
  args: z.output<A>,
  ctx: ToolContext<D>,
) => Promise<ToolRunResult<O, F>>;

/** A tool bound to its implementation, with the types erased so a target can list several. */
export interface ToolImplementation<D extends ToolRuntime = ToolRuntime> {
  readonly definition: ToolDefinition;
  readonly run: (args: unknown, ctx: ToolContext<D>) => Promise<unknown>;
}

export function implementTool<A extends z.ZodObject, O extends z.ZodObject, F extends z.ZodObject, D extends ToolRuntime>(
  definition: ToolDefinition<A, O, F>,
  run: ToolRun<A, O, F, D>,
): ToolImplementation<D> {
  return { definition: definition as unknown as ToolDefinition, run: (args, ctx) => run(args as z.output<A>, ctx) };
}

/**
 * Placeholder of a tool whose logic belongs to a later work package (docs/build-plan.md: a stub
 * answers `UNAVAILABLE`). Goes through the whole handler, so the fences already hold.
 */
export function notYetAvailable<D extends ToolRuntime>(definition: ToolDefinition): ToolImplementation<D> {
  return { definition, run: async (): Promise<ToolFailure> => fail("UNAVAILABLE", "this tool is not available yet", "NOT_IMPLEMENTED") };
}

/** The actor an audit row names for the principal of a call. */
export function actorOf(identity: ToolIdentity): Actor {
  if (identity.kind === "HARNESS") return "AGENT";
  if (identity.kind === "CONSOLE" && identity.caller.userId !== undefined) return `USER:${identity.caller.userId}`;
  return identity.kind === "CONSOLE" ? "SYSTEM" : identity.kind;
}
