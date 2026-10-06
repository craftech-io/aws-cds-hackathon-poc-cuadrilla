// `transcribe_voice_note` as the worker's `VoiceTranscriber` (worker/ports.ts) in the deployed Lambda:
// media/transcribe.ts over the stage's Transcribe and S3 clients (media/wiring.ts), with the world's
// epoch and operator settings read here, the poll bounded by what is left of the Lambda, the masked
// transcript stored on the message and the `TRANSCRIBED` / `LOW_CONFIDENCE` row written once per event.
import type { Connector } from "../connector/ports";
import { deployedVoiceNoteDeps } from "../media/wiring";
import { TRANSCRIBE_POLL } from "../media/config";
import type { VoiceNoteDeps, VoiceNoteOutcome } from "../media/transcribe";
import { transcribeVoiceNote } from "../media/transcribe";
import type { CostCapsDeps } from "../ops/cost-caps";
import type { TranscriptionOutcome, VoiceTranscriber, WorkerContext } from "./ports";

/** Time the worker keeps after the transcription for the safety check and the turn. */
const AFTER_TRANSCRIPTION_MS = 120_000;
const MIN_POLL_MS = 15_000;

/** The worker's outcome of a failed transcription: the notice it answers with (worker/inbound.ts). */
export function transcriptionOutcomeOf(outcome: Extract<VoiceNoteOutcome, { ok: false }>): TranscriptionOutcome {
  switch (outcome.reason) {
    case "LOW_CONFIDENCE":
      return { status: "LOW_CONFIDENCE", ...(outcome.confidence === undefined ? {} : { confidence: outcome.confidence }) };
    case "TOO_LONG":
      return { status: "TOO_LONG" };
    case "KILL_SWITCH_ACTIVE":
      return { status: "PAUSED" };
    case "CAP_REACHED":
      return { status: "CAP_REACHED" };
    default:
      return { status: "FAILED" };
  }
}

function pollBudgetMs(ctx: Pick<WorkerContext, "now" | "lambdaDeadlineMs">): number {
  const left = ctx.lambdaDeadlineMs - ctx.now().getTime() - AFTER_TRANSCRIPTION_MS;
  return Math.max(MIN_POLL_MS, Math.min(TRANSCRIBE_POLL.timeoutMs, left));
}

export function stageTranscriber(data: Connector, costs: CostCapsDeps, base: () => VoiceNoteDeps = () => deployedVoiceNoteDeps(costs)): VoiceTranscriber {
  let deps: VoiceNoteDeps | undefined;
  return {
    async transcribe(request, ctx) {
      const { message } = request;
      const media = message.media;
      if (media?.kind !== "AUDIO") return { status: "FAILED" };
      const [clock, settings] = await Promise.all([data.runtime.getClock(request.clockId), data.isps.getSettings(request.ispId)]);
      if (clock === undefined) return { status: "FAILED" };
      deps ??= base();
      const outcome = await transcribeVoiceNote(
        {
          ...deps,
          logger: ctx.log,
          pollTimeoutMs: pollBudgetMs(ctx),
          audit: async (event) => {
            await data.audit.append({
              ispId: request.ispId,
              clockId: request.clockId,
              atSim: message.sentAtSim,
              decision: "ACTION",
              action: event.action,
              ruleIds: [],
              actor: "WORKER",
              messageId: message.messageId,
              refs: { eventId: request.eventId },
              detail: { jobName: event.jobName, confidence: event.confidence, maskedKinds: [...event.maskedKinds], ...(event.durationSec === undefined ? {} : { durationSec: event.durationSec }) },
            });
          },
        },
        { clockId: request.clockId, worldEpoch: clock.worldEpoch, messageId: message.messageId, media: { s3Key: media.s3Key, mime: media.mime }, settings },
      );
      if (!outcome.ok) return transcriptionOutcomeOf(outcome);
      const { text, confidence } = outcome.transcript;
      await data.conversations.updateMessage({ personId: message.personId, sentAtSim: message.sentAtSim, messageId: message.messageId }, { transcript: { text, confidence } });
      return { status: "TRANSCRIBED", text, confidence, ...(outcome.durationSec === undefined ? {} : { durationSec: outcome.durationSec }) };
    },
  };
}
