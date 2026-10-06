// What a decided validation leaves behind (docs/tool-catalog.md, `validate_install_photo`):
//
//   EVID#   the evidence copy (JPEG without metadata) in `Evidence/[guest/<seg>/]photos/…`, with the
//           photo's `sha256` in `GSI4`; a duplicate keeps none, so its bytes stay with the first order
//   VAL#    the validation: final verdict, the model's, the checks that decided, rubric, tokens
//   CHECK#  REJECTED (+1 attempt) or IN_REVIEW; never PASSED, which only `update_checklist` writes;
//           an item already PASSED or validated by hand is left as it is
//   PROFILE the rejected photo in the installer's measured profile (services/profile)
//   AuditLog ACTION PHOTO_VALIDATED with the deciding checks
//   case    PHOTO_ATTEMPTS from the third rejection of the item (evidence/attempts.ts)
//   ✅ / 🔁 the reaction to the photo, inside a Harness turn, before the tool returns
import { ConnectorError, type PhotoItem, type RejectReason } from "@cuadrilla/shared";
import { evidencePhotoKey } from "@cuadrilla/shared/media/keys";
import { esMX } from "../../copy/es-MX";
import type { ChecklistEntry, WorkOrder } from "../../domain/work-orders";
import { ulid } from "../../lib/crypto";
import { attemptRefs, isPhotoAttemptsDue } from "../../evidence/attempts";
import type { VerdictDecision } from "../../evidence/checks";
import type { ModelSummary } from "../../evidence/validator";
import { recordPhotoReject } from "../../services/profile/profile";
import type { ToolContext } from "../common/context";
import { type PhotoRef, reactToVerdict } from "./reaction";
import type { EvidenceToolRuntime } from "./runtime";

export const PHOTO_VALIDATED_ACTION = "PHOTO_VALIDATED";

type Ctx = ToolContext<EvidenceToolRuntime>;

interface Subject {
  readonly order: WorkOrder;
  readonly item: PhotoItem;
  readonly candidateId: string;
  readonly photo: PhotoRef;
  /** Of the bytes the installer sent: what `GSI4` compares. */
  readonly sha256: string;
}

/** Stores the evidence copy and its `EVID#` row; returns the evidence id. */
export async function keepEvidenceCopy(ctx: Ctx, subject: Subject & { readonly jpeg: Uint8Array }): Promise<string> {
  const { order, item, photo } = subject;
  const evidenceId = `ev-${ulid(ctx.realNow.getTime())}`;
  const s3Key = evidencePhotoKey(order.clockId, order.worldEpoch, order.workOrderId, item, evidenceId);
  await ctx.deps.objects.putEvidencePhoto(s3Key, subject.jpeg);
  await ctx.deps.connector.workOrders.createEvidence({
    evidenceId,
    workOrderId: order.workOrderId,
    clockId: order.clockId,
    worldEpoch: order.worldEpoch,
    item,
    sha256: subject.sha256,
    s3Key,
    mime: "image/jpeg",
    bytes: subject.jpeg.length,
    sourceMessageId: photo.candidate.messageId,
    receivedAtSim: photo.candidate.sentAtSim,
  });
  return evidenceId;
}

const COUNTABLE = ["PENDING", "REJECTED", "IN_REVIEW"] as const;

/** REJECTED (+1 attempt) or IN_REVIEW, unless the item is already PASSED or OVERRIDDEN. */
async function markItem(ctx: Ctx, subject: Subject, decision: VerdictDecision, refs: { readonly validationId: string; readonly evidenceId?: string }): Promise<ChecklistEntry | undefined> {
  const { order, item, photo } = subject;
  const { workOrders } = ctx.deps.connector;
  if (decision.verdict === "PASS") return workOrders.getChecklistItem(order.workOrderId, item);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await workOrders.getChecklistItem(order.workOrderId, item);
    if (current === undefined || !(COUNTABLE as readonly string[]).includes(current.status)) return current;
    const change =
      decision.verdict === "REJECT"
        ? { status: "REJECTED" as const, addAttempts: 1, lastRejectReason: decision.reasonCode ?? null, validationId: refs.validationId, evidenceId: refs.evidenceId ?? null, updatedAtSim: photo.atSim }
        : { status: "IN_REVIEW" as const, validationId: refs.validationId, evidenceId: refs.evidenceId ?? null, updatedAtSim: photo.atSim };
    try {
      return await workOrders.updateChecklistItem(order.workOrderId, item, change, { actor: ctx.actor, atSim: photo.atSim, reason: decision.reasonCode ?? decision.verdict }, { expectedVersion: current.version, expectedStatus: [...COUNTABLE] });
    } catch (error) {
      if (!(error instanceof ConnectorError && error.code === "CONFLICT")) throw error;
    }
  }
  throw new ConnectorError("CONFLICT", `checklist item ${item} kept changing`, "WorkOrders");
}

/** From the third rejection of the item: the case, idempotent; a failure is logged and retried next time. */
async function openCaseIfDue(ctx: Ctx, subject: Subject, attempts: number): Promise<{ readonly caseId: string; readonly reason: "PHOTO_ATTEMPTS" } | undefined> {
  const { order, item, photo } = subject;
  const refs = attemptRefs(await ctx.deps.connector.workOrders.listValidations(order.workOrderId, item), item);
  try {
    return await ctx.deps.cases.openPhotoAttemptsCase({
      ispId: order.ispId,
      clockId: order.clockId,
      workOrderId: order.workOrderId,
      installerId: order.installerId,
      item,
      evidenceIds: refs.evidenceIds,
      validationIds: refs.validationIds,
      atSim: photo.atSim,
      correlationId: ctx.correlationId,
      ...(ctx.scope.turnId === undefined ? {} : { turnId: ctx.scope.turnId }),
    });
  } catch (error) {
    ctx.logger.error("evidence.case_open.failed", { workOrderId: order.workOrderId, item, attempts, error });
    return undefined;
  }
}

function reasonText(item: PhotoItem, verdict: VerdictDecision["verdict"], reasonCode: RejectReason | undefined): string | undefined {
  if (verdict === "UNSURE") return esMX.photoInReview;
  return verdict === "REJECT" && reasonCode !== undefined ? esMX.rejectReason(reasonCode, item) : undefined;
}

export interface Decided {
  readonly decision: VerdictDecision;
  /** Absent for a duplicate: the model was never called. */
  readonly model?: ModelSummary;
  readonly rubricVersion?: string;
  readonly evidenceId?: string;
}

export async function recordValidation(ctx: Ctx, subject: Subject & Decided) {
  const { order, item, photo, decision, model, evidenceId } = subject;
  const { connector } = ctx.deps;
  const validationId = `val-${ulid(ctx.realNow.getTime())}`;
  await connector.workOrders.createValidation({
    validationId,
    workOrderId: order.workOrderId,
    clockId: order.clockId,
    item,
    candidateId: subject.candidateId,
    sha256: subject.sha256,
    verdict: decision.verdict,
    readings: decision.readings,
    checks: [...decision.checks],
    source: model?.source ?? ctx.deps.photoModel.source,
    atSim: photo.atSim,
    ...(evidenceId === undefined ? {} : { evidenceId }),
    ...(decision.reasonCode === undefined ? {} : { reasonCode: decision.reasonCode }),
    ...(model?.modelVerdict === undefined ? {} : { modelVerdict: model.modelVerdict }),
    ...(model?.confidence === undefined ? {} : { confidence: model.confidence }),
    ...(subject.rubricVersion === undefined ? {} : { rubricVersion: subject.rubricVersion }),
    ...(model?.stopReason === undefined ? {} : { stopReason: model.stopReason }),
    ...(model?.usage === undefined ? {} : { usage: model.usage }),
    ...(model === undefined ? {} : { latencyMs: model.latencyMs }),
  });
  const entry = await markItem(ctx, subject, decision, { validationId, ...(evidenceId === undefined ? {} : { evidenceId }) });
  const attempts = entry?.attempts ?? 0;
  if (decision.verdict === "REJECT" && decision.reasonCode !== undefined) {
    await recordPhotoReject(connector.people, { installerId: order.installerId, clockId: order.clockId, reason: decision.reasonCode, atSim: photo.atSim, workOrderId: order.workOrderId });
  }
  await connector.audit.append({
    ispId: order.ispId,
    clockId: order.clockId,
    atSim: photo.atSim,
    ...(ctx.identity.kind === "HARNESS" ? { trigger: ctx.identity.session.trigger } : {}),
    decision: "ACTION",
    action: PHOTO_VALIDATED_ACTION,
    ruleIds: [...decision.checks],
    actor: ctx.actor,
    messageId: photo.candidate.messageId,
    refs: { workOrderId: order.workOrderId, item, validationId, ...(evidenceId === undefined ? {} : { evidenceId }), ...(ctx.scope.turnId === undefined ? {} : { turnId: ctx.scope.turnId }) },
    detail: { verdict: decision.verdict, modelCalled: model !== undefined, ...(decision.reasonCode === undefined ? {} : { reasonCode: decision.reasonCode }), ...(model?.problem === undefined ? {} : { problem: model.problem }) },
  });
  const caseOpened = entry?.status === "REJECTED" && isPhotoAttemptsDue(decision.verdict, attempts) ? await openCaseIfDue(ctx, subject, attempts) : undefined;
  await reactToVerdict(ctx, photo, decision.verdict, validationId);
  const text = reasonText(item, decision.verdict, decision.reasonCode);
  const { serialMatches, readingDbm, wavelengthNm } = decision.readings;
  return {
    ok: true as const,
    validationId,
    verdict: decision.verdict,
    ...(decision.reasonCode === undefined ? {} : { reasonCode: decision.reasonCode }),
    ...(text === undefined ? {} : { reasonText: text }),
    readings: { ...(readingDbm === undefined ? {} : { readingDbm }), ...(wavelengthNm === undefined ? {} : { wavelengthNm }), ...(serialMatches === undefined ? {} : { serialMatches }) },
    attempts,
    ...(caseOpened === undefined ? {} : { caseOpened }),
  };
}
