// The `InstallerWorker` of a local world: worker/worker.ts with the ports worker/stage-ports.ts wires in
// the stage, built over the local stage (stage.ts) instead of the Lambda's links: `transcribe_voice_note`
// over the Transcribe fake and the buckets, safety and cases over the case handlers, the worker's fixed
// notices and the order choice through the pipeline, the timers and their handlers (`fire_day_start`,
// `advance_ladder(TIMEOUT)`, deferred sends, `CERT_RETRY`), the dispatcher's and SES's events, the
// installer's buttons, and the turn through the product's Harness client (answered by the scripted
// Harness, or by the model-backed one tests/agent inject) and G1 over the guardrail fake. The reads the worker preloads run on the in-process targets.
import { type HarnessLink, type HarnessSend, createHarnessClient } from "../../../packages/bff/src/agent/harness-client";
import { onCaseTimeout } from "../../../packages/bff/src/cases/events";
import { openCase } from "../../../packages/bff/src/cases/open";
import { fixedSummary } from "../../../packages/bff/src/cases/summary";
import { workerCasePort, workerSafetyPort } from "../../../packages/bff/src/cases/worker";
import { retryCertificateDelivery } from "../../../packages/bff/src/certificates/deliveries";
import { recordCertificateEmailEvent } from "../../../packages/bff/src/certificates/delivery-events";
import { pipelineCertificateSender } from "../../../packages/bff/src/certificates/pipeline-sender";
import { applyEmailEvent } from "../../../packages/bff/src/channels/email/events";
import { connectorWorldTime } from "../../../packages/bff/src/channels/whatsapp/ports";
import { esMX } from "../../../packages/bff/src/copy/es-MX";
import { dayStartRequestOf, fireDayStart } from "../../../packages/bff/src/dayplan/day-start";
import { dispatchEventHandler } from "../../../packages/bff/src/feeds/worker-handlers";
import { stageTranscriber } from "../../../packages/bff/src/worker/stage-voice";
import { pipelineDayStartSender, pipelineOrderChoice, pipelineWorkerNotices, sendOrderedOutbound } from "../../../packages/bff/src/outbound/adapters";
import { fireDeferredSend } from "../../../packages/bff/src/outbound/pipeline";
import { customerOkAction } from "../../../packages/bff/src/services/evidence-override/customer-ok";
import { createG1Prefilter } from "../../../packages/bff/src/turns/prefilter";
import type { AgentMode } from "../../../packages/bff/src/domain/metrics";
import type { EmailEventEvent } from "../../../packages/bff/src/worker/events";
import type { EventHandlers, WorkerContext, WorkerPorts } from "../../../packages/bff/src/worker/ports";
import { type InstallerWorker, type WorkerDeps, createInstallerWorker } from "../../../packages/bff/src/worker/worker";
import type { FakeTranscribe } from "../../../packages/bff/src/media/testing";
import { LOCAL_G1, LOCAL_TRANSCRIBE_CONFIG } from "./aws";
import { LOCAL_BUCKETS } from "./objects";
import type { Stage } from "./stage";
import type { Targets } from "./targets";

/** `Resource.Harness` of a local world (the stage's limits, infra/agentcore.ts). */
export const LOCAL_HARNESS = { harnessArn: "arn:aws:bedrock-agentcore:us-east-1:000000000000:harness/cuadrilla-local", endpointName: "live", timeoutSeconds: 120, maxIterations: 12 } as const;

function workerPorts(stage: Stage, targets: Targets, transcribe: FakeTranscribe): WorkerPorts {
  const data = stage.memory.connector;
  const { cases: caseDeps, outbound, timers, log } = stage;
  const worldTime = connectorWorldTime(data, stage.realClock);
  const deliveries = { connector: data, sender: pipelineCertificateSender(outbound, log), timers, brand: () => undefined, logger: log };
  const dayStart = { connector: data, timers, logger: log, sender: pipelineDayStartSender(outbound, log) };

  async function emailEvent(event: EmailEventEvent, ctx: WorkerContext): Promise<void> {
    const outcome = await applyEmailEvent({ conversations: data.conversations, worlds: data.worlds }, event.record);
    if (!outcome.applied) return;
    ctx.log.info("email_event.applied", {
      kind: outcome.mail.kind,
      status: outcome.status,
      effect: outcome.effect,
      ...(outcome.deliveryLatencyMs === undefined ? {} : { metric: "SafetyAlertLatency", value: outcome.deliveryLatencyMs }),
    });
    const recorded = await recordCertificateEmailEvent({ connector: data, timers, simNow: stage.simNow, logger: ctx.log }, outcome);
    const workOrderId = outcome.mail.workOrderId;
    if (recorded.effect !== "CERTIFICATE_UNDELIVERED" || workOrderId === undefined) return;
    const workOrder = await data.workOrders.requireWorkOrder(workOrderId);
    const summary = fixedSummary({ reason: "CERTIFICATE_UNDELIVERED", reasonText: esMX.caseReason({ reason: "CERTIFICATE_UNDELIVERED" }), workOrder });
    await openCase(caseDeps, { workOrderId, reason: "CERTIFICATE_UNDELIVERED", summary, atSim: (await stage.simNow(workOrder.clockId)).toISOString(), actor: "WORKER" });
  }

  const handlers: EventHandlers = {
    ...dispatchEventHandler({ connector: data, worldTime }),
    applyEmailEvent: emailEvent,
    async outboundSend(event, ctx) {
      await sendOrderedOutbound(outbound, event, ctx.log);
    },
  };

  return {
    transcriber: stageTranscriber(data, stage.costs, () => ({
      transcribe,
      objects: stage.objects.mediaObjects,
      config: () => LOCAL_TRANSCRIBE_CONFIG,
      mediaBucket: () => LOCAL_BUCKETS.Media,
      costs: stage.costs,
      realClock: stage.realClock,
      sleep: async () => undefined,
    })),
    safety: workerSafetyPort(caseDeps),
    cases: workerCasePort(caseDeps, async (clockId) => (await stage.simNow(clockId)).toISOString()),
    notices: pipelineWorkerNotices(outbound, log),
    orderChoice: pipelineOrderChoice(outbound, log),
    timers,
    timerHandlers: {
      async dayStart(fired) {
        await fireDayStart(dayStart, dayStartRequestOf(fired.timer, fired.eventAtSim, fired.event.eventId));
      },
      async caseTimeout(fired) {
        await onCaseTimeout(caseDeps, fired.timer, fired.eventAtSim, fired.event.firedBy);
      },
      async deferredSend(fired) {
        await fireDeferredSend(outbound, fired.timer, fired.eventAtSim, { actor: "WORKER", correlationId: fired.event.eventId.slice(0, 64), log });
      },
      async certRetry(fired) {
        await retryCertificateDelivery(deliveries, fired.timer, { eventAtSim: fired.eventAtSim, correlationId: fired.event.eventId });
      },
    },
    handlers,
    buttons: { actions: { ...targets.buttonActions, recordCustomerOk: customerOkAction({ connector: data, realClock: stage.realClock, logger: log }) }, notices: stage.installerNotices },
    probes: [{ name: "network", health: async () => (await stage.network.client.health(log)).kind === "OK" }],
  };
}

export interface LocalWorker {
  readonly deps: WorkerDeps;
  readonly run: InstallerWorker;
}

/** The Harness behind the worker: the scripted one by default; a model-backed one (tests/agent) with its link and mode. */
export interface LocalHarnessSeam {
  readonly send: HarnessSend;
  readonly link?: HarnessLink;
  readonly agentMode?: AgentMode;
}

export function createLocalWorker(stage: Stage, targets: Targets, harness: LocalHarnessSeam, transcribe: FakeTranscribe): LocalWorker {
  const data = stage.memory.connector;
  const link = harness.link ?? LOCAL_HARNESS;
  const deps: WorkerDeps = {
    data,
    turn: {
      harness: createHarnessClient({ link: () => link, send: harness.send, nowMs: () => stage.now().getTime(), sleep: async () => undefined }),
      prefilter: createG1Prefilter({ link: () => LOCAL_G1, send: (input) => stage.guardrails.send({ input }) }),
      budget: { kill: stage.kill, costCaps: stage.costs },
      sessionKey: () => stage.key("session"),
      runtimeSessionKey: () => stage.key("runtime-session"),
      agentMode: harness.agentMode ?? "SCRIPTED",
      reads: { orders: targets.orders, evidence: targets.evidence },
    },
    ports: workerPorts(stage, targets, transcribe),
    network: stage.network.client,
    sink: stage.sink,
    now: stage.now,
    loggerFor: () => stage.log,
  };
  return { deps, run: createInstallerWorker(deps) };
}
