// `validate_install_photo` (docs/tool-catalog.md, docs/design-brief.md §5.10, ADR-0015). In order:
//
//   1. LAM-SCOPE      the active order of the session (a caller's subject), still being worked on
//   2. LAM-CANDIDATE  a photo the installer sent on that order, in that world (evidence/candidate.ts)
//   3. pre-checks     its bytes from `Media`: type by magic bytes, ≤ 3.75 MB, VAL-DUPLICATE inside the
//                     world and its epoch (no model call for a duplicate)
//   4. evidence copy  JPEG without metadata (a PNG converted); one that cannot be kept → fixed notice
//   5. reserve_cost   the world's and the stage's validation caps, before any spend
//   6. validator      the isolated `Converse` and the deterministic checks (evidence/validator.ts)
//   7. record         evidence, validation, checklist, profile, audit, case, reaction (record.ts)
//
// The model's text never reaches the agent: the output is the verdict, its reason code and the fixed
// text of copy/es-MX.ts, whether the serial matched (never a serial), and the attempts.
import { ToolError } from "@cuadrilla/shared";
import type { NetworkReader } from "@cuadrilla/network-contract";
import { sha256Hex } from "../../lib/crypto";
import { type CostAuditEvent, costFailure, reserveCost } from "../../ops/cost-caps";
import { findCandidate } from "../../evidence/candidate";
import { MAX_PHOTO_BYTES, VAL_RULE, duplicateEvidence, precheckPhoto } from "../../evidence/checks";
import { normalizeEvidencePhoto } from "../../evidence/strip-metadata";
import { validatePhoto } from "../../evidence/validator";
import { type ToolContext, implementTool } from "../common/context";
import { auditToolDenial } from "../common/denials";
import { requireActiveWorkOrder } from "../common/scope";
import { assertWorkable, businessNow } from "./order-state";
import { type PhotoRef, noticeUnusablePhoto } from "./reaction";
import { keepEvidenceCopy, recordValidation } from "./record";
import type { EvidenceToolRuntime } from "./runtime";
import { validateInstallPhotoTool } from "./schema";

export const CANDIDATE_RULE = "LAM-CANDIDATE";
export const VALIDATE_ACTION = "VALIDATE_PHOTO";

type Ctx = ToolContext<EvidenceToolRuntime>;

async function unusable(ctx: Ctx, photo: PhotoRef, notice: "imageUnreadable" | "imageTooLarge", problem: string): Promise<never> {
  const told = await noticeUnusablePhoto(ctx, photo, notice);
  ctx.logger.warn("evidence.photo.unusable", { problem, notice, told });
  throw new ToolError(
    "INVALID",
    told ? "that photo cannot be used as evidence; the installer already got the fixed notice, ask for a new photo" : "that photo cannot be used as evidence; ask the installer for a new photo",
    problem,
  );
}

/** The world's and the stage's validation caps (ADR-0019), reserved before `Converse`. */
async function reserveValidation(ctx: Ctx, atSim: string, idempotencyKey: string) {
  const settings = await ctx.deps.connector.isps.getSettings(ctx.scope.ispId);
  const audit = async (event: CostAuditEvent) => {
    await ctx.deps.connector.audit.append({
      ispId: ctx.scope.ispId,
      clockId: ctx.scope.clockId,
      atSim,
      decision: "DENY",
      action: VALIDATE_ACTION,
      actor: ctx.actor,
      reason: event.code,
      refs: { ...(ctx.scope.workOrderId === undefined ? {} : { workOrderId: ctx.scope.workOrderId }), ...(ctx.scope.turnId === undefined ? {} : { turnId: ctx.scope.turnId }) },
      detail: { resource: event.resource, ...(event.code === "CAP_REACHED" ? { ledger: event.counter.ledger, period: event.counter.period } : { scope: event.scope }) },
    });
  };
  return reserveCost(
    { store: ctx.deps.capStore, globalCaps: ctx.deps.globalCaps, kill: ctx.deps.killSwitch, realClock: ctx.deps.realClock, logger: ctx.logger, audit },
    { world: { clockId: ctx.scope.clockId, settings: settings ?? {} }, resource: "validations", amount: 1, reserve: ["SIMULATOR", "GLOBAL"], surface: "AGENT", idempotencyKey },
  );
}

export const validateInstallPhoto = implementTool(validateInstallPhotoTool, async (args, ctx: Ctx) => {
  const { connector } = ctx.deps;
  const order = await requireActiveWorkOrder(ctx);
  assertWorkable(order);
  const installerId = order.installerId;
  const candidate = await findCandidate(connector.conversations, { installerId, clockId: ctx.scope.clockId, workOrderId: order.workOrderId, candidateId: args.candidateId });
  if (candidate?.media === undefined) {
    await auditToolDenial(ctx, { ruleIds: [CANDIDATE_RULE], reason: "the candidate is not a photo the installer sent on this order", refs: { workOrderId: order.workOrderId, candidateId: args.candidateId } });
    throw new ToolError("FORBIDDEN", "that candidateId is not a photo the installer sent on this order", CANDIDATE_RULE);
  }
  const atSim = await businessNow(ctx);
  const photo: PhotoRef = { candidate, workOrderId: order.workOrderId, installerId, atSim };

  const read = await ctx.deps.objects.readMedia(candidate.media.s3Key, MAX_PHOTO_BYTES);
  if (!read.ok) return unusable(ctx, photo, read.problem === "TOO_LARGE" ? "imageTooLarge" : "imageUnreadable", `MEDIA_${read.problem}`);
  const typed = precheckPhoto(read.bytes);
  if (!typed.ok) return unusable(ctx, photo, typed.problem === "TOO_LARGE" ? "imageTooLarge" : "imageUnreadable", typed.problem);
  const sha256 = sha256Hex(read.bytes);
  const base = { order, item: args.item, candidateId: args.candidateId, photo, sha256 };

  const duplicate = duplicateEvidence(await connector.workOrders.findEvidenceByHash(order.clockId, order.worldEpoch, sha256), order.workOrderId);
  if (duplicate !== undefined) {
    ctx.logger.info("evidence.duplicate", { workOrderId: order.workOrderId, otherWorkOrderId: duplicate.workOrderId });
    return recordValidation(ctx, { ...base, decision: { verdict: "REJECT", reasonCode: "DUPLICATE_EVIDENCE", checks: [VAL_RULE.DUPLICATE], readings: {} } });
  }

  const normalized = normalizeEvidencePhoto(read.bytes, typed.type);
  if (!normalized.ok) return unusable(ctx, photo, "imageUnreadable", normalized.problem);
  if (normalized.jpeg.length > MAX_PHOTO_BYTES) return unusable(ctx, photo, "imageTooLarge", "CONVERTED_TOO_LARGE");

  const reserved = await reserveValidation(ctx, atSim, `validate#${ctx.scope.turnId ?? ctx.scope.eventId ?? ctx.correlationId}#${args.candidateId}#${args.item}`);
  if (!reserved.ok) return costFailure(reserved);

  const reader: NetworkReader = ctx.identity.kind === "HARNESS" ? "HARNESS" : "QA";
  const outcome = await validatePhoto({ item: args.item, order, jpeg: normalized.jpeg, reader, atSim }, { photoModel: ctx.deps.photoModel, reference: connector.reference, isps: connector.isps, network: ctx.deps.network, logger: ctx.logger });
  if (outcome.kind === "UNAVAILABLE") {
    throw new ToolError("UNAVAILABLE", "the photo check is not available right now: ask the installer to send the photo again in a moment", "VALIDATOR_UNAVAILABLE");
  }
  const evidenceId = await keepEvidenceCopy(ctx, { ...base, jpeg: normalized.jpeg });
  return recordValidation(ctx, { ...base, decision: outcome.decision, model: outcome.model, rubricVersion: outcome.rubricVersion, evidenceId });
});
