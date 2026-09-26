// "Resultados del turno" (docs/tool-catalog.md, Convenciones): every tool call of a Harness turn
// stores its output in `Runtime/TURN#<turnId>/RESULT#<tool>#<seq>` (TTL 1 h). They are the grounding
// source of G2 and of the deterministic fact check of the outbound pipeline (a figure, serial, order
// number or time the agent writes must appear here), so numbers stay as the tool returned them.
// Outputs never carry personal data by contract; strings are still passed through the masker, so a
// phone, email or document that slipped into a text never lands in `Runtime`. Our own ids (`val-…`,
// `case-…`) are kept whole: a digit run inside a ULID can pass Luhn and read as a card.
import { kindOfId } from "@cuadrilla/shared";
import { LOG_KINDS, maskText } from "../../lib/mask";
import type { JsonObject } from "../../domain/common";
import type { ToolContext } from "./context";

const MAX_DEPTH = 8;

/** A copy of `value` with every string masked (ids of ours excepted); other JSON values as they are. */
export function redactTurnValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return kindOfId(value) === undefined ? maskText(value, LOG_KINDS) : value;
  if (Array.isArray(value)) return depth >= MAX_DEPTH ? [] : value.map((item) => redactTurnValue(item, depth + 1));
  if (typeof value === "object" && value !== null) {
    if (depth >= MAX_DEPTH) return {};
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactTurnValue(item, depth + 1)]));
  }
  return value;
}

/** Stores the result of a Harness call; a failed write is logged, never returned to the model. */
export async function storeTurnResult(ctx: Pick<ToolContext, "tool" | "scope" | "identity" | "deps" | "logger">, result: JsonObject): Promise<void> {
  if (ctx.identity.kind !== "HARNESS" || ctx.scope.turnId === undefined) return;
  try {
    await ctx.deps.connector.runtime.putTurnResult(ctx.scope.turnId, ctx.tool, redactTurnValue(result) as JsonObject);
  } catch (error) {
    ctx.logger.error("tool.turn_result.failed", { tool: ctx.tool, turnId: ctx.scope.turnId, error });
  }
}
