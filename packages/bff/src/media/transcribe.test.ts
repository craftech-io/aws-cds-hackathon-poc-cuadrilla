import { createHash } from "node:crypto";
import type { GetCommand } from "@aws-sdk/lib-dynamodb";
import { OUTPUT_KEY_PATTERN, mediaFileUri, simMediaKey, transcriptOutputKey, waMediaKey } from "@cuadrilla/shared/media/keys";
import { describe, expect, it } from "vitest";
import type { Clock } from "../lib/clock";
import { createLogger } from "../lib/log";
import type { CostCapsDeps, GlobalCostCaps } from "../ops/cost-caps";
import { createKillSwitchReader, setKillSwitch } from "../ops/kill-switch";
import { createMemoryRuntimeStore } from "../ops/memory-runtime-store";
import { TRANSCRIBE_POLL, transcriptionJobName } from "./config";
import { type TranscribeFault, runtimeTranscribeFaultReader } from "./faults";
import { type FakeJobScript, TEST_MEDIA_BUCKET, TEST_TRANSCRIBE_CONFIG, createFakeTranscribe, createMemoryMediaObjects, m4aVoiceNote, seedVoiceNote, webmVoiceNote } from "./testing";
import { type TranscriptionAuditEvent, type VoiceNoteDeps, type VoiceNoteRequest, transcribeVoiceNote } from "./transcribe";

const REAL = Date.parse("2026-10-20T15:20:00.000Z");
const DAY = "2026-10-20";
const GLOBAL_CAPS: GlobalCostCaps = { turnsPerDay: 1500, validationsPerDay: 400, transcribeSecondsPerDay: 5400 };
const GUEST_TEST = "GUEST#isp-guest-test";
const GUEST_07 = "GUEST#isp-guest-07";
const DEMO = "GLOBAL#isp-demo";
const QA = "qa-r20261020a-sc-14";
const SETTINGS = { simulatorCaps: { transcribeSecPerDay: 1800 } };
const WAMID = "wamid.SIM.01JA2B3C4D5E6F7G8H9J0K1M2N";

function movableClock(): Clock & { advance(ms: number): void } {
  let now = REAL;
  return { now: async () => new Date(now), advance: (ms) => void (now += ms) };
}

interface SetupOptions {
  readonly script?: (key: string | undefined) => FakeJobScript;
  readonly globalCaps?: GlobalCostCaps;
  readonly fault?: TranscribeFault;
  readonly pollsBeforeDone?: number;
}

function setup(options: SetupOptions = {}) {
  const objects = createMemoryMediaObjects();
  const clock = movableClock();
  const store = createMemoryRuntimeStore();
  const kill = createKillSwitchReader({ store, realClock: clock });
  const lines: string[] = [];
  const logger = createLogger({ level: "info", sink: (line) => lines.push(line) });
  const transcribe = createFakeTranscribe({
    objects,
    ...(options.pollsBeforeDone === undefined ? {} : { pollsBeforeDone: options.pollsBeforeDone }),
    ...(options.script === undefined ? {} : { script: (input) => options.script?.(input.Media?.MediaFileUri) ?? "NEVER" }),
  });
  const costs: CostCapsDeps = { store, kill, globalCaps: () => options.globalCaps ?? GLOBAL_CAPS, realClock: clock, logger };
  const audits: TranscriptionAuditEvent[] = [];
  const faultReads: string[] = [];
  const deps: VoiceNoteDeps = {
    transcribe,
    objects,
    config: () => TEST_TRANSCRIBE_CONFIG,
    mediaBucket: () => TEST_MEDIA_BUCKET,
    costs,
    faults: { transcribeFault: async (clockId) => (faultReads.push(clockId), clockId.startsWith("qa-") ? options.fault : undefined) },
    realClock: clock,
    sleep: async (ms) => clock.advance(ms),
    audit: async (event) => void audits.push(event),
    logger,
  };
  const used = (key: string): number => Number(store.items.get(key)?.used ?? 0);
  return { objects, clock, store, kill, transcribe, deps, audits, lines, used, faultReads };
}


/** A simulator voice note of `clockId` stored where the channel put it, and its request. */
function voiceNote(env: ReturnType<typeof setup>, clockId: string, bytes: Uint8Array, mime = "audio/ogg", messageId = WAMID, uploadId = "up01JA2B3C4D"): VoiceNoteRequest {
  const key = simMediaKey(clockId, 0, uploadId);
  env.objects.put({ bucket: TEST_MEDIA_BUCKET, key }, bytes);
  return { clockId, worldEpoch: 0, messageId, media: { s3Key: key, mime }, settings: SETTINGS };
}

const outputLocation = (clockId: string, messageId = WAMID) => {
  const jobName = transcriptionJobName(clockId, 0, messageId);
  return { bucket: TEST_MEDIA_BUCKET, key: transcriptOutputKey(clockId, 0, messageId, jobName) };
};

describe("transcriptionJobName [FL-017]", () => {
  it("is cuadrilla-poc- and the first 32 hex of sha256(clockId ‖ worldEpoch ‖ messageId)", () => {
    const expected = createHash("sha256").update(`${GUEST_TEST}|3|${WAMID}`).digest("hex").slice(0, 32);
    expect(transcriptionJobName(GUEST_TEST, 3, WAMID)).toBe(`cuadrilla-poc-${expected}`);
    expect(transcriptionJobName(GUEST_TEST, 3, WAMID)).toMatch(/^cuadrilla-poc-[0-9a-f]{32}$/);
  });

  it("differs by world, epoch and message, and never carries the raw clock id", () => {
    const names = new Set([transcriptionJobName(DEMO, 0, WAMID), transcriptionJobName(GUEST_07, 0, WAMID), transcriptionJobName(DEMO, 1, WAMID), transcriptionJobName(DEMO, 0, `${WAMID}x`)]);
    expect(names.size).toBe(4);
    for (const name of names) expect(name).not.toContain("#");
  });
});

describe("transcribeVoiceNote [FL-017]", () => {
  it("transcribes vn-01 in GUEST#isp-guest-test with the keys of media/keys.ts and deletes the output and the job", async () => {
    const env = setup();
    const request = voiceNote(env, GUEST_TEST, seedVoiceNote("vn-01"));
    const outcome = await transcribeVoiceNote(env.deps, request);

    expect(outcome).toMatchObject({ ok: true, transcript: { text: "Ya estoy con la señora Treviño, la ONU no prende la luz PON.", confidence: 0.93 } });
    if (!outcome.ok) throw new Error("expected a transcript");
    expect(outcome.durationSec).toBeCloseTo(3.19, 1);
    const jobName = transcriptionJobName(GUEST_TEST, 0, WAMID);
    expect(outcome.jobName).toBe(jobName);

    const [input] = env.transcribe.started;
    const output = outputLocation(GUEST_TEST);
    expect(input).toEqual({
      TranscriptionJobName: jobName,
      LanguageCode: "es-MX",
      MediaFormat: "ogg",
      Media: { MediaFileUri: mediaFileUri(TEST_MEDIA_BUCKET, request.media.s3Key) },
      OutputBucketName: TEST_MEDIA_BUCKET,
      OutputKey: output.key,
      Settings: { VocabularyName: "cuadrilla-poc-ftth-es-mx" },
      Tags: [{ Key: "Project", Value: "aws-cds-hackathon-poc-cuadrilla" }],
    });
    expect(input?.OutputKey).toMatch(OUTPUT_KEY_PATTERN);
    for (const value of [input?.OutputKey, input?.Media?.MediaFileUri]) for (const forbidden of ["#", "?", "+", "=", " ", "isp-guest-test"]) expect(value).not.toContain(forbidden);

    expect(env.objects.has(output)).toBe(false);
    expect(env.objects.deleted).toContain(`${output.bucket}/${output.key}`);
    expect(env.transcribe.deletedJobs).toEqual([jobName]);
    expect(env.audits).toEqual([expect.objectContaining({ action: "TRANSCRIBED", jobName, messageId: WAMID, confidence: 0.93 })]);
    expect(env.lines.some((line) => line.includes("TranscribeLatency"))).toBe(true);
    expect(env.lines.join("\n")).not.toContain("Treviño");
  });

  it("reserves the world's cap and the stage's ceiling before starting the job, once per message", async () => {
    const env = setup();
    const request = voiceNote(env, DEMO, seedVoiceNote("vn-01"));
    const order: string[] = [];
    const reserve = env.store.reserve.bind(env.store);
    env.deps.costs.store.reserve = async (counters, options) => (order.push("reserve"), reserve(counters, options));
    const start = env.transcribe.start.bind(env.transcribe);
    const deps: VoiceNoteDeps = { ...env.deps, transcribe: { ...env.transcribe, start: async (job) => (order.push("start"), start(job)) } };

    await transcribeVoiceNote(deps, request);
    await transcribeVoiceNote(deps, request);
    expect(order.slice(0, 2)).toEqual(["reserve", "start"]);
    expect(env.used(`TRANSCRIBE#GLOBAL#${DAY}`)).toBe(4);
    expect(env.used(`SIMCAP#${DEMO}#transcribe#${DAY}`)).toBe(4);
  });

  it("gives two concurrent messages with identical bytes in different worlds their own job and output key", async () => {
    const env = setup();
    const bytes = seedVoiceNote("vn-01");
    const demo = voiceNote(env, DEMO, bytes);
    const guest = voiceNote(env, GUEST_07, bytes);
    const [a, b] = await Promise.all([transcribeVoiceNote(env.deps, demo), transcribeVoiceNote(env.deps, guest)]);

    expect(a.ok && b.ok).toBe(true);
    const [first, second] = env.transcribe.started;
    expect(first?.TranscriptionJobName).not.toBe(second?.TranscriptionJobName);
    expect(first?.OutputKey).not.toBe(second?.OutputKey);
    expect(first?.Media?.MediaFileUri).not.toBe(second?.Media?.MediaFileUri);
    expect(new Set(env.transcribe.deletedJobs).size).toBe(2);
  });

  it("maps ogg, webm and mp4 (and MIME parameters) to their MediaFormat", async () => {
    const env = setup();
    const cases = [
      { bytes: seedVoiceNote("vn-01"), mime: "audio/ogg; codecs=opus", format: "ogg" },
      { bytes: webmVoiceNote(4), mime: "audio/webm", format: "webm" },
      { bytes: m4aVoiceNote(5), mime: "audio/mp4", format: "mp4" },
    ];
    for (const [index, entry] of cases.entries()) {
      const outcome = await transcribeVoiceNote(env.deps, voiceNote(env, DEMO, entry.bytes, entry.mime, `${WAMID}${index}`, `up${index}`));
      expect(outcome.ok).toBe(true);
      expect(env.transcribe.started[index]?.MediaFormat).toBe(entry.format);
    }
  });

  it("transcribes a live voice note stored under waMediaKey", async () => {
    const env = setup();
    const key = waMediaKey("wamid.HBgNNTIxNTUwMTAxMDAwMRUCABIYFjNFQjBDNzVGRjc5QjA2RjQ0RkE4MDQA+/=", "1037543291543636");
    env.objects.put({ bucket: TEST_MEDIA_BUCKET, key }, seedVoiceNote("vn-01"));
    const outcome = await transcribeVoiceNote(env.deps, { clockId: DEMO, worldEpoch: 0, messageId: "wamid.HBgN+/=", media: { s3Key: key, mime: "audio/ogg" }, settings: {} });
    expect(outcome.ok).toBe(true);
    expect(env.transcribe.started[0]?.Media?.MediaFileUri).toBe(`s3://${TEST_MEDIA_BUCKET}/${key}`);
  });

  it("masks sensitive data in the transcript before returning it", async () => {
    const env = setup({ script: () => ({ text: "El cliente dice que su teléfono es 5512345678 y la ONU parpadea", confidence: 0.9 }) });
    const outcome = await transcribeVoiceNote(env.deps, voiceNote(env, DEMO, seedVoiceNote("vn-01")));
    if (!outcome.ok) throw new Error("expected a transcript");
    expect(outcome.transcript.text).not.toContain("5512345678");
    expect(outcome.transcript.text).toContain("[TELEFONO]");
    expect(outcome.maskedKinds).toContain("PHONE");
  });
});

describe("transcribeVoiceNote, ConflictException and NotFoundException [FL-017]", () => {
  it("polls the existing job of the same message instead of starting a second one (retry of the event)", async () => {
    const env = setup();
    const request = voiceNote(env, GUEST_TEST, seedVoiceNote("vn-01"));
    const jobName = transcriptionJobName(GUEST_TEST, 0, WAMID);
    await env.transcribe.start({ jobName, mediaFileUri: mediaFileUri(TEST_MEDIA_BUCKET, request.media.s3Key), mediaFormat: "ogg", outputKey: outputLocation(GUEST_TEST).key });

    const outcome = await transcribeVoiceNote(env.deps, request);
    expect(outcome.ok).toBe(true);
    expect(env.transcribe.startCalls).toEqual([jobName, jobName]);
    expect(env.transcribe.started).toHaveLength(1);
  });

  it("reads the output when the job was deleted by an earlier attempt but the output is still there", async () => {
    const env = setup({ pollsBeforeDone: 0 });
    const request = voiceNote(env, DEMO, seedVoiceNote("vn-01"));
    const jobName = transcriptionJobName(DEMO, 0, WAMID);
    const get = env.transcribe.get.bind(env.transcribe);
    let polls = 0;
    const deps: VoiceNoteDeps = {
      ...env.deps,
      transcribe: {
        ...env.transcribe,
        // The first read completes the job (writing its output); then the other attempt deletes the job.
        get: async (name) => (polls += 1) === 1 ? (await get(name), env.transcribe.forget(name), undefined) : get(name),
      },
    };
    const outcome = await transcribeVoiceNote(deps, request);
    expect(outcome.ok).toBe(true);
    expect(env.transcribe.startCalls).toEqual([jobName]);
    expect(env.objects.has(outputLocation(DEMO))).toBe(false);
  });

  it("starts the job again once when the job and its output are both gone", async () => {
    const env = setup();
    const request = voiceNote(env, DEMO, seedVoiceNote("vn-01"));
    const get = env.transcribe.get.bind(env.transcribe);
    let lost = false;
    const deps: VoiceNoteDeps = { ...env.deps, transcribe: { ...env.transcribe, get: async (name) => (lost ? get(name) : ((lost = true), env.transcribe.forget(name), undefined)) } };
    const outcome = await transcribeVoiceNote(deps, request);
    expect(outcome.ok).toBe(true);
    expect(env.transcribe.started).toHaveLength(2);
  });

  it("restarts a COMPLETED job whose output an earlier attempt already deleted", async () => {
    const env = setup();
    const request = voiceNote(env, DEMO, seedVoiceNote("vn-01"));
    const read = env.objects.read.bind(env.objects);
    let first = true;
    const deps: VoiceNoteDeps = { ...env.deps, objects: { ...env.objects, read: async (location, max) => (location.key.startsWith("transcripts/") && first ? ((first = false), undefined) : read(location, max)) } };
    const outcome = await transcribeVoiceNote(deps, request);
    expect(outcome.ok).toBe(true);
    expect(env.transcribe.started).toHaveLength(2);
    expect(env.transcribe.deletedJobs.length).toBeGreaterThanOrEqual(2);
  });

  it("answers voiceFailed when the job is lost twice", async () => {
    const env = setup();
    const request = voiceNote(env, DEMO, seedVoiceNote("vn-01"));
    const deps: VoiceNoteDeps = { ...env.deps, transcribe: { ...env.transcribe, get: async (name) => (env.transcribe.forget(name), undefined) } };
    expect(await transcribeVoiceNote(deps, request)).toMatchObject({ ok: false, notice: "voiceFailed", reason: "JOB_LOST" });
    expect(env.transcribe.started).toHaveLength(2);
  });
});

describe("transcribeVoiceNote, limits and low confidence [FL-018]", () => {
  it("refuses vn-10 (over 120 s by its container) without a job and deletes it", async () => {
    const env = setup();
    const request = voiceNote(env, DEMO, seedVoiceNote("vn-10"));
    const outcome = await transcribeVoiceNote(env.deps, request);
    expect(outcome).toMatchObject({ ok: false, notice: "voiceTooLong", reason: "TOO_LONG", mediaDeleted: true });
    expect(env.transcribe.startCalls).toEqual([]);
    expect(env.objects.has({ bucket: TEST_MEDIA_BUCKET, key: request.media.s3Key })).toBe(false);
    expect(env.used(`TRANSCRIBE#GLOBAL#${DAY}`)).toBe(0);
  });

  it("refuses a 150 s browser recording (mp4 and webm)", async () => {
    const env = setup();
    for (const [index, [bytes, mime]] of ([[m4aVoiceNote(150), "audio/mp4"], [webmVoiceNote(150), "audio/webm"]] as const).entries()) {
      expect(await transcribeVoiceNote(env.deps, voiceNote(env, DEMO, bytes, mime, `${WAMID}${index}`, `up${index}`))).toMatchObject({ notice: "voiceTooLong" });
    }
    expect(env.transcribe.startCalls).toEqual([]);
  });

  it("falls back to 2 MB when the container declares no duration, and reserves 120 s for what passes", async () => {
    const env = setup();
    const unknown = webmVoiceNote();
    const big = new Uint8Array(2 * 1024 * 1024 + 1);
    big.set(unknown);
    expect(await transcribeVoiceNote(env.deps, voiceNote(env, DEMO, big, "audio/webm", `${WAMID}a`, "upa"))).toMatchObject({ notice: "voiceTooLong" });
    expect(env.transcribe.startCalls).toEqual([]);
    expect(await transcribeVoiceNote(env.deps, voiceNote(env, DEMO, unknown, "audio/webm", `${WAMID}b`, "upb"))).toMatchObject({ ok: true });
    expect(env.used(`TRANSCRIBE#GLOBAL#${DAY}`)).toBe(120);
  });

  it("refuses what is not a voice note: another MIME type, bytes of another type, a missing object", async () => {
    const env = setup();
    expect(await transcribeVoiceNote(env.deps, voiceNote(env, DEMO, seedVoiceNote("vn-01"), "audio/mpeg"))).toMatchObject({ notice: "voiceFailed", reason: "UNSUPPORTED_FORMAT" });
    expect(await transcribeVoiceNote(env.deps, voiceNote(env, DEMO, new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]), "audio/ogg"))).toMatchObject({ notice: "voiceFailed", reason: "NOT_AUDIO" });
    const missing = { clockId: DEMO, worldEpoch: 0, messageId: WAMID, media: { s3Key: simMediaKey(DEMO, 0, "nothing"), mime: "audio/ogg" }, settings: {} };
    expect(await transcribeVoiceNote(env.deps, missing)).toMatchObject({ notice: "voiceFailed", reason: "MEDIA_MISSING" });
    expect(env.transcribe.startCalls).toEqual([]);
  });

  it("answers voiceUnclear below 0.55 and on empty text, with TranscribeLowConfidence and LOW_CONFIDENCE", async () => {
    const scripts: Record<string, FakeJobScript> = {};
    const env = setup({ script: (uri) => scripts[uri ?? ""] ?? "NEVER" });
    const noisy = voiceNote(env, DEMO, seedVoiceNote("vn-09"), "audio/ogg", `${WAMID}n`, "noisy");
    const silent = voiceNote(env, DEMO, seedVoiceNote("vn-01"), "audio/ogg", `${WAMID}s`, "silent");
    const edge = voiceNote(env, DEMO, seedVoiceNote("vn-01"), "audio/ogg", `${WAMID}e`, "edge");
    scripts[mediaFileUri(TEST_MEDIA_BUCKET, noisy.media.s3Key)] = { text: "eh mm la", confidence: 0.41 };
    scripts[mediaFileUri(TEST_MEDIA_BUCKET, silent.media.s3Key)] = { text: "", confidence: 0 };
    scripts[mediaFileUri(TEST_MEDIA_BUCKET, edge.media.s3Key)] = { text: "la ONU prende", confidence: 0.55 };

    expect(await transcribeVoiceNote(env.deps, noisy)).toMatchObject({ ok: false, notice: "voiceUnclear", reason: "LOW_CONFIDENCE", confidence: 0.41 });
    expect(await transcribeVoiceNote(env.deps, silent)).toMatchObject({ ok: false, notice: "voiceUnclear", reason: "LOW_CONFIDENCE" });
    expect(await transcribeVoiceNote(env.deps, edge)).toMatchObject({ ok: true });
    expect(env.audits.map((event) => event.action)).toEqual(["LOW_CONFIDENCE", "LOW_CONFIDENCE", "TRANSCRIBED"]);
    expect(env.lines.filter((line) => line.includes("TranscribeLowConfidence"))).toHaveLength(2);
    expect(env.lines.join("\n")).not.toContain("eh mm la");
  });
});

describe("transcribeVoiceNote, spend and failures [FL-099]", () => {
  it("answers servicePaused with the kill switch on, before any job", async () => {
    const env = setup();
    await setKillSwitch({ store: env.store, realClock: env.clock, reader: env.kill }, { scope: "AGENT", on: true, actor: "OPERATOR" });
    expect(await transcribeVoiceNote(env.deps, voiceNote(env, DEMO, seedVoiceNote("vn-01")))).toMatchObject({ ok: false, notice: "servicePaused", reason: "KILL_SWITCH_ACTIVE" });
    expect(env.transcribe.startCalls).toEqual([]);
  });

  it("answers turnCap when the stage's ceiling has no room, before any job", async () => {
    const env = setup({ globalCaps: { ...GLOBAL_CAPS, transcribeSecondsPerDay: 2 } });
    expect(await transcribeVoiceNote(env.deps, voiceNote(env, DEMO, seedVoiceNote("vn-01")))).toMatchObject({ ok: false, notice: "turnCap", reason: "CAP_REACHED" });
    expect(env.transcribe.startCalls).toEqual([]);
  });

  it("answers voiceFailed when the job fails, and deletes it", async () => {
    const env = setup({ script: () => "FAILED" });
    expect(await transcribeVoiceNote(env.deps, voiceNote(env, DEMO, seedVoiceNote("vn-01")))).toMatchObject({ notice: "voiceFailed", reason: "JOB_FAILED" });
    expect(env.transcribe.deletedJobs).toHaveLength(1);
  });

  it("stops polling at 90 s every 1.5 s and answers voiceFailed", async () => {
    const env = setup({ script: () => "NEVER" });
    const outcome = await transcribeVoiceNote(env.deps, voiceNote(env, DEMO, seedVoiceNote("vn-01")));
    expect(outcome).toMatchObject({ notice: "voiceFailed", reason: "TIMEOUT" });
    const elapsed = (await env.clock.now()).getTime() - REAL;
    expect(elapsed).toBeLessThanOrEqual(TRANSCRIBE_POLL.timeoutMs);
    expect(elapsed).toBeGreaterThan(TRANSCRIBE_POLL.timeoutMs - 2 * TRANSCRIBE_POLL.intervalMs);
  });

  it("answers voiceFailed on an output that is not Transcribe's JSON, and deletes it", async () => {
    const env = setup({ pollsBeforeDone: 0 });
    const request = voiceNote(env, DEMO, seedVoiceNote("vn-01"));
    const output = outputLocation(DEMO);
    const get = env.transcribe.get.bind(env.transcribe);
    const deps: VoiceNoteDeps = { ...env.deps, transcribe: { ...env.transcribe, get: async (name) => { const snapshot = await get(name); env.objects.put(output, "<html>"); return snapshot; } } };
    expect(await transcribeVoiceNote(deps, request)).toMatchObject({ notice: "voiceFailed", reason: "OUTPUT_UNREADABLE" });
    expect(env.objects.has(output)).toBe(false);
  });

  it("plays the injected faults of a qa-* world without reaching Transcribe, and gives back the reservation of a failed start", async () => {
    for (const [fault, reason] of [["ERROR", "START_FAILED"], ["FAILED", "JOB_FAILED"], ["TIMEOUT", "TIMEOUT"]] as const) {
      const env = setup({ fault });
      const outcome = await transcribeVoiceNote(env.deps, voiceNote(env, QA, seedVoiceNote("vn-01")));
      expect(outcome).toMatchObject({ ok: false, notice: "voiceFailed", reason });
      expect(env.transcribe.startCalls).toEqual([]);
      if (fault === "ERROR") expect(env.used(`SIMCAP#${QA}#transcribe#${DAY}`)).toBe(0);
    }
  });

  it("never reads nor applies a fault outside qa-* worlds", async () => {
    const reads: string[] = [];
    const getter = { send: async (command: GetCommand) => (reads.push(String(command.input.Key?.PK)), { Item: { PK: `FAULTS#${QA}`, SK: "META", transcribe: "ERROR", network: "ERROR_503" } }) };
    const reader = runtimeTranscribeFaultReader(getter, () => "runtime-test");
    for (const clockId of [DEMO, GUEST_TEST, GUEST_07, "eval-r20261020a"]) expect(await reader.transcribeFault(clockId)).toBeUndefined();
    expect(reads).toEqual([]);
    expect(await reader.transcribeFault(QA)).toBe("ERROR");
    expect(reads).toEqual([`FAULTS#${QA}`]);

    const env = setup({ fault: "ERROR" });
    env.deps = { ...env.deps, faults: reader };
    expect(await transcribeVoiceNote(env.deps, voiceNote(env, GUEST_TEST, seedVoiceNote("vn-01")))).toMatchObject({ ok: true });
  });
});
