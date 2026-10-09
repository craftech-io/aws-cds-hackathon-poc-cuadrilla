// The `case` preset's effects (docs/tool-catalog.md, `world.create`; worlds/presets.ts `PresetEffects`),
// the real `open_case` and `advance_ladder` with `caller QA` (cases/preset.ts), two ways:
//
//   casePresetEffects    in process, over `CaseDeps` with an outbound pipeline (`seed:load`, the tests)
//   queuedCasePresetEffects  a `CASE_PRESET` event on the installer's FIFO group (ADR-0017): a Lambda
//                        without the pipeline (the `Bff`, the `QaDriver`) hands it to the `InstallerWorker`,
//                        which holds it; the ladder's templates go through the pipeline there. The event
//                        marks the world busy until the worker settles it, and its id is the order's and
//                        the epoch's, so a retried load is the same event.
import { openPresetCase } from "../cases/preset";
import type { CaseDeps } from "../cases/ports";
import { consoleEventId } from "../services/case-console/queue";
import type { InstallerEventSink } from "../worker/ports";
import type { PresetEffects } from "./presets";

export function casePresetEffects(deps: CaseDeps): PresetEffects {
  return { openCase: (input) => openPresetCase(deps, input) };
}

export function queuedCasePresetEffects(sink: InstallerEventSink): PresetEffects {
  return {
    async openCase(input) {
      const { order } = input;
      await sink.enqueue({
        type: "CASE_PRESET",
        eventId: consoleEventId("case-preset", order.clockId, order.worldEpoch, order.workOrderId, input.reason, input.rung, input.status),
        clockId: order.clockId,
        ispId: order.ispId,
        installerId: order.installerId,
        workOrderId: order.workOrderId,
        worldEpoch: order.worldEpoch,
        reason: input.reason,
        rung: input.rung,
        status: input.status,
        atSim: input.atSim,
      });
      return {};
    },
  };
}
