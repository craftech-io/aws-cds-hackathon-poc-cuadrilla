// Setups and oracles of the agent scenarios. The setups put a person of the demo world where the scenario's
// operation starts (the same calls the local flows make); the oracles read stored state, the audit log and
// the agent's tool calls, never the model's wording (docs/test-plan.md §4.3). The negatives of every
// outgoing message are the scenario runner's own (scripts/scenarios/lib/oracles.ts), imported, not copied.
import type { PhotoItem } from "@cuadrilla/shared";
import type { Message } from "../../../packages/bff/src/domain/conversations";
import { agentReplies, citationsOf, offersButton, offersEscalation, outboundViolations, refList } from "../../../scripts/scenarios/lib/oracles";
import type { FlowWorld } from "../../flows/support/world";

export { citationsOf, offersButton, offersEscalation, refList };

export const PHOTO_ITEMS = ["POWER_READING_PHOTO", "ONU_LABEL_PHOTO", "ROSETTE_PHOTO"] as const satisfies readonly PhotoItem[];

/** The installer on `workOrderId` (active) at `time` of the demo day. */
export async function onOrder(flow: FlowWorld, installerId: string, workOrderId: string, time: string): Promise<void> {
  await flow.at(time);
  await flow.data.worlds.setActiveWorkOrder(installerId, flow.clockId, workOrderId, await flow.simNow());
}

/** On site for the evidence (tests/flows/evidence.flow.test.ts): the ONU online at `rx` and ONU_ONLINE passed unless told otherwise. */
export async function onSite(flow: FlowWorld, installerId: string, workOrderId: string, options: { readonly rx?: number; readonly onuOnline?: boolean; readonly time?: string } = {}): Promise<void> {
  await onOrder(flow, installerId, workOrderId, options.time ?? "09:45");
  const at = await flow.simNow();
  const order = await flow.data.workOrders.requireWorkOrder(workOrderId);
  await flow.network.client.setBehaviour({ clockId: flow.clockId, serial: order.onuSerial, caller: "QA", atSim: at, change: { behaviour: "ONLINE_OK", fixed: true, ...(options.rx === undefined ? {} : { rxPowerDbm: options.rx }) } });
  if (options.onuOnline !== false) await flow.data.workOrders.updateChecklistItem(workOrderId, "ONU_ONLINE", { status: "PASSED" }, { actor: "QA", atSim: at });
}

/** The agent's replies (`REPLY`, `ORDERS_DETAIL`) of the demo day that reached the person, oldest first (the seed's history left out). */
export async function repliesTo(flow: FlowWorld, personId: string): Promise<Message[]> {
  return agentReplies(await flow.delivered(personId));
}

/** Outgoing messages of the demo day that break a negative of §4.3 (`<messageId>: <patterns>`). */
export async function dirtyOutbound(flow: FlowWorld, personId: string): Promise<string[]> {
  return outboundViolations(await flow.outbound(personId));
}

/** Turns of the person that the output budget cut (`max_tokens`). */
export async function cutTurns(flow: FlowWorld, personId: string): Promise<number> {
  return (await flow.data.conversations.listTurnNotes(personId, 100)).filter((note) => note.stopReason === "max_tokens").length;
}

/** Turns that failed in the worker (no Harness answer, a stream error, a deadline) or lost a preloaded read. */
export function failedTurns(flow: FlowWorld): Array<Record<string, unknown>> {
  return flow.logs.filter((line) => line.message === "turn.harness_failed" || line.message === "turn.preload_failed");
}

/** Whether a reply cites one of `expected` (the pipeline already holds every citation to this turn's search, `CP-CITATION`). */
export function citesAny(message: Message | undefined, expected: readonly string[]): boolean {
  return message !== undefined && citationsOf(message).some((section) => expected.includes(section));
}

/** The order's checklist as `[item, status]`, sorted. */
export async function checklistOf(flow: FlowWorld, workOrderId: string): Promise<string[][]> {
  return (await flow.data.workOrders.listChecklist(workOrderId)).map((entry) => [entry.item, entry.status]).sort();
}

export async function itemStatus(flow: FlowWorld, workOrderId: string, item: string): Promise<string | undefined> {
  return (await flow.data.workOrders.getChecklistItem(workOrderId, item as never))?.status;
}

/** Numbers of the orders of the demo day that belong to anyone but `installerId`. */
export async function foreignOrderNumbers(flow: FlowWorld, installerId: string): Promise<string[]> {
  const others = ["inst-karina", "inst-tomas", "inst-beatriz", "inst-julian", "inst-ernesto", "inst-lorena", "inst-rogelio"].filter((id) => id !== installerId);
  const days = await Promise.all(others.map((id) => flow.data.workOrders.listInstallerDay(id, "2026-10-13")));
  return days.flat().map((order) => order.workOrderNumber);
}
