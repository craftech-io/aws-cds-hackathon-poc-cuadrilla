// What the `cases` target adds to every tool runtime (docs/architecture.md §9.2, `ToolCases`): the
// ports of cases/ports.ts (the outbound pipeline, the timers, the installer queue and the summary check),
// the network orchestrator's client (the own reading of `close_installation`, the bridge's
// `SUPERVISOR_FIX`) and the certificate writer. `caseDepsOf` turns one call's context into the deps of
// the deterministic handlers of cases/ and safety/, bound to the call's logger.
//
// The Lambda's default runtime is the stage's (cases/stage.ts): the pipeline, the timers and the
// certificate port of this function, built once per container. A target has no installer queue, so it
// never closes a case (that is a supervisor's tap in the worker, or the console).
import { createLogger } from "../../lib/log";
import { type NetworkClient, networkClient } from "../../network/client";
import { stageCases, stageCertificatePort } from "../../cases/stage";
import type { CaseDeps, CaseOutbound, CaseTurnQueue, SummaryCheck } from "../../cases/ports";
import type { ToolContext, ToolRuntime } from "../common/context";
import type { CertificatePort, TimerPort } from "../common/ports";
import { defaultToolRuntime } from "../common/runtime";

export interface CasesRuntime extends ToolRuntime {
  readonly outbound: CaseOutbound;
  readonly timers: TimerPort;
  readonly turns: CaseTurnQueue;
  readonly summaries: SummaryCheck;
  readonly certificates: CertificatePort;
  readonly network: Pick<NetworkClient, "getOnuStatus" | "reportPhysicalAction">;
  /** Case ids (tests); `case-<ULID>` by default. */
  readonly newCaseId?: () => string;
}

export type CasesContext = ToolContext<CasesRuntime>;

/** The deps of cases/ and safety/ for one call. */
export function caseDepsOf(ctx: Pick<CasesContext, "deps" | "logger">): CaseDeps {
  const { deps } = ctx;
  return {
    connector: deps.connector,
    outbound: deps.outbound,
    timers: deps.timers,
    turns: deps.turns,
    network: deps.network,
    realClock: deps.realClock,
    logger: ctx.logger,
    ...(deps.newCaseId === undefined ? {} : { newCaseId: deps.newCaseId }),
  };
}

let runtime: CasesRuntime | undefined;

/** The runtime of the `ToolCases` Lambda, built once per container. */
export function defaultCasesRuntime(): CasesRuntime {
  if (runtime === undefined) {
    const logger = createLogger({ bindings: { component: "cases", target: "cases" } });
    const network = networkClient();
    const cases = stageCases(logger, { network });
    const { deps } = cases;
    runtime = { ...defaultToolRuntime(), outbound: deps.outbound, timers: deps.timers, turns: deps.turns, summaries: cases.summaries, certificates: stageCertificatePort(cases, logger), network };
  }
  return runtime;
}
