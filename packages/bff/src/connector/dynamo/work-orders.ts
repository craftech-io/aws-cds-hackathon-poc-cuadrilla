// `WorkOrders` repository, the order and its checklist: creation with the five `CHECK#` items in one
// transaction, the installer's and the operator's day (GSI1, GSI2), status transitions with history,
// dispatch changes that move the GSI keys, ONU readings and conditional checklist transitions.
// Evidence, validations, steps and the certificate are in dynamo/evidence.ts.
import { ChecklistItem } from "@cuadrilla/shared";
import { ChecklistEntry, WorkOrder } from "../../domain/work-orders";
import { CHECK_PREFIX, installerDayKey, ispDayKey, workOrderKey, workOrderPartition } from "../keys";
import type { ChecklistGuard, WorkOrdersPort } from "../ports-data";
import type { Patch, TransactOp, WriteCondition } from "../table-client";
import { entityRow, getEntity, listPrefix, nowIso, parseRows, patchEntity, patchRow, requireEntity, upsertEntity, withHistory, type RepoContext } from "./repo";

const TABLE = "WorkOrders";

type OrderPart = Pick<
  WorkOrdersPort,
  | "getWorkOrder"
  | "requireWorkOrder"
  | "createWorkOrder"
  | "listInstallerDay"
  | "listIspDay"
  | "setStatus"
  | "updateWorkOrder"
  | "recordOnuReading"
  | "setOnHoldSafety"
  | "bumpSessionEpoch"
  | "listChecklist"
  | "getChecklistItem"
  | "putChecklistItem"
  | "updateChecklistItem"
>;

function checklistCondition(version: number, guard: ChecklistGuard): WriteCondition {
  return {
    ifVersion: guard.expectedVersion ?? version,
    ...(guard.expectedStatus === undefined ? {} : { oneOf: { status: guard.expectedStatus } }),
  };
}

export function workOrdersRepo(ctx: RepoContext): OrderPart {
  const { client } = ctx;
  const requireWorkOrder = (workOrderId: string): Promise<WorkOrder> => requireEntity(ctx, WorkOrder, "WorkOrder", { workOrderId }, `work order ${workOrderId}`);

  return {
    getWorkOrder: (workOrderId) => getEntity(ctx, WorkOrder, "WorkOrder", { workOrderId }),
    requireWorkOrder,

    async createWorkOrder(workOrder, options = {}) {
      const order = entityRow(ctx, WorkOrder, "WorkOrder", workOrder);
      const ops: TransactOp[] = [{ op: "put", table: TABLE, item: order.item, condition: { ifNotExists: true } }];
      if (options.checklist !== false) {
        for (const item of ChecklistItem.options) {
          const entry = entityRow(ctx, ChecklistEntry, "ChecklistItem", { workOrderId: workOrder.workOrderId, clockId: workOrder.clockId, item, status: "PENDING" });
          ops.push({ op: "put", table: TABLE, item: entry.item, condition: { ifNotExists: true } });
        }
      }
      await client.transact(ops, nowIso(ctx));
      return order.value;
    },

    async listInstallerDay(installerId, date) {
      return parseRows(WorkOrder, await client.query(TABLE, { index: "GSI1", hashValue: installerDayKey(installerId, date) }), TABLE);
    },
    async listIspDay(ispId, date, status) {
      const rows = await client.query(TABLE, { index: "GSI2", hashValue: ispDayKey(ispId, date), ...(status === undefined ? {} : { range: { eq: status } }) });
      return parseRows(WorkOrder, rows, TABLE);
    },

    async setStatus(workOrderId, to, transition, guard = {}) {
      const current = await requireWorkOrder(workOrderId);
      const history = withHistory(ctx, current.history, "status", current.status, to, transition);
      const patch: Patch = { status: to, history, ...(to === "CLOSED" && transition.atSim !== undefined ? { closedAtSim: transition.atSim } : {}) };
      return patchEntity(ctx, WorkOrder, "WorkOrder", current, patch, {
        ifVersion: guard.expectedVersion ?? current.version,
        ...(guard.from === undefined ? {} : { oneOf: { status: guard.from } }),
      });
    },

    async updateWorkOrder(workOrderId, patch, options = {}) {
      const current = await requireWorkOrder(workOrderId);
      return patchEntity(ctx, WorkOrder, "WorkOrder", current, { ...patch }, { ifVersion: options.expectedVersion ?? current.version });
    },

    // Readings and session epochs never race with a meaningful transition: no version pin.
    recordOnuReading: (workOrderId, reading) => patchRow(ctx, TABLE, WorkOrder, workOrderKey(workOrderId), { lastOnuReading: reading }, { ifExists: true }),

    async setOnHoldSafety(workOrderId, onHold, transition) {
      const current = await requireWorkOrder(workOrderId);
      const history = withHistory(ctx, current.history, "onHoldSafety", current.onHoldSafety, onHold, transition);
      return patchEntity(ctx, WorkOrder, "WorkOrder", current, { onHoldSafety: onHold, history });
    },

    async bumpSessionEpoch(workOrderId) {
      const current = await requireWorkOrder(workOrderId);
      return patchEntity(ctx, WorkOrder, "WorkOrder", current, { sessionEpoch: current.sessionEpoch + 1 });
    },

    listChecklist: (workOrderId) => listPrefix(ctx, TABLE, ChecklistEntry, workOrderPartition(workOrderId), CHECK_PREFIX),
    getChecklistItem: (workOrderId, item) => getEntity(ctx, ChecklistEntry, "ChecklistItem", { workOrderId, item }),
    putChecklistItem: (entry) => upsertEntity(ctx, ChecklistEntry, "ChecklistItem", entry),

    async updateChecklistItem(workOrderId, item, change, transition, guard = {}) {
      const current = await requireEntity(ctx, ChecklistEntry, "ChecklistItem", { workOrderId, item }, `checklist item ${item} of ${workOrderId}`);
      const patch: Patch = {
        lastRejectReason: change.lastRejectReason,
        validationId: change.validationId,
        evidenceId: change.evidenceId,
        override: change.override,
        updatedAtSim: change.updatedAtSim ?? transition.atSim,
      };
      if (change.addAttempts !== undefined) patch.attempts = current.attempts + change.addAttempts;
      if (change.status !== undefined) {
        patch.status = change.status;
        if (change.status !== current.status) patch.history = withHistory(ctx, current.history, "status", current.status, change.status, transition);
      }
      return patchEntity(ctx, ChecklistEntry, "ChecklistItem", current, patch, checklistCondition(current.version, guard));
    },
  };
}
