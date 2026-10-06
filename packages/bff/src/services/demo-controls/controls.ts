// Demo controls of the console (docs/tool-catalog.md: `set_template_status`, `set_onu_behaviour`,
// `dispatch_control`; `clock.setTemplateStatus`, `clock.setOnuBehaviour`, `clock.dispatch.*`): what a
// person changes in the simulated world to show a story, never a decision about a case or a photo.
// Every console role may use them in its own world (they are not marked S in the catalog); the
// console's procedures refuse them while the world is busy (`WORLD_BUSY`, docs/architecture.md §8)
// before calling here. Each one writes `ACTION DEMO_CONTROL` with what it changed.
//
//   template status   the simulated Meta state of one template in this world (`Isps/SETTINGS`, with a
//                     dated history), to show plan B; never in the live world, whose templates are real
//   ONU behaviour     `POST /v1/onus/{serial}/behaviour` of the network mock for the ONU of an order of
//                     this world (the serial comes from the order, never from the input)
//   dispatch          reschedule, reassign or cancel an order of this world through the dispatch mock,
//                     which publishes the event the installer's queue then receives
import { z } from "zod";
import { AppointmentWindow, type DispatchAction, DispatchReason } from "@cuadrilla/dispatch-mock";
import { BehaviourRequest, OnuBehaviour, type OnuControlState } from "@cuadrilla/network-contract";
import { InstallerId, TemplateName, TemplateStatus, ToolError, type WorkOrderStatus, WorkOrderId } from "@cuadrilla/shared";
import type { WorkOrder } from "../../domain/work-orders";
import { ulid } from "../../lib/crypto";
import type { NetworkClient } from "../../network/client";
import { type DirectCall, type ServiceDeps, inWorld, openCall, parseInput, recordDecision, worldNow } from "../people/direct-call";
import type { DispatchControlClient } from "./dispatch-client";

const DEMO_CALLERS = { callers: ["CONSOLE", "QA"] } as const;

export const DEMO_REASON = {
  LIVE_WORLD: "LIVE_WORLD",
  NOTHING_TO_CHANGE: "NOTHING_TO_CHANGE",
  ORDER_NOT_OPEN: "ORDER_NOT_OPEN",
  NOT_AN_INSTALLER: "NOT_AN_INSTALLER",
  SAME_INSTALLER: "SAME_INSTALLER",
  INSTALLER_INACTIVE: "INSTALLER_INACTIVE",
} as const;

function demoDecision(deps: ServiceDeps, call: DirectCall, atSim: string, detail: Record<string, unknown>, workOrderId?: string) {
  return recordDecision(deps, call, { decision: "ACTION", action: "DEMO_CONTROL", atSim, refs: workOrderId === undefined ? {} : { workOrderId }, detail });
}

async function orderOf(deps: ServiceDeps, call: DirectCall, workOrderId: string): Promise<WorkOrder> {
  return inWorld(call, await deps.connector.workOrders.getWorkOrder(workOrderId), "work order");
}

// ---- Template status ----------------------------------------------------------------------------

export const SetTemplateStatusInput = z.object({ name: TemplateName, status: TemplateStatus }).strict();
export type SetTemplateStatusInput = z.input<typeof SetTemplateStatusInput>;

export interface TemplateStatusResult {
  readonly changed: boolean;
  readonly name: TemplateName;
  readonly status: TemplateStatus;
}

export async function setTemplateStatus(deps: ServiceDeps, caller: unknown, raw: unknown): Promise<TemplateStatusResult> {
  const call = openCall(caller, DEMO_CALLERS);
  const input = parseInput(SetTemplateStatusInput, raw);
  const settings = await deps.connector.isps.getSettings(call.ispId);
  if (settings === undefined || settings.clockId !== call.clockId) throw new ToolError("NOT_FOUND", "settings of the world not found");
  if (settings.whatsappMode === "live") throw new ToolError("FORBIDDEN", "the live world's templates are the real ones", DEMO_REASON.LIVE_WORLD);
  // A template the world never set is APPROVED (docs/seed-spec.md §4).
  if ((settings.templateStatus[input.name] ?? "APPROVED") === input.status) return { changed: false, ...input };
  const { atSim } = await worldNow(deps, call);
  await deps.connector.isps.setTemplateStatus(call.ispId, input.name, input.status, { actor: call.actor, atSim });
  await demoDecision(deps, call, atSim, { control: "TEMPLATE_STATUS", name: input.name, status: input.status });
  return { changed: true, ...input };
}

// ---- ONU behaviour ------------------------------------------------------------------------------

export const SetOnuBehaviourInput = z
  .object({
    workOrderId: WorkOrderId,
    behaviour: OnuBehaviour.optional(),
    fixed: z.boolean().optional(),
    rxPowerDbm: z.number().min(-50).max(10).optional(),
  })
  .strict();
export type SetOnuBehaviourInput = z.input<typeof SetOnuBehaviourInput>;

export interface OnuDemoDeps extends ServiceDeps {
  readonly network: Pick<NetworkClient, "setBehaviour">;
}

export async function setOnuBehaviour(deps: OnuDemoDeps, caller: unknown, raw: unknown): Promise<OnuControlState> {
  const call = openCall(caller, DEMO_CALLERS);
  const { workOrderId, ...fields } = parseInput(SetOnuBehaviourInput, raw);
  const change = BehaviourRequest.safeParse(fields);
  if (!change.success) throw new ToolError("INVALID", "say what changes: behaviour, fixed or power", DEMO_REASON.NOTHING_TO_CHANGE);
  const order = await orderOf(deps, call, workOrderId);
  const { atSim } = await worldNow(deps, call);
  const outcome = await deps.network.setBehaviour({
    clockId: call.clockId,
    serial: order.onuSerial,
    caller: call.kind === "QA" ? "QA" : "CONSOLE",
    atSim,
    change: change.data,
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
  });
  if (outcome.kind === "NOT_FOUND") throw new ToolError("NOT_FOUND", "the order's ONU is not in the simulated network");
  if (outcome.kind === "UNAVAILABLE") throw new ToolError("UNAVAILABLE", "the simulated network did not answer", outcome.reason);
  await demoDecision(deps, call, atSim, { control: "ONU_BEHAVIOUR", ...change.data, result: outcome.value.behaviour }, order.workOrderId);
  return outcome.value;
}

// ---- Dispatch -----------------------------------------------------------------------------------

const DispatchBase = { workOrderId: WorkOrderId, reason: DispatchReason };

export const DispatchControlInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("reschedule"), ...DispatchBase, newWindow: AppointmentWindow }).strict(),
  z.object({ action: z.literal("reassign"), ...DispatchBase, newInstallerId: InstallerId }).strict(),
  z.object({ action: z.literal("cancel"), ...DispatchBase }).strict(),
]);
export type DispatchControlInput = z.input<typeof DispatchControlInput>;

export interface DispatchDemoDeps extends ServiceDeps {
  readonly dispatch: DispatchControlClient;
}

export interface DispatchControlResult {
  readonly action: DispatchAction;
  readonly eventId: string;
  /** The key had been applied already: the mock published the stored event again. */
  readonly replayed: boolean;
  readonly dispatchStatus: string;
}

/** Orders the dispatcher may still change; a closed or failed visit is the product's, not the dispatcher's. */
const DISPATCHABLE: ReadonlySet<WorkOrderStatus> = new Set<WorkOrderStatus>(["SCHEDULED", "IN_PROGRESS", "RESCHEDULED", "REASSIGNED"]);

async function checkNewInstaller(deps: ServiceDeps, call: DirectCall, order: WorkOrder, installerId: string): Promise<void> {
  const person = inWorld(call, await deps.connector.people.getPerson(installerId), "installer");
  if (person.role !== "INSTALLER") throw new ToolError("INVALID", "orders are assigned to installers", DEMO_REASON.NOT_AN_INSTALLER);
  if (!person.active) throw new ToolError("INVALID", "the installer is not on the allow list", DEMO_REASON.INSTALLER_INACTIVE);
  if (person.personId === order.installerId) throw new ToolError("INVALID", "the order already has that installer", DEMO_REASON.SAME_INSTALLER);
}

/** One key per console action: the caller's event id when it is a valid key, a fresh ULID otherwise. */
async function idempotencyKeyOf(deps: ServiceDeps, call: DirectCall): Promise<string> {
  const eventId = call.caller.eventId;
  const key = eventId === undefined ? undefined : `con:${eventId}`;
  if (key !== undefined && /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,199}$/.test(key)) return key;
  return `con:${ulid((await deps.realClock.now()).getTime())}`;
}

export async function dispatchControl(deps: DispatchDemoDeps, caller: unknown, raw: unknown): Promise<DispatchControlResult> {
  const call = openCall(caller, DEMO_CALLERS);
  const input = parseInput(DispatchControlInput, raw);
  const order = await orderOf(deps, call, input.workOrderId);
  if (!DISPATCHABLE.has(order.status)) throw new ToolError("CONFLICT", "the order is no longer open", DEMO_REASON.ORDER_NOT_OPEN);
  if (input.action === "reassign") await checkNewInstaller(deps, call, order, input.newInstallerId);
  const { atSim } = await worldNow(deps, call);
  const base = { ispId: call.ispId, reason: input.reason, occurredAtSim: atSim, idempotencyKey: await idempotencyKeyOf(deps, call) };
  const body =
    input.action === "reschedule" ? { ...base, newWindow: input.newWindow } : input.action === "reassign" ? { ...base, newInstallerId: input.newInstallerId } : base;
  const outcome = await deps.dispatch.command(input.action, order.workOrderNumber, body, deps.logger?.correlationId);
  if (outcome.kind === "REFUSED") throw new ToolError(outcome.code, outcome.message, outcome.reason);
  if (outcome.kind === "UNAVAILABLE") throw new ToolError("UNAVAILABLE", "the dispatcher did not answer", outcome.reason);
  const { eventId, replayed } = outcome.result;
  await demoDecision(deps, call, atSim, { control: "DISPATCH", action: input.action, reason: input.reason, eventId, replayed }, order.workOrderId);
  return { action: input.action, eventId, replayed, dispatchStatus: outcome.result.order.status };
}
