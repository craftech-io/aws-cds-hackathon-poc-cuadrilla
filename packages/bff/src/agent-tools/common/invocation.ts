// How a tool call arrives and who makes it (docs/tool-catalog.md, "Invocación directa"; `LAM-CALLER`).
//
//   Gateway   AgentCore Gateway invokes the target Lambda with the tool arguments as the event and
//             its own keys in `context.clientContext.custom` (`bedrockAgentCoreGatewayId`,
//             `bedrockAgentCoreToolName` = `<target>___<tool>`). The only principal is the Harness:
//             a `sessionToken` is required and a `caller` is refused, whatever Cedar allowed.
//   Direct    the worker, the channel, the console or the QaDriver invoke the Lambda (or import the
//             target) with `{ tool, input, subject? }`; `input` carries `sessionToken` XOR `caller`.
//             `caller` does not authenticate: the Lambda's resource policy is the fence.
import { z } from "zod";
import {
  Caller,
  ERROR_REASON,
  InstallerId,
  ToolError,
  type ToolFailure,
  WorkOrderId,
  fail,
  ispKindOfClock,
} from "@cuadrilla/shared";
import { resolveSession } from "../../services/session/session";
import type { ToolIdentity, ToolRuntime, ToolScope, ToolSubject } from "./context";
import { GATEWAY_TOOL_SEPARATOR, TOOL_NAME, type ToolDefinition, type ToolTarget } from "./definition";

/** Keys AgentCore Gateway puts in the invocation context; either one marks a Gateway call. */
export const GATEWAY_CONTEXT_KEYS = ["bedrockAgentCoreGatewayId", "bedrockAgentCoreToolName"] as const;

/** The part of the Lambda context this module reads (compatible with aws-lambda's `Context`). */
export interface LambdaContextLike {
  readonly clientContext?: { readonly custom?: unknown } | null;
}

/** Reason codes of the refusals of this module (the model only sees `code`). */
export const INVOCATION_REASON = {
  UNKNOWN_TOOL: "UNKNOWN_TOOL",
  MALFORMED_CALL: "MALFORMED_CALL",
  CALLER_THROUGH_GATEWAY: "CALLER_THROUGH_GATEWAY",
  PRINCIPAL_XOR: "PRINCIPAL_XOR",
  CALLER_INVALID: "CALLER_INVALID",
  PRINCIPAL_NOT_ALLOWED: "PRINCIPAL_NOT_ALLOWED",
} as const;

/** Envelope of a direct invocation. */
export const DirectToolEvent = z.strictObject({
  tool: z.string().regex(TOOL_NAME),
  input: z.record(z.string(), z.unknown()),
  subject: z.strictObject({ installerId: InstallerId.optional(), workOrderId: WorkOrderId.optional() }).optional(),
  correlationId: z.string().min(1).max(128).optional(),
});
export type DirectToolEvent = z.infer<typeof DirectToolEvent>;

export interface ToolCall {
  readonly via: "GATEWAY" | "DIRECT";
  /** Tool name without the target prefix; `undefined` when the Gateway named another target. */
  readonly tool: string | undefined;
  readonly input: Readonly<Record<string, unknown>>;
  readonly subject?: ToolSubject;
  readonly correlationId?: string;
}

function gatewayKeys(context: LambdaContextLike | undefined): Readonly<Record<string, unknown>> | undefined {
  const custom = context?.clientContext?.custom;
  if (typeof custom !== "object" || custom === null) return undefined;
  return GATEWAY_CONTEXT_KEYS.some((key) => key in custom) ? (custom as Record<string, unknown>) : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads the event of a Lambda invocation into a call, or the failure that refuses it. */
export function readToolCall(target: ToolTarget, event: unknown, context: LambdaContextLike | undefined): ToolCall | ToolFailure {
  const keys = gatewayKeys(context);
  if (keys !== undefined) {
    const qualified = keys.bedrockAgentCoreToolName;
    const prefix = `${target}${GATEWAY_TOOL_SEPARATOR}`;
    const tool = typeof qualified === "string" && qualified.startsWith(prefix) ? qualified.slice(prefix.length) : undefined;
    if (!isPlainObject(event)) return fail("INVALID", "the tool arguments must be an object", INVOCATION_REASON.MALFORMED_CALL);
    return { via: "GATEWAY", tool, input: event };
  }
  const direct = DirectToolEvent.safeParse(event);
  if (!direct.success) return fail("INVALID", "malformed direct invocation: expected { tool, input, subject? }", INVOCATION_REASON.MALFORMED_CALL);
  return { via: "DIRECT", tool: direct.data.tool, input: direct.data.input, subject: direct.data.subject, correlationId: direct.data.correlationId };
}

export type Principal = { readonly kind: "SESSION"; readonly token: unknown } | { readonly kind: "CALLER"; readonly caller: unknown };

/** `sessionToken` XOR `caller`; through the Gateway, only `sessionToken` (`LAM-CALLER`). */
export function readPrincipal(call: ToolCall): Principal | ToolFailure {
  const hasToken = call.input.sessionToken !== undefined;
  const hasCaller = call.input.caller !== undefined;
  if (call.via === "GATEWAY") {
    if (hasCaller) return fail("FORBIDDEN", "a Gateway call is made by the Harness session, never by a caller", INVOCATION_REASON.CALLER_THROUGH_GATEWAY);
    if (!hasToken) return fail("FORBIDDEN", "the sessionToken of the turn is required", ERROR_REASON.SESSION_INVALID);
    return { kind: "SESSION", token: call.input.sessionToken };
  }
  if (hasToken && hasCaller) return fail("INVALID", "send sessionToken or caller, not both", INVOCATION_REASON.PRINCIPAL_XOR);
  if (hasToken) {
    if (call.subject !== undefined) return fail("INVALID", "a session call takes its subject from the session", INVOCATION_REASON.PRINCIPAL_XOR);
    return { kind: "SESSION", token: call.input.sessionToken };
  }
  if (hasCaller) return { kind: "CALLER", caller: call.input.caller };
  return fail("FORBIDDEN", "a sessionToken or a caller is required", ERROR_REASON.SESSION_INVALID);
}

/** Who the call is: the stored session of a verified token, or a well-formed caller bound to a world. */
export async function resolveIdentity(principal: Principal, deps: Pick<ToolRuntime, "connector" | "sessionKey">, realNowMs: number): Promise<ToolIdentity> {
  if (principal.kind === "SESSION") {
    const session = await resolveSession(deps.sessionKey(), principal.token, deps.connector.runtime, realNowMs);
    return { kind: "HARNESS", session };
  }
  const parsed = Caller.safeParse(principal.caller);
  if (!parsed.success) throw new ToolError("FORBIDDEN", "the caller is not valid", INVOCATION_REASON.CALLER_INVALID);
  const { ispId, clockId } = parsed.data;
  if (ispId === undefined || clockId === undefined) throw new ToolError("FORBIDDEN", "a tool caller acts inside one operator and world", INVOCATION_REASON.CALLER_INVALID);
  return { kind: parsed.data.kind, caller: { ...parsed.data, ispId, clockId } };
}

/** The principals the tool accepts (docs/tool-catalog.md, "invocan"); QA only in `qa-*` and `eval-*` worlds. */
export function checkPrincipal(definition: ToolDefinition, identity: ToolIdentity): ToolFailure | undefined {
  if (!definition.principals.includes(identity.kind)) return fail("FORBIDDEN", `${identity.kind} may not invoke this tool`, INVOCATION_REASON.PRINCIPAL_NOT_ALLOWED);
  if (identity.kind === "QA") {
    const kind = ispKindOfClock(identity.caller.clockId);
    if (kind !== "QA" && kind !== "EVAL") return fail("FORBIDDEN", "QA invokes tools only in qa-* and eval-* worlds", INVOCATION_REASON.PRINCIPAL_NOT_ALLOWED);
  }
  return undefined;
}

/** The scope the principal alone grants (a caller's subject is verified afterwards, scope.ts). */
export function principalScope(identity: ToolIdentity): ToolScope {
  if (identity.kind === "HARNESS") {
    const { session } = identity;
    return {
      ispId: session.ispId,
      clockId: session.clockId,
      installerId: session.installerId,
      turnId: session.turnId,
      eventAtSim: session.eventAtSim,
      ...(session.workOrderId === undefined ? {} : { workOrderId: session.workOrderId }),
      ...(session.sourceMessageId === undefined ? {} : { sourceMessageId: session.sourceMessageId }),
    };
  }
  const { caller } = identity;
  return { ispId: caller.ispId, clockId: caller.clockId, ...(caller.eventId === undefined ? {} : { eventId: caller.eventId }) };
}
