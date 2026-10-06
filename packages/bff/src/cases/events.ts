// What the InstallerWorker runs for the events of a case (docs/architecture.md §7), all in the FIFO
// group of the installer who owns the case (ADR-0017), so a tap, a timeout and a message of the same
// order never run in parallel:
//
//   TIMER CASE_TIMEOUT      `advance_ladder(TIMEOUT, rungVersion)` with the version the timer carries
//   SUPERVISOR_ACTION       "Tomar caso", "No puedo", "Cerrar caso" and the supervisor's messages (relay)
//   INBOUND_MESSAGE         `takenCaseOf` tells the worker the order is on the bridge (`CP-BRIDGE`): the
//                           message goes to `relayFromInstaller` and never to the agent
//
// The timer's payload and the queued event are validated here (zod at every edge).
import { z } from "zod";
import { CaseId, Rung, type TimerFiredBy } from "@cuadrilla/shared";
import { esMX } from "../copy/es-MX";
import type { Case } from "../domain/cases";
import type { Timer } from "../domain/timers";
import type { ChannelQueueEvent } from "../channels/whatsapp/ports";
import { closeCase, relayFromSupervisor } from "./bridge";
import { type LadderResult, advanceLadder } from "./ladder";
import { caseMessageId } from "./notify";
import type { CaseDeps } from "./ports";
import { declineCase, takeCase } from "./take";

/** What `armRungTimeout` puts in a `CASE_TIMEOUT` timer. */
export const CaseTimeoutPayload = z.object({ caseId: CaseId, rung: Rung, rungVersion: z.int().min(0) });
export type CaseTimeoutPayload = z.infer<typeof CaseTimeoutPayload>;

/** A fired `TIMER#CASE_TIMEOUT`: the ladder moves on only if the case is still where the timer left it. */
export async function onCaseTimeout(deps: CaseDeps, timer: Timer, eventAtSim: string, firedBy?: TimerFiredBy): Promise<LadderResult> {
  if (timer.kind !== "CASE_TIMEOUT" || timer.home.kind !== "CASE") throw new RangeError(`not a case timeout: ${timer.kind} on ${timer.home.kind}`);
  const payload = CaseTimeoutPayload.parse(timer.payload);
  if (payload.caseId !== timer.home.id) throw new RangeError("the timeout's payload names another case");
  return advanceLadder(deps, payload.caseId, { kind: "TIMEOUT", rungVersion: payload.rungVersion, ...(firedBy === undefined ? {} : { firedBy }), timerKey: timer.timerId }, eventAtSim);
}

/** The case of an order that is on the bridge (TAKEN), if any. */
export async function takenCaseOf(deps: Pick<CaseDeps, "connector">, workOrderId: string): Promise<Case | undefined> {
  const cases = await deps.connector.cases.listCasesOfWorkOrder(workOrderId);
  return cases.find((item) => item.status === "TAKEN");
}

export type SupervisorActionEvent = Extract<ChannelQueueEvent, { readonly type: "SUPERVISOR_ACTION" }>;

export type SupervisorActionOutcome = "TAKEN" | "TAKE_LOST" | "ALREADY_CLOSED" | "DECLINED" | "STALE" | "CLOSED" | "NOT_HOLDER" | "RELAYED" | "PENDING" | "NO_CASE";

/** Runs a supervisor's tap or message on a case; the worker's idempotency keeps a redelivery from repeating it. */
export async function runSupervisorAction(deps: CaseDeps, event: SupervisorActionEvent): Promise<SupervisorActionOutcome> {
  const message = await deps.connector.conversations.getMessage(event.message);
  if (message === undefined) throw new RangeError(`message ${event.message.messageId} of the supervisor action is gone`);
  const input = { caseId: event.caseId, actor: { via: "WHATSAPP", supervisorId: event.supervisorId } as const, atSim: message.sentAtSim, sourceMessageId: message.messageId };
  switch (event.action) {
    case "TAKE_CASE":
      return (await takeCase(deps, input)).outcome;
    case "DECLINE_CASE": {
      const result = await declineCase(deps, input);
      return result.status === "MOVED" ? "DECLINED" : "STALE";
    }
    case "CLOSE_CASE":
      return (await closeCase(deps, input)).outcome;
    case "RELAY": {
      const relayed = await relayFromSupervisor(deps, event.caseId, message);
      if (relayed === "RELAYED" || relayed === "PENDING") return relayed;
      await deps.outbound.sendWhatsApp({
        clockId: event.clockId,
        ispId: event.ispId,
        personId: event.supervisorId,
        kind: "SYSTEM_NOTICE",
        notice: "supervisorNoCase",
        author: "SYSTEM",
        atSim: message.sentAtSim,
        form: "TEXT",
        text: esMX.supervisorNoCase,
        inResponseToInbound: true,
        messageId: caseMessageId(event.caseId, "no-case", message.messageId.replace(/[^A-Za-z0-9_.:=+/-]/g, "").slice(-80)),
      });
      return "NO_CASE";
    }
  }
}
