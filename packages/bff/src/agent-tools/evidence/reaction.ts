// What the installer sees of a validation before the agent writes (FL-103): the photo message gets a
// reaction with the final verdict, ✅ for PASS and 🔁 for REJECT or UNSURE (never ✅ on anything but a
// PASS), as a `VERDICT_REACTION` of the outbound pipeline, before the tool returns. A photo that
// cannot be kept (unreadable bytes, too large after conversion) gets the fixed notice instead. Both
// only inside a turn of the Harness: a validation the QaDriver invokes (`EV-02`, steps of `SC-04`)
// has no turn and no installer waiting, so it reacts to nothing. A failure of the pipeline never
// undoes the validation: it is logged.
import type { Verdict } from "@cuadrilla/shared";
import type { Message } from "../../domain/conversations";
import type { PhotoNoticeRequest, VerdictEmoji } from "../../evidence/ports";
import type { ToolContext } from "../common/context";
import type { EvidenceToolRuntime } from "./runtime";

export function verdictEmoji(verdict: Verdict): VerdictEmoji {
  return verdict === "PASS" ? "✅" : "🔁";
}

export interface PhotoRef {
  readonly candidate: Message;
  readonly workOrderId: string;
  readonly installerId: string;
  readonly atSim: string;
}

function messageRef(ctx: ToolContext<EvidenceToolRuntime>, photo: PhotoRef) {
  return {
    ispId: ctx.scope.ispId,
    clockId: ctx.scope.clockId,
    installerId: photo.installerId,
    workOrderId: photo.workOrderId,
    messageId: photo.candidate.messageId,
    atSim: photo.atSim,
    correlationId: ctx.correlationId,
    ...(ctx.scope.turnId === undefined ? {} : { turnId: ctx.scope.turnId }),
  };
}

/** One reaction per validated photo, inside a Harness turn; `true` when it was handed to the pipeline. */
export async function reactToVerdict(ctx: ToolContext<EvidenceToolRuntime>, photo: PhotoRef, verdict: Verdict, validationId: string): Promise<boolean> {
  if (ctx.identity.kind !== "HARNESS") return false;
  try {
    await ctx.deps.outbound.reactToPhoto({ ...messageRef(ctx, photo), emoji: verdictEmoji(verdict), verdict, validationId });
    return true;
  } catch (error) {
    ctx.logger.error("evidence.reaction.failed", { validationId, verdict, error });
    return false;
  }
}

/** The fixed notice of a photo that cannot be kept as evidence, inside a Harness turn. */
export async function noticeUnusablePhoto(ctx: ToolContext<EvidenceToolRuntime>, photo: PhotoRef, notice: PhotoNoticeRequest["notice"]): Promise<boolean> {
  if (ctx.identity.kind !== "HARNESS") return false;
  try {
    await ctx.deps.outbound.photoNotice({ ...messageRef(ctx, photo), notice });
    return true;
  } catch (error) {
    ctx.logger.error("evidence.notice.failed", { notice, error });
    return false;
  }
}
