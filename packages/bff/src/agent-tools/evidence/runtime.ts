// Dependencies of the `evidence` target (docs/architecture.md §9.2, `ToolEvidence`): the common tool
// runtime plus the photo model, the objects of `Media` and `Evidence`, the orchestrator (the
// validator's cross-check), the cost-cap counters (the stage's ceiling, reserved before `Converse`),
// and two ports of other packages of wave 3: `open_case` (cases/, WP-34) and the outbound pipeline
// (outbound/, WP-28). Until those are wired here, a call to them fails, the validation stands and
// the failure is logged: the case opens on the next rejection of the item, and the photo just goes
// without its reaction.
import type { CapLedgerStore, GlobalCostCaps } from "../../ops/cost-caps";
import { linkedGlobalCostCaps } from "../../ops/cost-caps";
import { runtimeStore } from "../../ops/defaults";
import type { NetworkClient } from "../../network/client";
import { networkClient } from "../../network/client";
import { bedrockPhotoModel } from "../../evidence/converse-client";
import { s3EvidenceStore } from "../../evidence/object-store";
import type { EvidenceObjectStore, EvidenceOutboundPort, PhotoAttemptsCasePort, PhotoModelPort } from "../../evidence/ports";
import { stageCases } from "../../cases/stage";
import { createLogger } from "../../lib/log";
import { pipelineEvidenceOutbound } from "../../outbound/adapters";
import { photoAttemptsCases } from "../cases/actions";
import type { ToolRuntime } from "../common/context";
import { defaultToolRuntime } from "../common/runtime";

export interface EvidenceToolRuntime extends ToolRuntime {
  readonly photoModel: PhotoModelPort;
  readonly objects: EvidenceObjectStore;
  readonly network: Pick<NetworkClient, "getOnuStatus">;
  readonly capStore: CapLedgerStore;
  readonly globalCaps: () => GlobalCostCaps;
  readonly cases: PhotoAttemptsCasePort;
  readonly outbound: EvidenceOutboundPort;
}

/** The case opener and the reaction, over the stage's cases and pipeline, built on their first call. */
function stagePorts(): Pick<EvidenceToolRuntime, "cases" | "outbound"> {
  let built: ReturnType<typeof stageCases> | undefined;
  const logger = createLogger({ bindings: { component: "evidence", target: "evidence" } });
  const cases = () => (built ??= stageCases(logger));
  return {
    cases: { openPhotoAttemptsCase: (request) => photoAttemptsCases(cases().deps).openPhotoAttemptsCase(request) },
    outbound: {
      reactToPhoto: (request) => pipelineEvidenceOutbound(cases().outbound, logger).reactToPhoto(request),
      photoNotice: (request) => pipelineEvidenceOutbound(cases().outbound, logger).photoNotice(request),
    },
  };
}

let runtime: EvidenceToolRuntime | undefined;

/** The runtime of the `ToolEvidence` Lambda, built once per container. */
export function defaultEvidenceRuntime(): EvidenceToolRuntime {
  if (runtime === undefined) {
    const base = defaultToolRuntime();
    runtime = {
      ...base,
      photoModel: bedrockPhotoModel({ worlds: base.connector.worlds }),
      objects: s3EvidenceStore(),
      network: networkClient(),
      capStore: runtimeStore(),
      globalCaps: linkedGlobalCostCaps,
      ...stagePorts(),
    };
  }
  return runtime;
}
