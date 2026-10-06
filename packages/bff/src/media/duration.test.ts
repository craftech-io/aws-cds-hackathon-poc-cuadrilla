import { describe, expect, it } from "vitest";
import { checkVoiceLimits, containerDurationSec, reservedSeconds } from "./duration";
import { m4aVoiceNote, seedVoiceNote, webmVoiceNote } from "./testing";

describe("voice-note duration [FL-017] [FL-018]", () => {
  it("reads the duration of Ogg/Opus (seed voices), WebM and MP4 containers", async () => {
    expect(await containerDurationSec(seedVoiceNote("vn-01"), "audio/ogg")).toBeCloseTo(3.19, 1);
    expect(await containerDurationSec(seedVoiceNote("vn-10"), "audio/ogg")).toBeGreaterThan(120);
    expect(await containerDurationSec(webmVoiceNote(42), "audio/webm")).toBeCloseTo(42, 3);
    expect(await containerDurationSec(m4aVoiceNote(30), "audio/mp4")).toBeCloseTo(30, 3);
  });

  it("answers undefined for a container that does not declare it, a forged file or no bytes", async () => {
    expect(await containerDurationSec(webmVoiceNote(), "audio/webm")).toBeUndefined();
    expect(await containerDurationSec(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0xff, 0xff, 0xff]), "audio/webm")).toBeUndefined();
    expect(await containerDurationSec(new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 0]), "audio/ogg")).toBeUndefined();
    expect(await containerDurationSec(new Uint8Array(), "audio/ogg")).toBeUndefined();
  });

  it("allows up to 120 s by the container and 2 MB without it; the first bytes must prove the type", async () => {
    expect(await checkVoiceLimits(m4aVoiceNote(120), "audio/mp4")).toEqual({ ok: true, durationSec: 120 });
    expect(await checkVoiceLimits(m4aVoiceNote(121), "audio/mp4")).toMatchObject({ ok: false, reason: "TOO_LONG" });
    expect(await checkVoiceLimits(webmVoiceNote(), "audio/webm")).toEqual({ ok: true });
    expect(await checkVoiceLimits(seedVoiceNote("vn-01"), "audio/webm")).toEqual({ ok: false, reason: "NOT_AUDIO" });
  });

  it("reserves the measured seconds rounded up, or 120 when the duration is unknown", () => {
    expect(reservedSeconds(3.19)).toBe(4);
    expect(reservedSeconds(0.2)).toBe(1);
    expect(reservedSeconds(undefined)).toBe(120);
  });
});
