// The worker's fixed notices to the installer (docs/design-brief.md §5.1): `servicePaused` while the agent
// is cut, `turnCap` over a cap, `guardrailRefusal` after a block, `agentFallback` when a turn fails or
// leaves the installer without an answer, and the voice notices. Each text has one source,
// copy/es-MX.ts; each send goes through the outbound pipeline (WorkerNoticeSender), so the contact
// policy, the transport of the recipient and the audit log see it like any other `SYSTEM_NOTICE`.
//
// A notice is sent once per event and key: the mark (`IDEMP#NOTICE:<key>#<eventId>`) is written after the
// send, so an event that goes back to the queue never repeats a notice that went out, and a Lambda that
// died before sending it sends it on the redelivery (the pipeline replays a message id it already sent:
// the notice's id derives from the event, outbound/adapters.ts). A failed send is logged and never fails
// the event: a notice must not make the worker run a turn again.
import type { RuntimePort } from "../connector/ports";
import { esMX } from "../copy/es-MX";
import type { WorkerContext, WorkerNoticeKey, WorkerNoticeSender } from "./ports";

export interface NoticeTarget {
  readonly clockId: string;
  readonly ispId: string;
  readonly installerId: string;
  readonly eventId: string;
  readonly workOrderId?: string;
  /** The inbound message the notice answers. */
  readonly replyToMessageId?: string;
}

/** Where a turn's fixed notice goes: the turn's installer, answering the turn's message. */
export function noticeTargetOf(
  request: { readonly clockId: string; readonly ispId: string; readonly installerId: string; readonly eventId: string; readonly message?: { readonly messageId: string } },
  workOrderId: string | undefined,
): NoticeTarget {
  return {
    clockId: request.clockId,
    ispId: request.ispId,
    installerId: request.installerId,
    eventId: request.eventId,
    ...(workOrderId === undefined ? {} : { workOrderId }),
    ...(request.message === undefined ? {} : { replyToMessageId: request.message.messageId }),
  };
}

export interface NoticeDeps {
  readonly notices: WorkerNoticeSender;
  readonly runtime: Pick<RuntimePort, "claimIdempotency" | "getIdempotency">;
}

export const NOTICE_TEXTS: Readonly<Record<WorkerNoticeKey, string>> = {
  servicePaused: esMX.servicePaused,
  agentFallback: esMX.agentFallback,
  turnCap: esMX.turnCap,
  guardrailRefusal: esMX.guardrailRefusal,
  voiceUnclear: esMX.voiceUnclear,
  voiceTooLong: esMX.voiceTooLong,
  voiceFailed: esMX.voiceFailed,
};

/** Sends the fixed notice once per event; `false` when it was already sent or could not be sent. */
export async function sendWorkerNotice(deps: NoticeDeps, ctx: Pick<WorkerContext, "log">, target: NoticeTarget, notice: WorkerNoticeKey): Promise<boolean> {
  const source = `NOTICE:${notice}`;
  if ((await deps.runtime.getIdempotency(source, target.eventId)) !== undefined) return false;
  try {
    await deps.notices.send({
      clockId: target.clockId,
      ispId: target.ispId,
      personId: target.installerId,
      notice,
      text: NOTICE_TEXTS[notice],
      eventId: target.eventId,
      ...(target.workOrderId === undefined ? {} : { workOrderId: target.workOrderId }),
      ...(target.replyToMessageId === undefined ? {} : { replyToMessageId: target.replyToMessageId }),
    });
  } catch (error) {
    ctx.log.error("worker.notice_failed", { notice, cause: error instanceof Error ? error.name : "unknown" });
    return false;
  }
  await deps.runtime.claimIdempotency(source, target.eventId).catch((error: unknown) => ctx.log.warn("worker.notice_mark_failed", { notice, cause: error instanceof Error ? error.name : "unknown" }));
  return true;
}
