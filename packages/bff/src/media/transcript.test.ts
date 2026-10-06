import { describe, expect, it } from "vitest";
import { MAX_TRANSCRIPT_CHARS } from "./config";
import { transcribeOutputJson } from "./testing";
import { readTranscript } from "./transcript";

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));

describe("Transcribe output [FL-017] [FL-018]", () => {
  it("averages the confidence of the pronounced words only (numbers come as strings)", () => {
    const output = {
      results: {
        transcripts: [{ transcript: "la ONU parpadea." }],
        items: [
          { type: "pronunciation", alternatives: [{ confidence: "0.9", content: "la" }] },
          { type: "pronunciation", alternatives: [{ confidence: "0.6", content: "ONU" }] },
          { type: "pronunciation", alternatives: [{ confidence: "0.9", content: "parpadea" }] },
          { type: "punctuation", alternatives: [{ confidence: "0.0", content: "." }] },
        ],
      },
    };
    expect(readTranscript(encode(output))).toEqual({ text: "la ONU parpadea.", confidence: 0.8, unclear: false, maskedKinds: [] });
  });

  it("is unclear below 0.55 or with no text, and clear at exactly 0.55", () => {
    expect(readTranscript(encode(transcribeOutputJson("j", "eh mm", 0.54))).unclear).toBe(true);
    expect(readTranscript(encode(transcribeOutputJson("j", "", 0))).unclear).toBe(true);
    expect(readTranscript(encode(transcribeOutputJson("j", "la ONU no prende", 0.55))).unclear).toBe(false);
  });

  it("masks phones, CURP and the rest before the text leaves, and cuts it to what a message holds", () => {
    const masked = readTranscript(encode(transcribeOutputJson("j", "llámame al 5512345678 por favor", 0.9)));
    expect(masked.text).toBe("llámame al [TELEFONO] por favor");
    expect(masked.maskedKinds).toEqual(["PHONE"]);
    const long = readTranscript(encode(transcribeOutputJson("j", "fibra ".repeat(1_000), 0.9)));
    expect(long.text.length).toBe(MAX_TRANSCRIPT_CHARS);
  });

  it("throws on anything that is not Transcribe's JSON", () => {
    expect(() => readTranscript(encode("<html>"))).toThrow();
    expect(() => readTranscript(encode({ results: { transcripts: [{ transcript: 4 }] } }))).toThrow();
    expect(() => readTranscript(new Uint8Array([0xff, 0xfe, 0x00]))).toThrow();
  });
});
