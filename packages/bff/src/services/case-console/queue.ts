// What a console action leaves on the installer's queue (`InstallerEvents.fifo`, `MessageGroupId =
// installerId`, ADR-0017; docs/architecture.md §7). The console never sends nor invokes the Harness:
//
//   SUPERVISOR_ACTION   "Tomar" / "Cerrar" on a case → the same `take_case` / `close_case` a supervisor's
//                       button runs, in the group of the case's installer (FL-065)
//   AGENT_TURN          `EVIDENCE_OVERRIDDEN` after a manual validation: the agent tells the installer
//                       what is left (FL-044)
//
// The shapes are the consumer's (worker/events.ts, validated again by the producer and the worker);
// unlike the channel's events they carry no inbound message, and the console's user travels as the
// event's `actor`. The event id is derived from what the action changed, so a retried request is the
// same event (`MessageDeduplicationId` and the worker's `IDEMP#`).
import { createHash } from "node:crypto";
import type { AgentTurnEvent, SupervisorActionEvent } from "../../worker/events";

export type ConsoleQueueEvent = (AgentTurnEvent & { readonly trigger: "EVIDENCE_OVERRIDDEN" }) | (SupervisorActionEvent & { readonly action: "TAKE_CASE" | "CLOSE_CASE" });

/** Marks the event in flight for the installer and the world, then sends it (the channel's queue does the same). */
export interface InstallerQueue {
  enqueue(event: ConsoleQueueEvent): Promise<void>;
}

/** `con-<purpose>-<40 hex>`: stable for the same change, distinct across worlds and objects. */
export function consoleEventId(purpose: string, ...parts: ReadonlyArray<string | number>): string {
  const digest = createHash("sha256").update(parts.map(String).join("\n"), "utf8").digest("hex").slice(0, 40);
  return `con-${purpose}-${digest}`;
}
