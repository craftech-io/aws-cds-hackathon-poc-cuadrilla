// "Tomar caso" and "No puedo" (docs/design-brief.md §5.8, `take_case` / `decline_case`, `LAD-TAKE`,
// `LAD-DECLINE`). A take wins only while the case is OPEN (a conditional write: the first supervisor
// wins, FL-062); it cancels the rung's wait, sends the supervisor the `CASE_BRIEF` (the verified
// summary, up to three photos of the order and "Cerrar caso") and tells the installer who took it; from
// then on the bridge carries what each one writes. A late or lost take gets "Ya lo tomó …" (only if
// that supervisor's window is open, which the policy decides) and `CASE_TAKE_LOST`; a tap on a closed
// case gets the fixed "ya está cerrado". "No puedo" moves the ladder on without waiting (ladder.ts).
import { ConnectorError } from "@cuadrilla/shared";
import { esMX } from "../copy/es-MX";
import type { Case } from "../domain/cases";
import type { Actor } from "../domain/common";
import { caseLabelOf } from "../channels/whatsapp/routing";
import { type LadderResult, advanceLadder, rungContextBase } from "./ladder";
import { caseMessageId, noticeInstaller } from "./notify";
import type { CaseDeps, CaseSendOutcome } from "./ports";
import { cancelRungTimeouts } from "./timeouts";
import { BRIEF_IMAGES } from "./open";

/** Who acts on a case: a supervisor by WhatsApp (their tap) or a console user (`SUPERVISOR`/`GUEST`). */
export type CaseActor = { readonly via: "WHATSAPP"; readonly supervisorId: string } | { readonly via: "CONSOLE"; readonly userId: string; readonly supervisorId?: string };

export interface CaseActionInput {
  readonly caseId: string;
  readonly actor: CaseActor;
  /** Simulated instant of the tap or the console action. */
  readonly atSim: string;
  /** The tap's inbound message (a reply to it is exempt from quiet hours). */
  readonly sourceMessageId?: string;
}

export type TakeOutcome = "TAKEN" | "TAKE_LOST" | "ALREADY_CLOSED";

export interface TakeResult {
  readonly outcome: TakeOutcome;
  readonly caseItem: Case;
}

export function actorOfCase(actor: CaseActor): Actor {
  return actor.via === "WHATSAPP" ? `PERSON:${actor.supervisorId}` : `USER:${actor.userId}`;
}

/** The person who holds a taken case: the supervisor, or the console user acting as one. */
function takerOf(actor: CaseActor): string | undefined {
  return actor.supervisorId;
}

async function auditCase(deps: CaseDeps, caseItem: Case, input: CaseActionInput, action: string, ruleIds: string[], detail: Record<string, unknown> = {}): Promise<void> {
  await deps.connector.audit.append({
    ispId: caseItem.ispId,
    clockId: caseItem.clockId,
    atSim: input.atSim,
    decision: "ACTION",
    action,
    ruleIds,
    actor: actorOfCase(input.actor),
    refs: { caseId: caseItem.caseId, workOrderId: caseItem.workOrderId, ...(input.sourceMessageId === undefined ? {} : { messageId: input.sourceMessageId }) },
    detail,
  });
}

/** A fixed reply to the supervisor who tapped (never to a console user). */
async function replyToSupervisor(deps: CaseDeps, caseItem: Case, input: CaseActionInput, kind: "CASE_TAKEN_NOTICE" | "SYSTEM_NOTICE", text: string, tag: string, notice?: string): Promise<CaseSendOutcome | undefined> {
  if (input.actor.via !== "WHATSAPP") return undefined;
  return deps.outbound.sendWhatsApp({
    clockId: caseItem.clockId,
    ispId: caseItem.ispId,
    personId: input.actor.supervisorId,
    kind,
    author: "SYSTEM",
    caseId: caseItem.caseId,
    workOrderId: caseItem.workOrderId,
    atSim: input.atSim,
    form: "TEXT",
    text,
    inResponseToInbound: true,
    messageId: caseMessageId(caseItem.caseId, tag, input.actor.supervisorId),
    ...(notice === undefined ? {} : { notice }),
    refs: { caseId: caseItem.caseId },
  });
}

/** `CASE_BRIEF`: the summary with "Cerrar caso", then up to three photos of the order. */
export async function sendCaseBrief(deps: CaseDeps, caseItem: Case, supervisorId: string, atSim: string): Promise<CaseSendOutcome> {
  const { workOrder, installer, reasonText } = await rungContextBase(deps, caseItem);
  const base = { clockId: caseItem.clockId, ispId: caseItem.ispId, personId: supervisorId, kind: "CASE_BRIEF", author: "SYSTEM", caseId: caseItem.caseId, workOrderId: caseItem.workOrderId, atSim } as const;
  const text = esMX.caseBrief({ caseLabel: caseLabelOf(caseItem.caseId), workOrderNumber: workOrder.workOrderNumber, installerFirstName: installer.firstName, reasonText, summary: caseItem.summary });
  const brief = await deps.outbound.sendWhatsApp({
    ...base,
    form: "INTERACTIVE",
    text,
    buttons: [{ action: "CLOSE_CASE", object: { kind: "CASE", id: caseItem.caseId } }],
    inResponseToInbound: true,
    messageId: caseMessageId(caseItem.caseId, "brief", supervisorId),
    refs: { caseId: caseItem.caseId },
  });
  if (brief.status === "DENIED") return brief;
  const evidence = await deps.connector.workOrders.listEvidence(caseItem.workOrderId);
  const wanted = caseItem.evidenceIds.length > 0 ? evidence.filter((item) => caseItem.evidenceIds.includes(item.evidenceId)) : evidence;
  for (const [index, photo] of wanted.slice(0, BRIEF_IMAGES).entries()) {
    await deps.outbound.sendWhatsApp({
      ...base,
      form: "IMAGE",
      media: { bucket: "EVIDENCE", s3Key: photo.s3Key, mime: photo.mime },
      inResponseToInbound: true,
      messageId: caseMessageId(caseItem.caseId, "brief", supervisorId, index + 1),
      refs: { caseId: caseItem.caseId, evidenceId: photo.evidenceId, item: photo.item },
    });
  }
  return brief;
}

async function lost(deps: CaseDeps, current: Case, input: CaseActionInput): Promise<TakeResult> {
  if (current.status === "CLOSED") {
    await replyToSupervisor(deps, current, input, "SYSTEM_NOTICE", esMX.caseAlreadyClosed, "closed", "caseAlreadyClosed");
    await auditCase(deps, current, input, "CASE_TAKE_LOST", ["LAD-TAKE"], { status: "CLOSED" });
    return { outcome: "ALREADY_CLOSED", caseItem: current };
  }
  const holder = current.takenBy === undefined ? undefined : await deps.connector.people.getPerson(current.takenBy);
  if (holder !== undefined && current.takenBy !== takerOf(input.actor)) await replyToSupervisor(deps, current, input, "CASE_TAKEN_NOTICE", esMX.caseTakenByOther(holder.firstName), "lost");
  await auditCase(deps, current, input, "CASE_TAKE_LOST", ["LAD-TAKE"], { status: current.status });
  return { outcome: "TAKE_LOST", caseItem: current };
}

/** `take_case`: the first supervisor wins while the case is OPEN. */
export async function takeCase(deps: CaseDeps, input: CaseActionInput): Promise<TakeResult> {
  const current = await deps.connector.cases.requireCase(input.caseId);
  const supervisorId = takerOf(input.actor);
  if (supervisorId === undefined) throw new RangeError("a case is taken by a supervisor");
  if (current.status !== "OPEN") return lost(deps, current, input);
  let taken: Case;
  try {
    taken = await deps.connector.cases.takeCase(input.caseId, supervisorId, { actor: actorOfCase(input.actor), atSim: input.atSim, reason: input.actor.via });
  } catch (error) {
    if (error instanceof ConnectorError && error.code === "CONFLICT") return lost(deps, await deps.connector.cases.requireCase(input.caseId), input);
    throw error;
  }
  await cancelRungTimeouts(deps, taken.caseId, "taken");
  await auditCase(deps, taken, input, "CASE_TAKEN", ["LAD-TAKE"], { rung: taken.rung, via: input.actor.via });
  const supervisor = await deps.connector.people.getPerson(supervisorId);
  await sendCaseBrief(deps, taken, supervisorId, input.atSim);
  await noticeInstaller(deps, taken, esMX.caseTaken(supervisor?.firstName ?? ""), input.atSim, `taken-${supervisorId}`);
  return { outcome: "TAKEN", caseItem: taken };
}

/** `decline_case`: "No puedo" of the rung's supervisor moves the ladder on; any other tap is stale. */
export async function declineCase(deps: CaseDeps, input: CaseActionInput & { readonly rungVersion?: number }): Promise<LadderResult> {
  const supervisorId = takerOf(input.actor);
  if (supervisorId === undefined) throw new RangeError("a case is declined by a supervisor");
  const current = await deps.connector.cases.requireCase(input.caseId);
  if (current.status === "CLOSED") await replyToSupervisor(deps, current, input, "SYSTEM_NOTICE", esMX.caseAlreadyClosed, "closed", "caseAlreadyClosed");
  return advanceLadder(deps, input.caseId, { kind: "DECLINED", personId: supervisorId, ...(input.rungVersion === undefined ? {} : { rungVersion: input.rungVersion }) }, input.atSim);
}
