// The cases module as the InstallerWorker's ports (worker/ports.ts `CasePort`, `SafetyPort`), inside the
// installer's FIFO group (ADR-0017):
//
//   openCase            `open_case` of a G1 block (`DENIED_TOPIC`, `PROMPT_INJECTION`, `OTHER`) with the
//                       fixed summary the worker built, idempotent by order and reason
//   relayFromInstaller  the installer's message to the supervisor who took the case (`CP-BRIDGE`)
//   supervisorAction    a supervisor's tap or text (cases/events.ts), or the same action ordered from the
//                       console (no message: the actor is the console user, the instant the world's now);
//                       an action armed with an older rung of the ladder is ignored and logged
//   preset              the world factory's `case` preset (cases/preset.ts) for the order of the epoch the
//                       world was loaded with; a later reset or jump makes it stale and it is skipped
//   classify / handle   the lexicon classifier and the fixed §SEG-01 response (safety/, ADR-0016)
import { classifySafety } from "../safety/classifier";
import { handleSafety } from "../safety/handler";
import type { CasePort, SafetyPort, WorkerContext } from "../worker/ports";
import type { SupervisorActionEvent } from "../worker/events";
import { closeCase, relayFromInstaller } from "./bridge";
import { type SupervisorActionEvent as ChannelSupervisorAction, runSupervisorAction } from "./events";
import { openCase } from "./open";
import type { CaseDeps } from "./ports";
import { openPresetCase } from "./preset";
import { type CaseActor, declineCase, takeCase } from "./take";

/** The world's simulated now (channels/whatsapp/ports.ts `connectorWorldTime`). */
export type SimNowReader = (clockId: string) => Promise<string>;

function consoleActor(event: SupervisorActionEvent): CaseActor {
  const user = event.actor?.startsWith("USER:") === true ? event.actor.slice("USER:".length) : "qa";
  return { via: "CONSOLE", userId: user, supervisorId: event.supervisorId };
}

/** A console (or QA) action: no inbound message, the actor is the user, the instant is the world's. */
async function consoleAction(deps: CaseDeps, event: SupervisorActionEvent, atSim: string, ctx: WorkerContext): Promise<string> {
  const input = { caseId: event.caseId, actor: consoleActor(event), atSim };
  switch (event.action) {
    case "TAKE_CASE":
      return (await takeCase(deps, input)).outcome;
    case "DECLINE_CASE":
      return (await declineCase(deps, input)).status;
    case "CLOSE_CASE":
      return (await closeCase(deps, input)).outcome;
    case "RELAY":
      ctx.log.warn("worker.console_relay_without_message", { caseId: event.caseId });
      return "NO_MESSAGE";
  }
}

export function workerCasePort(deps: CaseDeps, simNow: SimNowReader): CasePort {
  return {
    async openCase(request) {
      const opened = await openCase(deps, { workOrderId: request.workOrderId, reason: request.reason, summary: request.summary, atSim: request.atSim, actor: "WORKER" });
      return { caseId: opened.caseItem.caseId };
    },
    async relayFromInstaller(relay, ctx) {
      const caseItem = await deps.connector.cases.getCase(relay.caseId);
      if (caseItem === undefined) {
        ctx.log.warn("worker.relay_case_gone", { caseId: relay.caseId });
        return;
      }
      const outcome = await relayFromInstaller(deps, caseItem, relay.message);
      ctx.log.info("worker.relayed", { caseId: relay.caseId, outcome });
    },
    async supervisorAction(event, ctx) {
      if (event.rungVersion !== undefined) {
        const current = await deps.connector.cases.getCase(event.caseId);
        if (current !== undefined && current.rungVersion !== event.rungVersion) {
          ctx.log.info("worker.supervisor_action_stale", { caseId: event.caseId, action: event.action, rungVersion: event.rungVersion, current: current.rungVersion });
          return;
        }
      }
      const outcome =
        event.message === undefined
          ? await consoleAction(deps, event, await simNow(event.clockId), ctx)
          : await runSupervisorAction(deps, { ...event, message: event.message } as ChannelSupervisorAction);
      ctx.log.info("worker.supervisor_action", { caseId: event.caseId, action: event.action, outcome });
    },
    async preset(event, ctx) {
      const order = await deps.connector.workOrders.getWorkOrder(event.workOrderId);
      if (order === undefined || order.clockId !== event.clockId || order.worldEpoch !== event.worldEpoch) {
        ctx.log.info("worker.case_preset_stale", { workOrderId: event.workOrderId, worldEpoch: event.worldEpoch, current: order?.worldEpoch });
        return;
      }
      const { caseId } = await openPresetCase(deps, { workOrderId: event.workOrderId, reason: event.reason, rung: event.rung, status: event.status, atSim: event.atSim });
      ctx.log.info("worker.case_preset", { caseId, rung: event.rung, status: event.status });
    },
  };
}

export function workerSafetyPort(deps: CaseDeps): SafetyPort {
  return {
    async classify(text) {
      const result = classifySafety(text);
      return result.hazard ? { matched: true, category: result.category, lexiconVersion: result.lexiconVersion } : { matched: false };
    },
    async handle(input) {
      await handleSafety(deps, {
        ispId: input.ispId,
        clockId: input.clockId,
        installerId: input.installerId,
        category: input.category,
        detectedBy: "LEXICON",
        lexiconVersion: input.lexiconVersion,
        sourceMessageId: input.messageId,
        atSim: input.atSim,
        actor: "WORKER",
        ...(input.workOrderId === undefined ? {} : { workOrderId: input.workOrderId }),
      });
    },
  };
}
