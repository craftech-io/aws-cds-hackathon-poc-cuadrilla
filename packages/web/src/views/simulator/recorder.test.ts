import { describe, expect, it } from "vitest";
import { pickRecordingType, recordingSupport } from "./recorder";

describe("voice notes recorded in the browser [FL-082]", () => {
  it("[FL-082] prefers Ogg, then WebM, then MP4, by what the browser says it records", () => {
    expect(pickRecordingType((type) => type.startsWith("audio/ogg"))).toEqual({ mimeType: "audio/ogg;codecs=opus", contentType: "audio/ogg" });
    expect(pickRecordingType((type) => type.startsWith("audio/webm"))).toEqual({ mimeType: "audio/webm;codecs=opus", contentType: "audio/webm" });
    expect(pickRecordingType((type) => type === "audio/webm")).toEqual({ mimeType: "audio/webm", contentType: "audio/webm" });
    // WebKit: MP4 only.
    expect(pickRecordingType((type) => type === "audio/mp4")).toEqual({ mimeType: "audio/mp4", contentType: "audio/mp4" });
    expect(pickRecordingType(() => false)).toBeUndefined();
    expect(pickRecordingType(undefined)).toBeUndefined();
    expect(
      pickRecordingType(() => {
        throw new Error("not supported");
      }),
    ).toBeUndefined();
  });

  it("[FL-082] without MediaRecorder or the microphone API there is nothing to record with (the button is hidden)", () => {
    const microphone = { navigator: { mediaDevices: { getUserMedia: () => undefined } } };
    expect(recordingSupport({ ...microphone, MediaRecorder: { isTypeSupported: (type: string) => type === "audio/mp4" } })).toEqual({ mimeType: "audio/mp4", contentType: "audio/mp4" });
    expect(recordingSupport(microphone)).toBeUndefined();
    expect(recordingSupport({ MediaRecorder: { isTypeSupported: () => true } })).toBeUndefined();
    expect(recordingSupport({ ...microphone, MediaRecorder: {} })).toBeUndefined();
  });
});
