// Target `orders` (`ToolOrders`, docs/tool-catalog.md): the installer's orders of the day, one order
// in detail and the ONU state from the network orchestrator. Read-only for the model; every id comes
// from the session (`LAM-SCOPE`), and the serial of `get_onu_status` is the session order's.
import { z } from "zod";
import {
  CaseId,
  CaseReason,
  CaseStatus,
  ChecklistItem,
  ChecklistItemStatus,
  OnuOperState,
  OnuSerial,
  OpticalClass,
  RejectReason,
  Rung,
  StepOutcome,
  Symptom,
  WorkOrderNumber,
  WorkOrderStatus,
} from "@cuadrilla/shared";
import { StepRef } from "../../domain/work-orders";
import { defineTool } from "../common/definition";
import { CaseOpened } from "../common/fields";

/** An order as the installer knows it: no ids, no phone, no email; the customer by first name only. */
const OrderSummary = {
  workOrderNumber: WorkOrderNumber,
  status: WorkOrderStatus,
  customerFirstName: z.string(),
  addressLine: z.string(),
  neighborhood: z.string(),
  plan: z.string(),
  windowText: z.string(),
};

export const getWorkOrdersTool = defineTool({
  target: "orders",
  name: "get_work_orders",
  description:
    "Lists the work orders of the installer of this session for the simulated day: number, status, customer first name, street, neighborhood, plan, appointment window as text, whether it is the active order and whether it has an open case. Read-only. Copy the texts; never compute dates.",
  principals: ["HARNESS", "CONSOLE"],
  args: z.strictObject({
    day: z.enum(["TODAY", "TOMORROW"]).default("TODAY").describe("Simulated day to list"),
  }),
  output: z.strictObject({
    installerFirstName: z.string(),
    dayText: z.string(),
    workOrders: z.array(z.strictObject({ ...OrderSummary, isActive: z.boolean(), openCase: z.boolean() })),
    /** ADR-0028: the installer's last ten orders in the world, without customer data. */
    recentWorkOrders: z.array(z.strictObject({ workOrderNumber: WorkOrderNumber, status: WorkOrderStatus, dayText: z.string(), open: z.boolean() })).max(10),
    nowSimText: z.string(),
  }),
});

export const getWorkOrderTool = defineTool({
  target: "orders",
  name: "get_work_order",
  description:
    "Returns one work order of the installer in detail: ONU serial, model and OLT port, optical class and acceptance range, checklist state, open case, troubleshooting steps so far and the tips of the installer's measured profile. Without a number it returns the active order; with the number of another order of the installer's day it makes that order the active one.",
  principals: ["HARNESS", "CONSOLE"],
  args: z.strictObject({
    workOrderNumber: WorkOrderNumber.optional().describe("5-digit number of an order of the installer's day; omit it for the active order"),
  }),
  output: z.strictObject({
    workOrder: z.strictObject({
      ...OrderSummary,
      onuSerial: OnuSerial,
      onuModel: z.string(),
      oltPort: z.string(),
      opticalClass: OpticalClass,
      acceptanceRange: z.strictObject({ minDbm: z.number(), maxDbm: z.number(), text: z.string() }),
      onHoldSafety: z.boolean(),
    }),
    checklist: z.array(z.strictObject({ item: ChecklistItem, status: ChecklistItemStatus, attempts: z.int().min(0) })),
    openCase: z.strictObject({ caseId: CaseId, reason: CaseReason, status: CaseStatus, rung: Rung, takenByFirstName: z.string().optional() }).optional(),
    troubleshooting: z.array(z.strictObject({ symptom: Symptom, stepRef: StepRef, outcome: StepOutcome })),
    facts: z.strictObject({
      tips: z.array(z.strictObject({ tipId: z.string(), reason: RejectReason, count30d: z.int().min(0), text: z.string() })),
    }),
  }),
});

export const getOnuStatusTool = defineTool({
  target: "orders",
  name: "get_onu_status",
  description:
    "Reads the ONU of the active work order from the network orchestrator: operational state, received and transmitted power, whether the received power is inside the acceptance range of the order's optical class, OLT port and when it was observed. The serial comes from the order, never from you. With the orchestrator down it answers available: false; then keep guiding with the manual.",
  principals: ["HARNESS", "WORKER", "CONSOLE"],
  args: z.strictObject({}),
  output: z.strictObject({
    available: z.boolean(),
    operState: OnuOperState.optional(),
    rxPowerDbm: z.number().optional(),
    txPowerDbm: z.number().optional(),
    inRange: z.boolean().optional(),
    acceptanceRangeText: z.string().optional(),
    oltPort: z.string().optional(),
    observedAtText: z.string().optional(),
    caseOpened: CaseOpened.optional(),
  }),
});

export const ORDERS_TOOLS = [getWorkOrdersTool, getWorkOrderTool, getOnuStatusTool] as const;
