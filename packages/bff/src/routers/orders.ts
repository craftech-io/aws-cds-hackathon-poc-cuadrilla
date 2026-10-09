// `orders` router of the console (docs/tool-catalog.md; FL-080): the orders of the world's day and the
// detail of one, for every role of the principal's operator (`ispProcedure`).
//
//   list            the day (the world's simulated day unless asked), filtered by crew, status and open
//                   cases; work order 24817 of the world comes pinned as the main story
//   get             the order with its installer, customer (fictitious; never phone or email), zone
//                   range, checklist with who validated by hand, cases, certificate and its deliveries
//   timeline        WhatsApp in and out (transcripts, citations, decisions), emails, turn notes,
//                   validations, steps and the order's decisions by simulated time, plus what is still
//                   pending (the order's timers and deferred messages, with their reason)
//   mediaUrl        GET link of 5 minutes of an audio or photo of the order (a message of its timeline
//                   or an evidence), with the content type fixed by the code
//   certificateUrl  GET link of 5 minutes of the order's certificate, as a download
//   onuStatus       the ONU right now from the simulated network (`get_onu_status` of the console)
//
// Every id of the input passed the operator fence (trpc.ts); a row of another world reads as missing.
// Keys of S3 never leave the BFF: only presigned links.
import { z } from "zod";
import { CalendarDate, CrewId, EvidenceId, ToolError, WorkOrderId, WorkOrderStatus } from "@cuadrilla/shared";
import type { Case } from "../domain/cases";
import type { Message, OutboundEmail, TurnNote } from "../domain/conversations";
import type { Person } from "../domain/people";
import type { WorkOrder } from "../domain/work-orders";
import { PolicyRefs, POLICY_REFS_KEY } from "../policy/as-of";
import { consoleCall, inWorldTime, ownRow, worldToday } from "./console-ports";
import { type IspContext, ispProcedure, router } from "./trpc";

/** The main story's order: pinned first in every world that has it (docs/design-brief.md §6). */
export const MAIN_STORY_ORDER_NUMBER = "24817";

const ListInput = z
  .object({ day: CalendarDate.optional(), crewId: CrewId.optional(), status: WorkOrderStatus.optional(), openCases: z.boolean().optional() })
  .strict()
  .optional();
const ByOrder = z.object({ workOrderId: WorkOrderId }).strict();
const MediaInput = z.union([z.object({ workOrderId: WorkOrderId, messageId: z.string().min(1).max(200) }).strict(), z.object({ workOrderId: WorkOrderId, evidenceId: EvidenceId }).strict()]);

type Ctx = Pick<IspContext, "deps" | "world" | "principal" | "log">;

const OPEN_CASE = new Set<Case["status"]>(["OPEN", "TAKEN"]);

function personName(person: Person | undefined): { readonly personId?: string; readonly firstName: string; readonly lastName: string } {
  return person === undefined ? { firstName: "—", lastName: "" } : { personId: person.personId, firstName: person.firstName, lastName: person.lastName };
}

async function orderOf(ctx: Ctx, workOrderId: string): Promise<WorkOrder> {
  return ownRow(ctx, await ctx.deps.connector.workOrders.getWorkOrder(workOrderId), "work order");
}

async function rowOf(ctx: Ctx, order: WorkOrder) {
  const data = ctx.deps.connector;
  const [installer, customer, checklist, cases] = await Promise.all([
    data.people.getPerson(order.installerId),
    data.people.getCustomer(order.customerId),
    data.workOrders.listChecklist(order.workOrderId),
    data.cases.listCasesOfWorkOrder(order.workOrderId),
  ]);
  return {
    workOrderId: order.workOrderId,
    workOrderNumber: order.workOrderNumber,
    status: order.status,
    crewId: order.crewId,
    installer: personName(installer),
    customer: customer === undefined ? null : { firstName: customer.firstName, lastName: customer.lastName, neighborhood: customer.neighborhood },
    window: order.appointmentWindow,
    plan: order.plan,
    checklist: checklist.map((entry) => ({ item: entry.item, status: entry.status })),
    onu: order.lastOnuReading ?? null,
    openCases: cases.filter((found) => OPEN_CASE.has(found.status)).length,
    onHoldSafety: order.onHoldSafety,
    mainStory: order.workOrderNumber === MAIN_STORY_ORDER_NUMBER,
  };
}

async function listOrders(ctx: Ctx, input: z.infer<typeof ListInput>) {
  const today = await worldToday(ctx);
  const day = input?.day ?? today.day;
  const orders = (await ctx.deps.connector.workOrders.listIspDay(ctx.world.ispId, day, input?.status)).filter(
    (order) => order.clockId === ctx.world.clockId && (input?.crewId === undefined || order.crewId === input.crewId),
  );
  const rows = await Promise.all(orders.map((order) => rowOf(ctx, order)));
  const filtered = input?.openCases === undefined ? rows : rows.filter((row) => (row.openCases > 0) === input.openCases);
  // The main story first, then by appointment.
  filtered.sort((a, b) => Number(b.mainStory) - Number(a.mainStory) || a.window.startSim.localeCompare(b.window.startSim));
  return { day, simNow: today.simNow, workOrders: filtered };
}

async function detailOf(ctx: Ctx, workOrderId: string) {
  const data = ctx.deps.connector;
  const order = await orderOf(ctx, workOrderId);
  const [row, customer, zone, checklist, cases, certificate, validations, steps, users] = await Promise.all([
    rowOf(ctx, order),
    data.people.getCustomer(order.customerId),
    data.isps.getZone(order.ispId, order.zoneId),
    data.workOrders.listChecklist(order.workOrderId),
    data.cases.listCasesOfWorkOrder(order.workOrderId),
    data.workOrders.getCertificate(order.workOrderId),
    data.workOrders.listValidations(order.workOrderId),
    data.workOrders.listSteps(order.workOrderId),
    data.isps.listUsers(order.ispId),
  ]);
  const userName = (userId: string) => users.find((user) => user.userId === userId)?.name ?? userId;
  return {
    ...row,
    onuSerial: order.onuSerial,
    onuModel: order.onuModel,
    oltPort: order.oltPort,
    opticalClass: order.opticalClass,
    customer: customer === undefined ? null : { firstName: customer.firstName, lastName: customer.lastName, addressLine: customer.addressLine, neighborhood: customer.neighborhood },
    acceptanceRange: zone?.acceptanceRange ?? null,
    checklist: checklist.map((entry) => ({
      item: entry.item,
      status: entry.status,
      attempts: entry.attempts,
      lastRejectReason: entry.lastRejectReason ?? null,
      validationId: entry.validationId ?? null,
      evidenceId: entry.evidenceId ?? null,
      override: entry.override === undefined ? null : { by: userName(entry.override.userId), reason: entry.override.reason, atSim: entry.override.atSim },
    })),
    validations: validations.map((found) => ({
      validationId: found.validationId,
      item: found.item,
      verdict: found.verdict,
      reasonCode: found.reasonCode ?? null,
      checks: found.checks,
      evidenceId: found.evidenceId ?? null,
      atSim: found.atSim,
      seeded: found.source === "SEED",
    })),
    steps: steps.map((step) => ({ seq: step.seq, symptom: step.symptom, stepRef: step.stepRef, outcome: step.outcome, recordedAtSim: step.recordedAtSim })),
    cases: cases.map((found) => ({ caseId: found.caseId, kind: found.kind, reason: found.reason, status: found.status, rung: found.rung, createdAtSim: found.createdAtSim })),
    certificate:
      certificate === undefined
        ? null
        : { certificateId: certificate.certificateId, n: certificate.n, issuedAtSim: certificate.issuedAtSim, available: certificate.s3Key !== undefined, sha256: certificate.sha256 ?? null, deliveries: certificate.deliveries },
    closedAtSim: order.closedAtSim ?? null,
    failedReason: order.failedReason ?? null,
  };
}

function citationsOf(message: Message): string[] {
  const refs = PolicyRefs.safeParse(message.refs?.[POLICY_REFS_KEY]);
  return refs.success ? (refs.data.citations ?? []) : [];
}

function isMessage(entry: Message | OutboundEmail | TurnNote): entry is Message {
  return "direction" in entry;
}

function isMail(entry: Message | OutboundEmail | TurnNote): entry is OutboundEmail {
  return "mailId" in entry;
}

async function timelineOf(ctx: Ctx, workOrderId: string) {
  const data = ctx.deps.connector;
  const order = await orderOf(ctx, workOrderId);
  const [entries, decisions, validations, steps, timers] = await Promise.all([
    data.conversations.listTimeline(order.workOrderId),
    data.audit.listByWorkOrder(order.workOrderId),
    data.workOrders.listValidations(order.workOrderId),
    data.workOrders.listSteps(order.workOrderId),
    data.timers.listTimers({ kind: "WORK_ORDER", id: order.workOrderId }),
  ]);
  const items = [
    ...entries.map((entry) => {
      if (isMessage(entry)) {
        return {
          type: "MESSAGE" as const,
          atSim: entry.sentAtSim,
          messageId: entry.messageId,
          personId: entry.personId,
          direction: entry.direction,
          content: entry.content,
          kind: entry.kind ?? null,
          author: entry.author,
          text: entry.text ?? null,
          templateName: entry.templateName ?? null,
          buttonAction: entry.buttonAction ?? null,
          transcript: entry.transcript ?? null,
          hasMedia: entry.media !== undefined,
          mediaKind: entry.media?.kind ?? null,
          status: entry.status,
          citations: citationsOf(entry),
          ruleIds: entry.policy?.ruleIds ?? [],
          decision: entry.policy?.decision ?? null,
          simulated: entry.simulated,
        };
      }
      if (isMail(entry)) {
        return { type: "EMAIL" as const, atSim: entry.sentAtSim, mailId: entry.mailId, kind: entry.kind, toRole: entry.toRole, subject: entry.subject, status: entry.status, events: entry.events, hasAttachment: entry.attachment !== undefined };
      }
      return { type: "TURN_NOTE" as const, atSim: entry.atSim, turnId: entry.turnId, trigger: entry.trigger, note: entry.note, stopReason: entry.stopReason ?? null, agentMode: entry.agentMode };
    }),
    ...validations.map((found) => ({ type: "VALIDATION" as const, atSim: found.atSim, validationId: found.validationId, item: found.item, verdict: found.verdict, reasonCode: found.reasonCode ?? null, checks: found.checks, evidenceId: found.evidenceId ?? null })),
    ...steps.map((step) => ({ type: "STEP" as const, atSim: step.recordedAtSim, seq: step.seq, symptom: step.symptom, stepRef: step.stepRef, outcome: step.outcome })),
    ...decisions.map((row) => ({
      type: "DECISION" as const,
      atSim: row.atSim ?? row.ts,
      decisionId: row.decisionId,
      decision: row.decision,
      action: row.action,
      ruleIds: row.ruleIds,
      trigger: row.trigger ?? null,
      actor: row.actor,
      reason: row.reason ?? null,
    })),
  ].sort((a, b) => Date.parse(a.atSim) - Date.parse(b.atSim));
  const pending = [
    ...timers.filter((timer) => timer.status === "SCHEDULED").map((timer) => ({ kind: timer.kind, dueAtSim: timer.dueAtSim, reason: timer.reason ?? null })),
    ...entries.filter((entry): entry is Message => isMessage(entry) && entry.status === "DEFERRED").map((entry) => ({ kind: "DEFERRED_SEND" as const, dueAtSim: entry.sentAtSim, reason: entry.policy?.ruleIds.join(", ") ?? null })),
  ];
  return { workOrderId: order.workOrderId, entries: items, pending };
}

async function mediaUrlOf(ctx: Ctx, input: z.infer<typeof MediaInput>) {
  const order = await orderOf(ctx, input.workOrderId);
  const { ports } = consoleCall(ctx);
  if ("evidenceId" in input) {
    const evidence = await ctx.deps.connector.workOrders.getEvidence(order.workOrderId, input.evidenceId);
    if (evidence === undefined || evidence.clockId !== ctx.world.clockId) throw new ToolError("NOT_FOUND", "evidence not found");
    return { url: await ports.objects.presignGet({ bucket: "Evidence", key: evidence.s3Key, contentType: "image/jpeg" }), contentType: "image/jpeg" };
  }
  const message = (await ctx.deps.connector.conversations.listTimeline(order.workOrderId)).find((entry): entry is Message => isMessage(entry) && entry.messageId === input.messageId);
  if (message?.media === undefined || message.clockId !== ctx.world.clockId) throw new ToolError("NOT_FOUND", "media not found");
  const contentType = message.media.kind === "AUDIO" ? message.media.mime : message.media.kind === "IMAGE" ? message.media.mime : "application/pdf";
  const bucket = message.media.kind === "DOCUMENT" ? "Evidence" : "Media";
  return { url: await ports.objects.presignGet({ bucket, key: message.media.s3Key, contentType }), contentType };
}

async function certificateUrlOf(ctx: Ctx, workOrderId: string) {
  const order = await orderOf(ctx, workOrderId);
  const certificate = await ctx.deps.connector.workOrders.getCertificate(order.workOrderId);
  if (certificate?.s3Key === undefined) throw new ToolError("NOT_FOUND", "the order has no certificate yet");
  const { ports } = consoleCall(ctx);
  const url = await ports.objects.presignGet({ bucket: "Evidence", key: certificate.s3Key, contentType: "application/pdf", download: `acta-${order.workOrderNumber}-${certificate.n}.pdf` });
  return { url, sha256: certificate.sha256 ?? null };
}

async function onuStatusOf(ctx: Ctx, workOrderId: string) {
  const order = await orderOf(ctx, workOrderId);
  const { ports } = consoleCall(ctx);
  const [today, zone] = await Promise.all([worldToday(ctx), ctx.deps.connector.isps.getZone(order.ispId, order.zoneId)]);
  const outcome = await ports.network.getOnuStatus({ clockId: ctx.world.clockId, serial: order.onuSerial, caller: ctx.principal.origin === "QA" ? "QA" : "CONSOLE", atSim: today.simNow, logger: ctx.log });
  if (outcome.kind === "NOT_FOUND") throw new ToolError("NOT_FOUND", "the order's ONU is not in the simulated network");
  if (outcome.kind === "UNAVAILABLE") return { available: false as const, reason: outcome.reason };
  const { operState, rxPowerDbm, txPowerDbm, observedAt } = outcome.value;
  const range = zone?.acceptanceRange;
  const inRange = operState === "ONLINE" && rxPowerDbm !== undefined && range !== undefined && rxPowerDbm >= range.minDbm && rxPowerDbm <= range.maxDbm;
  return { available: true as const, operState, rxPowerDbm: rxPowerDbm ?? null, txPowerDbm: txPowerDbm ?? null, inRange, acceptanceRange: range ?? null, observedAt };
}

export const ordersRouter = router({
  list: ispProcedure.input(ListInput).query(async ({ ctx, input }) => inWorldTime(ctx, await listOrders(ctx, input))),
  get: ispProcedure.input(ByOrder).query(async ({ ctx, input }) => inWorldTime(ctx, await detailOf(ctx, input.workOrderId))),
  timeline: ispProcedure.input(ByOrder).query(async ({ ctx, input }) => inWorldTime(ctx, await timelineOf(ctx, input.workOrderId))),
  mediaUrl: ispProcedure.input(MediaInput).query(({ ctx, input }) => mediaUrlOf(ctx, input)),
  certificateUrl: ispProcedure.input(ByOrder).query(({ ctx, input }) => certificateUrlOf(ctx, input.workOrderId)),
  onuStatus: ispProcedure.input(ByOrder).query(({ ctx, input }) => onuStatusOf(ctx, input.workOrderId)),
});
