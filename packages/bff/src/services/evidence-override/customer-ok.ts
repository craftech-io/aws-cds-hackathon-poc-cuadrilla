// `record_customer_ok` (docs/tool-catalog.md; FL-040): the installer taps "Cliente conforme" on the
// agent's offer and the item `CUSTOMER_OK` becomes `PASSED`, deterministic and without a turn. The
// InstallerWorker runs it as a `BUTTON_ACTION` in the installer's message group (`caller CHANNEL`,
// channels/whatsapp/button-actions.ts); QA may call it in its worlds.
//
// Only the installer of the order, on an order still open; a second tap writes nothing. The transition
// is the installer's (`PERSON:<id>`), at the simulated instant of the tap; `ACTION CUSTOMER_OK`.
import { z } from "zod";
import { ConnectorError, InstallerId, IsoInstant, ToolError, WorkOrderId } from "@cuadrilla/shared";
import type { WorkOrderActionInput } from "../../channels/whatsapp/ports";
import { personActor } from "../../domain/common";
import { channelCaller } from "../consent/channel-actions";
import { type ServiceDeps, inWorld, openCall, parseInput, recordDecision, worldNow } from "../people/direct-call";
import { OPEN_ORDER_STATUSES } from "./override";

export const CustomerOkInput = z
  .object({
    workOrderId: WorkOrderId,
    /** The installer who tapped (the channel resolved it from the nonce and the phone). */
    personId: InstallerId,
    /** Channel only: the simulated instant and the `wamid` of the tap. */
    atSim: IsoInstant.optional(),
    sourceMessageId: z.string().min(1).max(256).optional(),
  })
  .strict();
export type CustomerOkInput = z.input<typeof CustomerOkInput>;

export const CUSTOMER_OK_REASON = {
  NOT_ORDER_INSTALLER: "NOT_ORDER_INSTALLER",
  ORDER_NOT_OPEN: "ORDER_NOT_OPEN",
  CHANNEL_ONLY_FIELD: "CHANNEL_ONLY_FIELD",
} as const;

export interface CustomerOkResult {
  readonly changed: boolean;
  readonly workOrderId: string;
  readonly status: "PASSED";
}

export async function recordCustomerOk(deps: ServiceDeps, caller: unknown, raw: unknown): Promise<CustomerOkResult> {
  const call = openCall(caller, { callers: ["CHANNEL", "QA"] });
  const input = parseInput(CustomerOkInput, raw);
  if (call.kind !== "CHANNEL" && (input.atSim !== undefined || input.sourceMessageId !== undefined)) {
    throw new ToolError("INVALID", "only the channel brings the tap's instant", CUSTOMER_OK_REASON.CHANNEL_ONLY_FIELD);
  }
  const order = inWorld(call, await deps.connector.workOrders.getWorkOrder(input.workOrderId), "work order");
  if (order.installerId !== input.personId) throw new ToolError("FORBIDDEN", "only the order's installer confirms the customer", CUSTOMER_OK_REASON.NOT_ORDER_INSTALLER);
  if (!OPEN_ORDER_STATUSES.has(order.status)) throw new ToolError("CONFLICT", "the order is no longer open", CUSTOMER_OK_REASON.ORDER_NOT_OPEN);
  const entry = await deps.connector.workOrders.getChecklistItem(order.workOrderId, "CUSTOMER_OK");
  if (entry === undefined) throw new ToolError("NOT_FOUND", "checklist item not found");
  if (entry.status === "PASSED") return { changed: false, workOrderId: order.workOrderId, status: "PASSED" };

  const atSim = input.atSim ?? (await worldNow(deps, call)).atSim;
  try {
    await deps.connector.workOrders.updateChecklistItem(
      order.workOrderId,
      "CUSTOMER_OK",
      { status: "PASSED", updatedAtSim: atSim },
      { actor: call.kind === "CHANNEL" ? personActor(input.personId) : call.actor, atSim, reason: "customer ok" },
      { expectedVersion: entry.version },
    );
  } catch (error) {
    // A second tap won the race: the item is already confirmed.
    if (error instanceof ConnectorError && error.code === "CONFLICT" && (await deps.connector.workOrders.getChecklistItem(order.workOrderId, "CUSTOMER_OK"))?.status === "PASSED") {
      return { changed: false, workOrderId: order.workOrderId, status: "PASSED" };
    }
    throw error;
  }
  await recordDecision(deps, call, {
    decision: "ACTION",
    action: "CUSTOMER_OK",
    atSim,
    refs: { workOrderId: order.workOrderId },
    ...(input.sourceMessageId === undefined ? {} : { messageId: input.sourceMessageId }),
  });
  return { changed: true, workOrderId: order.workOrderId, status: "PASSED" };
}

/** `WorkOrderActions.recordCustomerOk` of the InstallerWorker: the queued tap, `caller CHANNEL`. */
export function customerOkAction(deps: ServiceDeps): (input: WorkOrderActionInput) => Promise<void> {
  return async (input) => {
    await recordCustomerOk(deps, channelCaller(input), { workOrderId: input.workOrderId, personId: input.personId, atSim: input.atSim, sourceMessageId: input.sourceMessageId });
  };
}
