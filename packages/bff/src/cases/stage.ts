// The cases module in a Lambda of the stage (the InstallerWorker and the targets that open cases:
// ToolCases, ToolEvidence, ToolOrders): the ports of cases/ports.ts over the stage's outbound pipeline
// (outbound/stage.ts), its timers (timers/stage.ts) and, where there is one, the installer queue; plus
// the certificate port `close_installation` uses (certificates/port.ts). Everything comes from what SST
// links, through the modules that read it; a Lambda without the installer queue (the tool targets)
// never closes a case, so its `CaseTurnQueue` refuses.
import { ToolError } from "@cuadrilla/shared";
import type { CertificatePort } from "../agent-tools/common/ports";
import { createCertificatePort, lambdaCertificateWriter } from "../certificates/port";
import { pipelineCertificateSender } from "../certificates/pipeline-sender";
import { connector } from "../connector/index";
import { esMX } from "../copy/es-MX";
import { systemClock } from "../lib/clock";
import type { Logger } from "../lib/log";
import { brandConfig } from "../lib/secrets";
import { type NetworkClient, networkClient } from "../network/client";
import { createCaseOutbound, createSummaryCheck } from "../outbound/cases";
import type { OutboundDeps } from "../outbound/deps";
import { deferredDispatcher, stageOutboundDeps } from "../outbound/stage";
import type { TimerDispatcher } from "../timers/dispatch";
import { stageTimerService } from "../timers/stage";
import type { InstallerEventSink } from "../worker/ports";
import { openCase } from "./open";
import type { CaseDeps, CaseTurnQueue, SummaryCheck } from "./ports";
import { fixedSummary } from "./summary";

/** `AGENT_TURN(CASE_CLOSED)` on the installer's FIFO group, through the queue's producer (worker/sink.ts). */
export function queueCaseTurns(sink: InstallerEventSink): CaseTurnQueue {
  return {
    enqueueCaseClosed: (turn) =>
      sink.enqueue({
        type: "AGENT_TURN",
        eventId: turn.eventId,
        clockId: turn.clockId,
        ispId: turn.ispId,
        installerId: turn.installerId,
        trigger: "CASE_CLOSED",
        workOrderId: turn.workOrderId,
        caseId: turn.caseId,
        eventAtSim: turn.atSim,
      }),
  };
}

/** A tool target has no installer queue: closing a case is the worker's (a supervisor's tap) or the console's. */
const NO_CASE_TURNS: CaseTurnQueue = {
  enqueueCaseClosed: async () => {
    throw new ToolError("UNAVAILABLE", "this function does not close cases", "NO_INSTALLER_QUEUE");
  },
};

export interface StageCaseOptions {
  /** The queue producer of `TIMER` events (the worker's); a tool target leaves due timers to the clock. */
  readonly dispatcher?: TimerDispatcher;
  /** The installer queue (the worker's sink); absent in the tool targets. */
  readonly sink?: InstallerEventSink;
  readonly network?: NetworkClient;
}

export interface StageCases {
  readonly deps: CaseDeps;
  readonly outbound: OutboundDeps;
  readonly summaries: SummaryCheck;
}

/** The deps of cases/ and safety/ in a Lambda, built on the stage's pipeline and timers. */
export function stageCases(logger: Logger, options: StageCaseOptions = {}): StageCases {
  const dispatcher = options.dispatcher ?? deferredDispatcher(logger);
  const outbound = stageOutboundDeps(logger, { dispatcher });
  const deps: CaseDeps = {
    connector: connector(),
    outbound: createCaseOutbound(outbound, logger),
    timers: stageTimerService(dispatcher, logger),
    turns: options.sink === undefined ? NO_CASE_TURNS : queueCaseTurns(options.sink),
    network: options.network ?? networkClient(),
    realClock: systemClock,
    logger,
  };
  return { deps, outbound, summaries: createSummaryCheck(outbound, logger) };
}

/** `BrandConfig` when the function links it and it reads; the neutral brand otherwise. */
function brandOrNeutral(logger: Logger) {
  return () => {
    try {
      return brandConfig();
    } catch (error) {
      logger.warn("brand unavailable: the neutral brand is used", { error });
      return undefined;
    }
  };
}

/**
 * `close_installation`'s certificate: the linked `CertificateWriter` writes it, the deliveries go out
 * through this Lambda's pipeline, and a certificate G3 blocked opens the `OTHER` case of its order here.
 */
export function stageCertificatePort(cases: StageCases, logger: Logger): CertificatePort {
  const { deps } = cases;
  return createCertificatePort({
    connector: deps.connector,
    writer: lambdaCertificateWriter(),
    sender: pipelineCertificateSender(cases.outbound, logger),
    timers: deps.timers,
    brand: brandOrNeutral(logger),
    logger,
    async openBlockedCase(request) {
      const workOrder = await deps.connector.workOrders.requireWorkOrder(request.workOrderId);
      const summary = fixedSummary({ reason: "OTHER", reasonText: esMX.caseReason({ reason: "OTHER" }), workOrder });
      await openCase(deps, { workOrderId: workOrder.workOrderId, reason: "OTHER", summary, atSim: request.closedAtSim, actor: "SYSTEM" });
    },
  });
}
