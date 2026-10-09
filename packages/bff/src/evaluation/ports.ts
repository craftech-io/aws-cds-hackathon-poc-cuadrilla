// What the evaluation needs from the `QaDriver` (WP-45 wires them, the tests fake them): the actions it
// composes (`wa.inbound`, `installer.settle`, `tool.invoke`, the ONU row of `network.setBehaviour`) and the
// data it reads and writes through the connector. The inputs of `eval.runQuestions` and `eval.runPhotos`
// are parsed here, at the driver's edge, so the runner can only name items of the set and an `eval-*` world.
import { z } from "zod";
import { ClockId, PhotoId, type PhotoItem, QuestionId, type WaButtonAction, parseClockId } from "@cuadrilla/shared";
import type { ToolResponse } from "../agent-tools/common/validation";
import type { Connector } from "../connector/ports";
import type { TableClient } from "../connector/table-client";
import type { Person } from "../domain/people";
import type { WorkOrder } from "../domain/work-orders";
import type { Logger } from "../lib/log";
import type { EvalTemplate, OnuModelBehaviour } from "../worlds/templates";

/** The simulated phone of an installer of the world (the world is `simulated`; same path as the simulator). */
export interface EvalChannel {
  /** `wa.inbound` text from the installer's identity; the id of the inbound message when the driver knows it. */
  sendText(input: { readonly clockId: string; readonly installerId: string; readonly text: string }): Promise<{ readonly messageId?: string }>;
  /** `wa.inbound button(action)`: taps the button whose nonce a message to the installer carries. */
  tapButton(input: { readonly clockId: string; readonly installerId: string; readonly nonce: string; readonly action: WaButtonAction }): Promise<void>;
  /** `installer.settle`: resolves once nothing of the installer is in flight (rejects on its timeout). */
  settleInstaller(input: { readonly installerId: string; readonly timeoutSec: number }): Promise<void>;
}

export interface ValidatePhotoCall {
  readonly clockId: string;
  readonly ispId: string;
  readonly installerId: string;
  readonly workOrderId: string;
  readonly candidateId: string;
  readonly item: PhotoItem;
}

export interface OnuRow {
  readonly order: WorkOrder;
  readonly installer: Person;
  readonly atSim: string;
  readonly behaviour: OnuModelBehaviour;
  readonly rxDbm: number;
}

export interface EvalTools {
  /** `tool.invoke(validate_install_photo)` with a `QA` caller of the world and the order as subject. */
  validatePhoto(call: ValidatePhotoCall): Promise<ToolResponse>;
  /** The ONU row of the order's serial (what `VAL-CROSSCHECK` reads), as the label's orchestrator reading. */
  setOnu(row: OnuRow): Promise<void>;
}

export interface EvalDeps {
  readonly connector: Pick<Connector, "people" | "workOrders" | "cases" | "conversations" | "audit" | "runtime" | "worlds" | "reference" | "metrics">;
  /** `CuadrillaMetrics` (the published run's pointer). */
  readonly client: Pick<TableClient, "put">;
  readonly channel: EvalChannel;
  readonly tools: EvalTools;
  /** The `eval` world template (`Seed/worlds/eval.json`): model and ONU of each photo. */
  readonly evalTemplate: () => Promise<EvalTemplate>;
  readonly log: Logger;
  /** Real clock: latencies and the run's finish. */
  readonly now: () => Date;
}

const EvalClock = ClockId.refine((clockId) => parseClockId(clockId)?.kind === "EVAL", "expected an eval-* world");

/**
 * Questions per call: 4, all at once (each in its own FIFO group), so a call is one round: a question and
 * its tap, each followed by `installer.settle` (at most 300 s), stay inside the driver's 15 minutes.
 */
export const MAX_QUESTIONS_PER_CALL = 4;
/** Photos per call: validated one after the other (orders cloned from one model share their ONU row). */
export const MAX_PHOTOS_PER_CALL = 12;

const Common = {
  clockId: EvalClock,
  /** Re-run items that already have a result in this run (by default only failed attempts are re-run). */
  rerun: z.boolean().default(false),
  /** After this batch: publish the run as the latest of its kind if every item of the set has a result. */
  publish: z.boolean().default(false),
  /** After this batch: return every result of the run (implied by `publish`), without publishing it. */
  collect: z.boolean().default(false),
};

export const RunQuestionsInput = z
  .object({
    ...Common,
    questionIds: z.array(QuestionId).max(MAX_QUESTIONS_PER_CALL).default([]),
    concurrency: z.int().min(1).max(4).default(4),
    settleTimeoutSec: z.int().min(30).max(300).default(240),
  })
  .strict();
export type RunQuestionsInput = z.input<typeof RunQuestionsInput>;

export const RunPhotosInput = z
  .object({
    ...Common,
    photoIds: z.array(PhotoId).max(MAX_PHOTOS_PER_CALL).default([]),
  })
  .strict();
export type RunPhotosInput = z.input<typeof RunPhotosInput>;
