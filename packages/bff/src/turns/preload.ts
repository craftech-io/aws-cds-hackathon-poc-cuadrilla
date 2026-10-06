// The reads every turn starts with, run by the worker before the Harness (ADR-0028, docs/architecture.md
// §9.1): the Harness runs the tools one response asks for one after the other, so each read the model
// does not have to ask for saves it a round trip and the wait of the tool. Each read goes through the
// target in process (`createToolHandler.invoke`) with the turn's own token, so it passes the same fences
// as a Gateway call (`LAM-SCOPE`, `LAM-KILL`, zod `.strict()`) and leaves its `Runtime/TURN#…/RESULT#`
// row: what the model reads in the envelope grounds G2 and the outbound verification exactly as if it
// had called the tool itself.
//
//   a turn with an active order    get_work_order (orders) and get_checklist (evidence)
//   an installer's message         also get_work_orders (orders), with `recentWorkOrders`
//
// The reads run in parallel. A read that fails is left out: the model asks for it itself. Nothing is
// preloaded while the agent is cut: the worker never gets this far (turns/turn.ts).
import { type TurnTrigger, fail } from "@cuadrilla/shared";
import type { PreloadedResult } from "../agent/envelope";
import type { ToolHandler } from "../agent-tools/common/handler";
import type { Logger } from "../lib/log";

/** The targets in process the worker reads through. */
export interface TurnReads {
  readonly orders: Pick<ToolHandler, "invoke">;
  readonly evidence: Pick<ToolHandler, "invoke">;
}

export interface PlannedRead {
  readonly target: keyof TurnReads;
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
}

const ORDER_READS: readonly PlannedRead[] = [
  { target: "orders", tool: "get_work_order", input: {} },
  { target: "evidence", tool: "get_checklist", input: {} },
];

const INSTALLER_READS: readonly PlannedRead[] = [{ target: "orders", tool: "get_work_orders", input: {} }];

/** What the turn preloads, by trigger and by whether it has an active order. */
export function readsFor(trigger: TurnTrigger, hasWorkOrder: boolean): readonly PlannedRead[] {
  return [...(hasWorkOrder ? ORDER_READS : []), ...(trigger === "INSTALLER_MESSAGE" ? INSTALLER_READS : [])];
}

/** Runs the planned reads together; only the answers that came back `ok` reach the envelope, in plan order. */
export async function preloadReads(reads: TurnReads, sessionToken: string, planned: readonly PlannedRead[], log: Logger): Promise<PreloadedResult[]> {
  const answers = await Promise.all(
    planned.map((read) =>
      reads[read.target].invoke(read.tool, { ...read.input, sessionToken }).catch((error: unknown) => fail("UNAVAILABLE", "the read failed", error instanceof Error ? error.name : "unknown")),
    ),
  );
  const preloaded: PreloadedResult[] = [];
  answers.forEach((answer, index) => {
    const read = planned[index];
    if (read === undefined) return;
    if (answer.ok) preloaded.push({ tool: read.tool, output: answer });
    else log.warn("turn.preload_failed", { tool: read.tool, errorCode: answer.error.code, reason: answer.error.reason });
  });
  return preloaded;
}
