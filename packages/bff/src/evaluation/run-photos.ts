// `eval.runPhotos` of the `QaDriver` (docs/tool-catalog.md; docs/test-plan.md §4.5 `EV-02/2`, §5): a batch
// of the 60 labelled photos, each validated by `tool.invoke(validate_install_photo)` with a `QA` caller,
// without a turn and without an inbound message (no reaction, no `CHECK# PASSED`), on the order of its own
// operation:
//
//   1. the order is the label's (class and serial) and the photo is the installer's candidate on it
//   2. the ONU row of its serial carries the label's orchestrator reading (`orchestratorRxDbm`), so
//      `VAL-CROSSCHECK` never rejects a meter in range for another value; orders cloned from one model
//      share that row, which is why photos run one after the other
//   3. a photo that must be a duplicate (`ph-adv-04`) runs only when the PASS evidence it duplicates is
//      already in the world on another order (seeded by `world.create`, world-request.ts): the
//      adversarial gate is deterministic
//   4. one `EvalResult`: verdict, passed (accuracy), reason and whether it is right, tokens, cost, latency
import { ToolError } from "@cuadrilla/shared";
import { candidateIdOf } from "../evidence/candidate";
import type { PhotoValidation, WorkOrder } from "../domain/work-orders";
import type { EvalTemplate } from "../worlds/templates";
import { tokenCost } from "./cost";
import { type PhotoLabel, photoLabelOf } from "./outcomes";
import { type EvalDeps, RunPhotosInput } from "./ports";
import { closeRun } from "./publish";
import { type ItemRun, type RunOutput, failureCodeOf, itemsToRun } from "./run-questions";
import { type PhotoObservation, scorePhoto } from "./score";
import { duplicatedPhotoOf, evalRunOf, itemInstallerId } from "./world-request";

type TemplatePhoto = EvalTemplate["photos"][number];

interface PhotoContext {
  readonly clockId: string;
  readonly ispId: string;
  readonly runId: string;
  readonly rates: readonly unknown[];
  readonly labels: ReadonlyMap<string, PhotoLabel>;
  readonly templates: ReadonlyMap<string, TemplatePhoto>;
}

const setup = (message: string): ToolError => new ToolError("CONFLICT", message, "EVAL_SETUP");

/** The photo's order, installer and candidate in the world, checked against the label. */
async function targetOf(deps: EvalDeps, context: PhotoContext, label: PhotoLabel) {
  const { connector } = deps;
  const installerId = itemInstallerId(context.clockId, label.photoId);
  const workOrderId = (await connector.worlds.getInstallerState(installerId))?.activeWorkOrderId;
  if (workOrderId === undefined) throw setup(`${label.photoId} has no installer with an active order`);
  const order = await connector.workOrders.requireWorkOrder(workOrderId);
  if (order.clockId !== context.clockId || order.installerId !== installerId) throw setup(`the order of ${label.photoId} is not its installer's`);
  if (order.onuSerial !== label.orderSerial || order.opticalClass !== label.opticalClass) throw setup(`the order of ${label.photoId} is not the one its label asks for`);
  const installer = await connector.people.requirePerson(installerId);
  const thread = await connector.conversations.listMessages(installerId);
  const candidate = thread.find((message) => message.direction === "IN" && message.content === "IMAGE" && message.refs?.photoId === label.photoId && message.media?.sha256 === label.sha256);
  if (candidate === undefined) throw setup(`${label.photoId} is not a candidate of its installer`);
  return { order, installer, candidateId: candidateIdOf(candidate.messageId) };
}

/** The PASS evidence a duplicate must find (same bytes, another order of the world and epoch). */
async function assertDuplicateGate(deps: EvalDeps, context: PhotoContext, template: TemplatePhoto, workOrderId: string, worldEpoch: number): Promise<string | undefined> {
  const duplicated = duplicatedPhotoOf(template);
  if (duplicated === undefined) return undefined;
  const source = context.labels.get(duplicated.photoId);
  if (source === undefined) throw setup(`${template.photoId} duplicates ${duplicated.photoId}, which is not in the set`);
  const evidence = await deps.connector.workOrders.findEvidenceByHash(context.clockId, worldEpoch, source.sha256);
  if (!evidence.some((entry) => entry.workOrderId !== workOrderId)) throw setup(`the PASS evidence of ${duplicated.photoId} is not seeded on another order`);
  return duplicated.photoId;
}

interface Validated {
  readonly order: WorkOrder;
  readonly latencyMs: number;
  readonly duplicates?: string;
  readonly validation?: PhotoValidation;
  readonly observation: PhotoObservation;
}

async function validate(deps: EvalDeps, context: PhotoContext, label: PhotoLabel, template: TemplatePhoto): Promise<Validated> {
  const { order, installer, candidateId } = await targetOf(deps, context, label);
  const duplicates = await assertDuplicateGate(deps, context, template, order.workOrderId, order.worldEpoch);
  const clock = await deps.connector.runtime.getClock(context.clockId);
  const atSim = clock?.pausedSimNow ?? order.appointmentWindow.startSim;
  await deps.tools.setOnu({ order, installer, atSim, behaviour: template.onu.behaviour, rxDbm: label.orchestratorRxDbm });
  const started = deps.now().getTime();
  const response = await deps.tools.validatePhoto({ clockId: context.clockId, ispId: context.ispId, installerId: installer.personId, workOrderId: order.workOrderId, candidateId, item: label.item });
  const latencyMs = Math.max(0, deps.now().getTime() - started);
  if (response.ok !== true) {
    const failure = response as { readonly error?: { readonly code?: string; readonly reason?: string } };
    const error = { code: failure.error?.code ?? "UNKNOWN", ...(failure.error?.reason === undefined ? {} : { reason: failure.error.reason }) };
    return { order, latencyMs, ...(duplicates === undefined ? {} : { duplicates }), observation: { error } };
  }
  const verdict = response.verdict as PhotoObservation["verdict"];
  const reasonCode = typeof response.reasonCode === "string" ? response.reasonCode : undefined;
  const validation = typeof response.validationId === "string" ? await deps.connector.workOrders.getValidation(order.workOrderId, response.validationId) : undefined;
  const observation: PhotoObservation = { ...(verdict === undefined ? {} : { verdict }), ...(reasonCode === undefined ? {} : { reasonCode }) };
  return { order, latencyMs, ...(duplicates === undefined ? {} : { duplicates }), ...(validation === undefined ? {} : { validation }), observation };
}

async function runPhoto(deps: EvalDeps, context: PhotoContext, photoId: string): Promise<ItemRun> {
  const label = context.labels.get(photoId) as PhotoLabel;
  const template = context.templates.get(photoId) as TemplatePhoto;
  const base = { ispId: context.ispId, runId: context.runId, kind: "P" as const, itemId: photoId, clockId: context.clockId };
  const expected = { item: label.item, expectedVerdict: label.expectedVerdict, ...(label.expectedReason === undefined ? {} : { expectedReason: label.expectedReason }) };
  try {
    const run = await validate(deps, context, label, template);
    const score = scorePhoto(label, run.observation);
    const usage = run.validation?.usage ?? { inputTokens: 0, outputTokens: 0 };
    const cost = tokenCost(context.rates, usage);
    const result = await deps.connector.metrics.putEvalResult({
      ...base,
      outcome: score.outcome,
      passed: score.passed,
      latencyMs: run.latencyMs,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      details: {
        ...expected,
        workOrderId: run.order.workOrderId,
        installerId: run.order.installerId,
        ...(run.observation.reasonCode === undefined ? {} : { reasonCode: run.observation.reasonCode }),
        reasonCorrect: score.reasonCorrect,
        ...(run.observation.error === undefined ? {} : { error: run.observation.error.reason === undefined ? run.observation.error.code : `${run.observation.error.code}:${run.observation.error.reason}` }),
        ...(run.duplicates === undefined ? {} : { duplicates: run.duplicates }),
        ...(run.validation === undefined ? {} : { checks: [...run.validation.checks], source: run.validation.source, ...(run.validation.modelVerdict === undefined ? {} : { modelVerdict: run.validation.modelVerdict }), ...(run.validation.latencyMs === undefined ? {} : { validatorLatencyMs: run.validation.latencyMs }) }),
        costUsd: cost.usd,
        costStatus: cost.status,
      },
    });
    return { result };
  } catch (error) {
    const code = failureCodeOf(error);
    deps.log.warn("evaluation.photo_failed", { photoId, code });
    return { result: await deps.connector.metrics.putEvalResult({ ...base, outcome: `ERROR:${code}`.slice(0, 64), passed: false, details: { ...expected, error: code } }) };
  }
}

export async function runPhotos(deps: EvalDeps, raw: unknown): Promise<RunOutput> {
  const input = RunPhotosInput.parse(raw);
  const run = evalRunOf(input.clockId);
  const [rows, template] = await Promise.all([deps.connector.reference.listEvalPhotos(), deps.evalTemplate()]);
  const labels = new Map(rows.map((row) => photoLabelOf(row)).map((label) => [label.photoId, label] as const));
  const templates = new Map(template.photos.map((photo) => [photo.photoId, photo] as const));
  const unknown = input.photoIds.filter((photoId) => !labels.has(photoId) || !templates.has(photoId));
  if (unknown.length > 0) throw new ToolError("INVALID", `not photos of the set: ${unknown.join(", ")}`, "EVAL_UNKNOWN_ITEM");
  const { todo, skipped } = await itemsToRun(deps, run, "P", input.photoIds, input.rerun);
  const context: PhotoContext = { clockId: input.clockId, ...run, rates: todo.length === 0 ? [] : await deps.connector.reference.listRateCard(), labels, templates };
  const ran: ItemRun[] = [];
  for (const photoId of todo) ran.push(await runPhoto(deps, context, photoId));
  const publish = input.publish || input.collect ? await closeRun(deps, "P", run, [...labels.keys()].sort(), input.publish) : undefined;
  return { ...run, ran, skipped, ...(publish === undefined ? {} : { publish }) };
}
