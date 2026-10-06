// The ports of worker/ports.ts in the deployed `InstallerWorker`, built once per container over the
// stage's modules (docs/architecture.md §7), every follow-up through the worker's own queue producer:
//
//   transcriber      media/ (worker/stage-voice.ts)
//   safety, cases    cases/worker.ts over cases/stage.ts (pipeline, timers, installer queue)
//   notices, lists   outbound/adapters.ts and outbound/stage.ts `stageNotices`
//   timers           timers/stage.ts, dispatching due timers to the installer queue
//   timer handlers   dayplan/ `fire_day_start`, cases/ `advance_ladder(TIMEOUT)`, outbound/ deferred sends,
//                    certificates/ `CERT_RETRY`
//   event handlers   feeds/ `apply_dispatch_event`, channels/email + certificates/ `apply_email_event`,
//                    outbound/ `OUTBOUND_SEND`
//   buttons          agent-tools/cases/actions.ts (consult, close over the `cases` target in process) and
//                    services/evidence-override `record_customer_ok`
import { caseButtonActions } from "../agent-tools/cases/actions";
import { createCasesTools } from "../agent-tools/cases/index";
import type { CasesRuntime } from "../agent-tools/cases/runtime";
import { defaultToolRuntime } from "../agent-tools/common/runtime";
import { onCaseTimeout } from "../cases/events";
import { openCase } from "../cases/open";
import { stageCases, stageCertificatePort } from "../cases/stage";
import { fixedSummary } from "../cases/summary";
import { workerCasePort, workerSafetyPort } from "../cases/worker";
import { retryCertificateDelivery } from "../certificates/deliveries";
import { recordCertificateEmailEvent } from "../certificates/delivery-events";
import { pipelineCertificateSender } from "../certificates/pipeline-sender";
import { applyEmailEvent } from "../channels/email/events";
import { connectorWorldTime } from "../channels/whatsapp/ports";
import { connector } from "../connector/index";
import { esMX } from "../copy/es-MX";
import { dayStartRequestOf, fireDayStart } from "../dayplan/day-start";
import { dispatchEventHandler } from "../feeds/worker-handlers";
import { systemClock } from "../lib/clock";
import type { Logger } from "../lib/log";
import { brandConfig } from "../lib/secrets";
import type { NetworkClient } from "../network/client";
import type { CostCapsDeps } from "../ops/cost-caps";
import { pipelineDayStartSender, pipelineOrderChoice, pipelineWorkerNotices, sendOrderedOutbound } from "../outbound/adapters";
import { fireDeferredSend } from "../outbound/pipeline";
import { stageNotices } from "../outbound/stage";
import { customerOkAction } from "../services/evidence-override/customer-ok";
import { queueTimerDispatcher } from "../timers/dispatch";
import type { EmailEventEvent } from "./events";
import type { EventHandlers, InstallerEventSink, WorkerContext, WorkerPorts } from "./ports";
import { stageTranscriber } from "./stage-voice";

export interface StagePortsInput {
  readonly sink: InstallerEventSink;
  readonly network: NetworkClient;
  readonly costs: CostCapsDeps;
  readonly logger: Logger;
}

function brandOrNeutral() {
  try {
    return brandConfig();
  } catch {
    return undefined;
  }
}

export function stageWorkerPorts(input: StagePortsInput): WorkerPorts {
  const { sink, network, logger } = input;
  const data = connector();
  const worldTime = connectorWorldTime(data, systemClock);
  const simNow = async (clockId: string): Promise<Date> => (await worldTime(clockId))?.simNow ?? (await systemClock.now());
  const dispatcher = queueTimerDispatcher(sink);
  const cases = stageCases(logger, { dispatcher, sink, network });
  const { deps: caseDeps, outbound } = cases;
  const timers = caseDeps.timers;
  const certificates = stageCertificatePort(cases, logger);
  const casesRuntime: CasesRuntime = { ...defaultToolRuntime(), outbound: caseDeps.outbound, timers, turns: caseDeps.turns, summaries: cases.summaries, certificates, network };
  const casesTools = createCasesTools(() => casesRuntime);
  const deliveries = { connector: data, sender: pipelineCertificateSender(outbound, logger), timers, brand: brandOrNeutral, logger };
  const dayStart = { connector: data, timers, logger, sender: pipelineDayStartSender(outbound, logger) };

  async function emailEvent(event: EmailEventEvent, ctx: WorkerContext): Promise<void> {
    const outcome = await applyEmailEvent({ conversations: data.conversations, worlds: data.worlds }, event.record);
    if (!outcome.applied) {
      ctx.log.info("email_event.ignored", { reason: outcome.reason, kind: event.record.kind });
      return;
    }
    ctx.log.info("email_event.applied", {
      kind: outcome.mail.kind,
      status: outcome.status,
      effect: outcome.effect,
      ...(outcome.deliveryLatencyMs === undefined ? {} : { metric: "SafetyAlertLatency", value: outcome.deliveryLatencyMs }),
    });
    const recorded = await recordCertificateEmailEvent({ connector: data, timers, simNow, logger: ctx.log }, outcome);
    const workOrderId = outcome.mail.workOrderId;
    if (recorded.effect !== "CERTIFICATE_UNDELIVERED" || workOrderId === undefined) return;
    const workOrder = await data.workOrders.requireWorkOrder(workOrderId);
    const summary = fixedSummary({ reason: "CERTIFICATE_UNDELIVERED", reasonText: esMX.caseReason({ reason: "CERTIFICATE_UNDELIVERED" }), workOrder });
    await openCase(caseDeps, { workOrderId, reason: "CERTIFICATE_UNDELIVERED", summary, atSim: (await simNow(workOrder.clockId)).toISOString(), actor: "WORKER" });
  }

  const handlers: EventHandlers = {
    ...dispatchEventHandler({ connector: data, worldTime }),
    applyEmailEvent: emailEvent,
    async outboundSend(event, ctx) {
      const result = await sendOrderedOutbound(outbound, event, ctx.log);
      ctx.log.info("worker.outbound_send", { status: result.status });
    },
  };

  return {
    transcriber: stageTranscriber(data, input.costs),
    safety: workerSafetyPort(caseDeps),
    cases: workerCasePort(caseDeps, async (clockId) => (await simNow(clockId)).toISOString()),
    notices: pipelineWorkerNotices(outbound, logger),
    orderChoice: pipelineOrderChoice(outbound, logger),
    timers,
    timerHandlers: {
      async dayStart(fired) {
        await fireDayStart(dayStart, dayStartRequestOf(fired.timer, fired.eventAtSim, fired.event.eventId));
      },
      async caseTimeout(fired, ctx) {
        const result = await onCaseTimeout(caseDeps, fired.timer, fired.eventAtSim, fired.event.firedBy);
        ctx.log.info("worker.case_timeout", { caseId: result.caseItem.caseId, status: result.status, rung: result.caseItem.rung });
      },
      async deferredSend(fired, ctx) {
        const result = await fireDeferredSend(outbound, fired.timer, fired.eventAtSim, { actor: "WORKER", correlationId: fired.event.eventId.slice(0, 64), log: ctx.log });
        ctx.log.info("worker.deferred_send", { status: result.status });
      },
      async certRetry(fired) {
        await retryCertificateDelivery(deliveries, fired.timer, { eventAtSim: fired.eventAtSim, correlationId: fired.event.eventId });
      },
    },
    handlers,
    buttons: {
      actions: { ...caseButtonActions(caseDeps, casesTools), recordCustomerOk: customerOkAction({ connector: data, realClock: systemClock, logger }) },
      notices: stageNotices(logger, { dispatcher }).installerNotices,
    },
    probes: [{ name: "network", health: async (log) => (await network.health(log)).kind === "OK" }],
  };
}
