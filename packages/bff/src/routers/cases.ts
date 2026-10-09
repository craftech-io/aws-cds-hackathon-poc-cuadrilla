// `cases` router of the console (docs/tool-catalog.md; FL-065): the inbox of the world's cases and the
// detail of one with its ladder and bridge; "Tomar" and "Cerrar" for the roles that act.
//
//   list    by status and reason, newest first (every role of the operator)
//   get     the case with each rung of its ladder (notified, timed out, skipped and why, taken), the
//           timeout still pending, the bridge and its messages in both threads (every role)
//   take    S: queues the same `take_case` a supervisor's button runs, in the installer's group
//           (services/case-console); the console never changes the case itself
//   close   S: the same for `close_case`, by the supervisor who holds it
//
// `OPS` sees and never acts: `supervisorProcedure` refuses it before the service does.
import { z } from "zod";
import { CaseId, CaseReason, CaseStatus } from "@cuadrilla/shared";
import type { Case } from "../domain/cases";
import type { Message } from "../domain/conversations";
import { requestCaseAction } from "../services/case-console/case-actions";
import { consoleCall, inWorldTime, ownRow } from "./console-ports";
import { type IspContext, ispProcedure, router, supervisorProcedure } from "./trpc";

const ListInput = z.object({ status: CaseStatus.optional(), reason: CaseReason.optional() }).strict().optional();
const ByCase = z.object({ caseId: CaseId }).strict();

type Ctx = Pick<IspContext, "deps" | "world" | "principal">;

async function namesOf(ctx: Ctx, ids: readonly (string | undefined)[]): Promise<Record<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => id !== undefined))];
  const people = await Promise.all(unique.map((id) => ctx.deps.connector.people.getPerson(id)));
  return Object.fromEntries(people.flatMap((person) => (person === undefined || person.clockId !== ctx.world.clockId ? [] : [[person.personId, `${person.firstName} ${person.lastName}`.trim()]])));
}

function summaryOf(found: Case, names: Record<string, string>, workOrderNumber: string | undefined) {
  return {
    caseId: found.caseId,
    workOrderId: found.workOrderId,
    workOrderNumber: workOrderNumber ?? null,
    installer: names[found.installerId] ?? null,
    kind: found.kind,
    reason: found.reason,
    status: found.status,
    rung: found.rung,
    takenBy: found.takenBy === undefined ? null : (names[found.takenBy] ?? null),
    createdAtSim: found.createdAtSim,
    closedAtSim: found.closedAtSim ?? null,
  };
}

async function listCases(ctx: Ctx, input: z.infer<typeof ListInput>) {
  const statuses = input?.status === undefined ? CaseStatus.options : [input.status];
  const found = (await Promise.all(statuses.map((status) => ctx.deps.connector.cases.listCasesByStatus(ctx.world.ispId, status))))
    .flat()
    .filter((row) => row.clockId === ctx.world.clockId && (input?.reason === undefined || row.reason === input.reason));
  const names = await namesOf(ctx, found.flatMap((row) => [row.installerId, row.takenBy]));
  const orders = await Promise.all([...new Set(found.map((row) => row.workOrderId))].map((id) => ctx.deps.connector.workOrders.getWorkOrder(id)));
  const numbers = new Map(orders.flatMap((order) => (order === undefined ? [] : [[order.workOrderId, order.workOrderNumber] as const])));
  return found.sort((a, b) => b.createdAtSim.localeCompare(a.createdAtSim)).map((row) => summaryOf(row, names, numbers.get(row.workOrderId)));
}

function bridgeMessages(messages: readonly Message[], caseId: string) {
  return messages
    .filter((message) => message.caseId === caseId)
    .map((message) => ({
      messageId: message.messageId,
      personId: message.personId,
      direction: message.direction,
      kind: message.kind ?? null,
      content: message.content,
      text: message.text ?? null,
      templateName: message.templateName ?? null,
      status: message.status,
      sentAtSim: message.sentAtSim,
    }));
}

async function caseDetail(ctx: Ctx, caseId: string) {
  const data = ctx.deps.connector;
  const found = ownRow(ctx, await data.cases.getCase(caseId), "case");
  const holders = [found.installerId, found.takenBy, found.roster.primaryId, found.roster.secondaryId, found.roster.zoneChiefId, ...found.ladder.map((entry) => entry.personId)];
  const [names, order, timers, installerThread, holderThread] = await Promise.all([
    namesOf(ctx, holders),
    data.workOrders.getWorkOrder(found.workOrderId),
    data.timers.listTimers({ kind: "CASE", id: found.caseId }),
    data.conversations.listMessages(found.installerId),
    found.takenBy === undefined ? Promise.resolve([]) : data.conversations.listMessages(found.takenBy),
  ]);
  const pendingTimeout = timers.find((timer) => timer.kind === "CASE_TIMEOUT" && timer.status === "SCHEDULED");
  return {
    ...summaryOf(found, names, order?.workOrderNumber),
    summary: found.summary,
    hazardCategory: found.hazardCategory ?? null,
    roster: {
      primary: found.roster.primaryId === undefined ? null : (names[found.roster.primaryId] ?? null),
      secondary: found.roster.secondaryId === undefined ? null : (names[found.roster.secondaryId] ?? null),
      zoneChief: found.roster.zoneChiefId === undefined ? null : (names[found.roster.zoneChiefId] ?? null),
    },
    ladder: found.ladder.map((entry) => ({ ...entry, person: entry.personId === undefined ? null : (names[entry.personId] ?? null) })),
    pendingTimeout: pendingTimeout === undefined ? null : { dueAtSim: pendingTimeout.dueAtSim, rung: found.rung },
    bridge: { open: found.bridge.open, pendingRelays: found.bridge.pendingRelays.length },
    messages: [...bridgeMessages(installerThread, found.caseId), ...bridgeMessages(holderThread, found.caseId)].sort((a, b) => a.sentAtSim.localeCompare(b.sentAtSim)),
    closeSummary: found.closeSummary ?? null,
    evidenceIds: found.evidenceIds,
  };
}

async function act(ctx: Pick<IspContext, "deps" | "principal">, caseId: string, action: "TAKE" | "CLOSE") {
  const { ports, caller } = consoleCall(ctx);
  return requestCaseAction({ ...ports.services, queue: ports.queue }, caller, { caseId, action });
}

export const casesRouter = router({
  list: ispProcedure.input(ListInput).query(async ({ ctx, input }) => inWorldTime(ctx, await listCases(ctx, input))),
  get: ispProcedure.input(ByCase).query(async ({ ctx, input }) => inWorldTime(ctx, await caseDetail(ctx, input.caseId))),
  take: supervisorProcedure.input(ByCase).mutation(({ ctx, input }) => act(ctx, input.caseId, "TAKE")),
  close: supervisorProcedure.input(ByCase).mutation(({ ctx, input }) => act(ctx, input.caseId, "CLOSE")),
});
