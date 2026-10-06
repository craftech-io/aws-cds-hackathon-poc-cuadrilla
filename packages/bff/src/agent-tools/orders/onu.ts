// `get_onu_status` (docs/tool-catalog.md, FL-019, FL-021, FL-022, FL-026): the ONU of the active order
// read from the network orchestrator in the call's world. The serial is the order's, never one the
// model wrote (the tool takes no argument). `inRange` is computed here with the order's range by class
// (range.ts), never by the model. An orchestrator that cannot answer is `available: false`, not an
// error, so the agent says it cannot see the network and keeps guiding with the manual. Every reading
// is kept on the order (`lastOnuReading`, which `close_installation` needs); a second reading in a row
// with the ONU `NOT_PROVISIONED` opens the `NOT_PROVISIONED` case by code (§DIAG-04).
import { type OnuOperState, ok } from "@cuadrilla/shared";
import type { NetworkReader } from "@cuadrilla/network-contract";
import type { OnuReading, WorkOrder } from "../../domain/work-orders";
import { type ToolImplementation, implementTool } from "../common/context";
import type { CaseOpened } from "../common/fields";
import { requireActiveWorkOrder } from "../common/scope";
import { type OrdersContext, type OrdersRuntime, worldTimeOf } from "./context";
import { acceptanceRangeOf, acceptanceRangeText, readingInRange } from "./range";
import { getOnuStatusTool } from "./schema";
import { observedText } from "./time-text";

const NOT_PROVISIONED: OnuOperState = "NOT_PROVISIONED";

interface Reader {
  readonly network: NetworkReader;
  readonly source: OnuReading["source"];
}

/** Who reads, as the orchestrator counts it (`queryCount` per reader) and as the order records it. */
function readerOf(kind: OrdersContext["identity"]["kind"]): Reader {
  if (kind === "WORKER" || kind === "CONSOLE" || kind === "QA") return { network: kind, source: kind };
  return { network: "HARNESS", source: "AGENT" };
}

async function keepReading(ctx: OrdersContext, order: WorkOrder, reading: OnuReading): Promise<void> {
  try {
    await ctx.deps.connector.workOrders.recordOnuReading(order.workOrderId, reading);
  } catch (error) {
    ctx.logger.error("onu.reading_not_kept", { workOrderId: order.workOrderId, error });
  }
}

/** §DIAG-04: the installer cannot provision the ONU; at the second reading in a row the code escalates. */
async function escalateUnprovisioned(ctx: OrdersContext, order: WorkOrder, atSim: string): Promise<CaseOpened | undefined> {
  if (ctx.identity.kind !== "HARNESS" && ctx.identity.kind !== "WORKER") return undefined;
  const cases = ctx.deps.notProvisionedCases;
  if (cases === undefined) {
    ctx.logger.warn("onu.not_provisioned_unescalated", { workOrderId: order.workOrderId, reason: "NO_CASE_PORT" });
    return undefined;
  }
  return cases.open({
    ispId: order.ispId,
    clockId: order.clockId,
    installerId: order.installerId,
    workOrderId: order.workOrderId,
    atSim,
    actor: ctx.actor,
    correlationId: ctx.correlationId,
    ...(ctx.scope.turnId === undefined ? {} : { turnId: ctx.scope.turnId }),
  });
}

export const getOnuStatus: ToolImplementation<OrdersRuntime> = implementTool(getOnuStatusTool, async (_args, ctx: OrdersContext) => {
  const order = await requireActiveWorkOrder(ctx);
  const { now, timeZone, today } = await worldTimeOf(ctx);
  const reader = readerOf(ctx.identity.kind);
  const outcome = await ctx.deps.network.getOnuStatus({ clockId: order.clockId, serial: order.onuSerial, caller: reader.network, atSim: now.toISOString(), logger: ctx.logger });
  if (outcome.kind !== "OK") {
    ctx.logger.warn("onu.unavailable", { workOrderId: order.workOrderId, outcome: outcome.kind, ...(outcome.kind === "UNAVAILABLE" ? { reason: outcome.reason } : {}) });
    return ok({ available: false });
  }
  const status = outcome.value;
  const range = acceptanceRangeOf(order, await ctx.deps.connector.isps.getZone(order.ispId, order.zoneId));
  const inRange = readingInRange(status.operState, status.rxPowerDbm, range);
  const previous = order.lastOnuReading;
  await keepReading(ctx, order, {
    operState: status.operState,
    ...(status.rxPowerDbm === undefined ? {} : { rxPowerDbm: status.rxPowerDbm }),
    ...(status.txPowerDbm === undefined ? {} : { txPowerDbm: status.txPowerDbm }),
    inRange,
    observedAtSim: status.observedAt,
    source: reader.source,
  });
  const caseOpened = status.operState === NOT_PROVISIONED && previous?.operState === NOT_PROVISIONED ? await escalateUnprovisioned(ctx, order, now.toISOString()) : undefined;
  return ok({
    available: true,
    operState: status.operState,
    ...(status.rxPowerDbm === undefined ? {} : { rxPowerDbm: status.rxPowerDbm }),
    ...(status.txPowerDbm === undefined ? {} : { txPowerDbm: status.txPowerDbm }),
    inRange,
    acceptanceRangeText: acceptanceRangeText(range, order.opticalClass),
    oltPort: status.oltPort ?? order.oltPort,
    observedAtText: observedText(status.observedAt, today, timeZone),
    ...(caseOpened === undefined ? {} : { caseOpened }),
  });
});
