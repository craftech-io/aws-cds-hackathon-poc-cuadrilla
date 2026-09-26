// `createToolHandler` (docs/tool-catalog.md, Convenciones; docs/design-brief.md §5.6): the one wrapper
// every Gateway tool goes through, as a Lambda (the target's `handler`) and in process (`invoke`, for
// the worker, the console and the local flows). In order:
//
//   1. the call: a Gateway call (tool arguments + Gateway keys in the context) or a direct one
//   2. `LAM-CALLER`: `sessionToken` XOR `caller`; through the Gateway only `sessionToken`
//   3. the principal: a verified session of an open turn (the Harness) or a caller bound to a world,
//      and only the principals the tool accepts (QA only in `qa-*`/`eval-*` worlds)
//   4. `LAM-SCOPE`: the scope comes from the session (or the caller and its verified subject)
//   5. `LAM-KILL`: `UNAVAILABLE` without effects while `KILL#AGENT` is on, `report_safety_hazard` exempt
//   6. `LAM-STRICT`: strict arguments; `override`, `decision`, `force` refused with any value
//   7. the tool, which never throws out of here, and its output checked against its schema
//   8. the result of a Harness call stored for the turn (G2 grounding source)
//
// A call never throws: every refusal is `{ ok: false, error: { code, message, reason? } }`.
import { ToolError, type ToolFailure, toToolFailure } from "@cuadrilla/shared";
import { createLogger, correlationIdFrom } from "../../lib/log";
import { KILL_EXEMPT_TOOLS, toolKillGate } from "../../ops/kill-switch";
import { TOOL_CATALOG } from "./catalog";
import { type ToolContext, type ToolImplementation, type ToolRuntime, type ToolSubject, actorOf } from "./context";
import type { ToolTarget } from "./definition";
import {
  INVOCATION_REASON,
  type LambdaContextLike,
  type ToolCall,
  checkPrincipal,
  principalScope,
  readPrincipal,
  readToolCall,
  resolveIdentity,
} from "./invocation";
import { scopeWithSubject } from "./scope";
import { storeTurnResult } from "./turn-results";
import { type ToolResponse, checkResult, parseArgs } from "./validation";

export type { ToolResponse } from "./validation";

export interface ToolHandlerSpec<D extends ToolRuntime> {
  readonly target: ToolTarget;
  /** Exactly the tools the catalog lists for the target. */
  readonly tools: readonly ToolImplementation<D>[];
  /** The dependencies of a call; read per call, so a container builds them once and tests inject them. */
  readonly deps: () => D;
}

export interface InvokeOptions {
  readonly subject?: ToolSubject;
  readonly correlationId?: string;
}

export interface ToolHandler {
  readonly target: ToolTarget;
  readonly toolNames: readonly string[];
  /** Lambda entry of the target: Gateway calls and direct invocations `{ tool, input, subject? }`. */
  handler(event: unknown, context?: LambdaContextLike): Promise<ToolResponse>;
  /** A direct call in process, with the same fences as the Lambda. */
  invoke(tool: string, input: Readonly<Record<string, unknown>>, options?: InvokeOptions): Promise<ToolResponse>;
}

function checkTools<D extends ToolRuntime>(spec: ToolHandlerSpec<D>): Map<string, ToolImplementation<D>> {
  const expected = TOOL_CATALOG[spec.target].map((definition) => definition.name).sort();
  const byName = new Map(spec.tools.map((tool) => [tool.definition.name, tool] as const));
  const given = [...byName.keys()].sort();
  const foreign = spec.tools.filter((tool) => tool.definition.target !== spec.target);
  if (byName.size !== spec.tools.length || JSON.stringify(given) !== JSON.stringify(expected) || foreign.length > 0) {
    throw new Error(`target ${spec.target} must serve exactly [${expected.join(", ")}], got [${spec.tools.map((tool) => `${tool.definition.target}___${tool.definition.name}`).join(", ")}]`);
  }
  return byName;
}

export function createToolHandler<D extends ToolRuntime>(spec: ToolHandlerSpec<D>): ToolHandler {
  const tools = checkTools(spec);

  async function execute(call: ToolCall): Promise<ToolResponse> {
    const deps = spec.deps();
    const realNow = await deps.realClock.now();
    const loggerFor = deps.loggerFor ?? ((correlationId: string) => createLogger({ correlationId }));
    const bindings = { component: "agent-tools", target: spec.target, tool: call.tool ?? "unknown", via: call.via };
    const refuse = (failure: ToolFailure, correlationId?: string): ToolResponse => {
      loggerFor(correlationIdFrom(correlationId)).child(bindings).warn("tool.refused", { errorCode: failure.error.code, reason: failure.error.reason });
      return failure;
    };

    const binding = call.tool === undefined ? undefined : tools.get(call.tool);
    if (binding === undefined) return refuse({ ok: false, error: { code: "INVALID", message: "unknown tool", reason: INVOCATION_REASON.UNKNOWN_TOOL } }, call.correlationId);
    const principal = readPrincipal(call);
    if ("ok" in principal) return refuse(principal, call.correlationId);
    let identity;
    try {
      identity = await resolveIdentity(principal, deps, realNow.getTime());
    } catch (error) {
      return refuse(toToolFailure(error), call.correlationId);
    }
    const correlationId = correlationIdFrom(call.correlationId ?? (identity.kind === "HARNESS" ? identity.session.turnId : identity.caller.eventId));
    const notAllowed = checkPrincipal(binding.definition, identity);
    if (notAllowed !== undefined) return refuse(notAllowed, correlationId);

    const logger = loggerFor(correlationId).child({ ...bindings, principal: identity.kind });
    const base: ToolContext<D> = {
      target: spec.target,
      tool: binding.definition.name,
      identity,
      scope: principalScope(identity),
      actor: actorOf(identity),
      deps,
      logger,
      correlationId,
      realNow,
    };
    let ctx = base;
    try {
      if (identity.kind !== "HARNESS") ctx = { ...base, scope: await scopeWithSubject(base, call.subject) };
      if (!KILL_EXEMPT_TOOLS.has(ctx.tool)) {
        const cut = toolKillGate(await deps.killSwitch.status(ctx.scope.clockId), ctx.tool);
        if (cut !== undefined) {
          logger.warn("tool.paused", { errorCode: cut.error.code, reason: cut.error.reason });
          return cut;
        }
      }
    } catch (error) {
      // An unreadable kill switch fails closed; a refused subject is the caller's.
      const failure = toToolFailure(error);
      logger.warn("tool.refused", { errorCode: failure.error.code, reason: failure.error.reason });
      return failure;
    }

    const args = await parseArgs(ctx, binding.definition, call.input);
    if (!args.ok) return args.failure;
    let raw: unknown;
    try {
      raw = await binding.run(args.args, ctx);
    } catch (error) {
      // A ToolError is a refusal the tool meant (scope, evidence, bridge); anything else is a bug or an outage.
      raw = toToolFailure(error);
      if (error instanceof ToolError) logger.warn("tool.refused", { errorCode: error.code, reason: error.reason });
      else logger.error("tool.failed", { metric: "ToolErrors", value: 1, error });
    }
    const response = checkResult(ctx, binding.definition, raw);
    await storeTurnResult(ctx, response as Record<string, unknown>);
    const latencyMs = (await deps.realClock.now()).getTime() - realNow.getTime();
    logger.info("tool.result", { ok: response.ok, errorCode: response.ok ? undefined : response.error.code, latencyMs });
    return response;
  }

  // Last line of "never throws": dependencies that cannot even be built (a missing link, a clock).
  const run = (call: ToolCall | ToolFailure): Promise<ToolResponse> =>
    "via" in call
      ? execute(call).catch((error: unknown) => {
          createLogger({ bindings: { component: "agent-tools", target: spec.target } }).error("tool.failed", { metric: "ToolErrors", value: 1, error });
          return toToolFailure(error);
        })
      : Promise.resolve(call);

  return {
    target: spec.target,
    toolNames: [...tools.keys()],
    handler: (event, context) => run(readToolCall(spec.target, event, context)),
    invoke: (tool, input, options = {}) => run(readToolCall(spec.target, { tool, input, ...options }, undefined)),
  };
}
