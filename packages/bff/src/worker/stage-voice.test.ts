import { simMediaKey } from "@cuadrilla/shared/media/keys";
import { describe, expect, it } from "vitest";
import { createLogger } from "../lib/log";
import { TEST_MEDIA_BUCKET, TEST_TRANSCRIBE_CONFIG, createFakeTranscribe, createMemoryMediaObjects, m4aVoiceNote, seedVoiceNote } from "../media/testing";
import type { VoiceNoteDeps } from "../media/transcribe";
import { createKillSwitchReader } from "../ops/kill-switch";
import { createMemoryRuntimeStore } from "../ops/memory-runtime-store";
import type { WorkerContext } from "./ports";
import { stageTranscriber, transcriptionOutcomeOf } from "./stage-voice";
import { CLOCK, ISP, ROGELIO, inboundMessage, seedWorld, workerKit } from "./testing";

const silent = createLogger({ level: "error", sink: () => undefined });

async function voiceKit(bytes: Uint8Array, mime = "audio/ogg") {
  const kit = workerKit();
  await seedWorld(kit);
  const objects = createMemoryMediaObjects();
  const key = simMediaKey(CLOCK, 3, "up01JA2B3C4D");
  objects.put({ bucket: TEST_MEDIA_BUCKET, key }, bytes);
  const store = createMemoryRuntimeStore();
  const realClock = { now: async () => kit.tools.memory.now() };
  const deps: VoiceNoteDeps = {
    transcribe: createFakeTranscribe({ objects }),
    objects,
    config: () => TEST_TRANSCRIBE_CONFIG,
    mediaBucket: () => TEST_MEDIA_BUCKET,
    costs: { store, kill: createKillSwitchReader({ store, realClock }), globalCaps: () => ({ turnsPerDay: 100, validationsPerDay: 50, transcribeSecondsPerDay: 1_000 }), realClock, logger: silent },
    realClock,
    sleep: async () => undefined,
  };
  const message = await inboundMessage(kit, { content: "VOICE", text: undefined, media: { kind: "AUDIO", s3Key: key, mime } });
  const ctx: WorkerContext = { log: silent, sink: kit.deps.sink, now: () => kit.tools.memory.now(), receiveCount: 1, lambdaDeadlineMs: kit.tools.memory.now().getTime() + 340_000 };
  return { kit, message, ctx, transcriber: stageTranscriber(kit.connector, deps.costs, () => deps) };
}

describe("worker: transcribe_voice_note in the deployed worker (FL-017, FL-018)", () => {
  it("[FL-017] stores the masked transcript on the message and audits TRANSCRIBED once", async () => {
    const { kit, message, ctx, transcriber } = await voiceKit(seedVoiceNote("vn-01"));
    const outcome = await transcriber.transcribe({ clockId: CLOCK, ispId: ISP, installerId: ROGELIO, message, eventId: "wa-in-0001" }, ctx);
    expect(outcome).toMatchObject({ status: "TRANSCRIBED", confidence: 0.93 });
    const stored = await kit.connector.conversations.getMessage({ personId: ROGELIO, sentAtSim: message.sentAtSim, messageId: message.messageId });
    expect(stored?.transcript?.text).toContain("la ONU no prende la luz PON");
    const audit = (await kit.connector.audit.listByMonth(ISP, "2026-10")).filter((row) => row.action === "TRANSCRIBED");
    expect(audit).toHaveLength(1);
  });

  it("[FL-018] answers TOO_LONG for a voice note over the limit, without a job", async () => {
    const { message, ctx, transcriber } = await voiceKit(m4aVoiceNote(150), "audio/mp4");
    expect(await transcriber.transcribe({ clockId: CLOCK, ispId: ISP, installerId: ROGELIO, message, eventId: "wa-in-0002" }, ctx)).toEqual({ status: "TOO_LONG" });
  });

  it("maps each failure of media/ to the notice the worker answers with", () => {
    expect(transcriptionOutcomeOf({ ok: false, notice: "voiceUnclear", reason: "LOW_CONFIDENCE", confidence: 0.3 })).toEqual({ status: "LOW_CONFIDENCE", confidence: 0.3 });
    expect(transcriptionOutcomeOf({ ok: false, notice: "servicePaused", reason: "KILL_SWITCH_ACTIVE" })).toEqual({ status: "PAUSED" });
    expect(transcriptionOutcomeOf({ ok: false, notice: "turnCap", reason: "CAP_REACHED" })).toEqual({ status: "CAP_REACHED" });
    expect(transcriptionOutcomeOf({ ok: false, notice: "voiceFailed", reason: "JOB_FAILED" })).toEqual({ status: "FAILED" });
  });
});
