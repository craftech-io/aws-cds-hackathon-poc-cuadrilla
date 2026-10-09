// The `case` preset through the real case handlers (docs/tool-catalog.md, `world.create`): `open_case`
// with `caller QA` and a summary built by code, `advance_ladder` on the rung's timeout until the case is
// on the rung the preset names, and the take of that rung's supervisor for `TAKEN`. Every message of the
// ladder (`caso_escalado`, `caso_reasignado`, the zone chief's email) leaves through the pipeline of the
// `CaseDeps` given, with the contact policy deciding, exactly as in a run of the product.
import { ToolError } from "@cuadrilla/shared";
import { advanceLadder, personOfCurrentRung, rungIndex } from "../cases/ladder";
import { openCase } from "../cases/open";
import type { CaseDeps } from "../cases/ports";
import { takeCase } from "../cases/take";
import { esMX } from "../copy/es-MX";
import type { PresetEffects } from "./presets";

/** Rungs a preset climbs at most (PRIMARY → SECONDARY → ZONE_CHIEF). */
const MAX_CLIMB = 3;

export function casePresetEffects(deps: CaseDeps): PresetEffects {
  return {
    async openCase(input) {
      const opened = await openCase(deps, { workOrderId: input.workOrderId, reason: input.reason, summary: esMX.caseReason({ reason: input.reason }), atSim: input.atSim, actor: "QA" });
      let caseItem = opened.caseItem;
      for (let climb = 0; climb < MAX_CLIMB && rungIndex(caseItem.rung) < rungIndex(input.rung); climb += 1) {
        const moved = await advanceLadder(deps, caseItem.caseId, { kind: "TIMEOUT", rungVersion: caseItem.rungVersion, firedBy: "MANUAL" }, input.atSim);
        if (moved.status !== "MOVED" || moved.caseItem.rung === caseItem.rung) break;
        caseItem = moved.caseItem;
      }
      if (caseItem.rung !== input.rung) throw new ToolError("CONFLICT", `the case stopped at ${caseItem.rung}, not ${input.rung}`, "PRESET_CASE_RUNG");
      if (input.status === "TAKEN") {
        const supervisorId = personOfCurrentRung(caseItem);
        if (supervisorId === undefined) throw new ToolError("INVALID", "only a supervisor's rung is taken", "PRESET_CASE_TAKE");
        const taken = await takeCase(deps, { caseId: caseItem.caseId, actor: { via: "WHATSAPP", supervisorId }, atSim: input.atSim });
        if (taken.outcome !== "TAKEN") throw new ToolError("CONFLICT", `the case could not be taken (${taken.outcome})`, "PRESET_CASE_TAKE");
      }
      return { caseId: caseItem.caseId };
    },
  };
}
