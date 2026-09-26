import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { OUTPUT_KEY_PATTERN, mediaFileUri, mediaKeySegment, simMediaKey, transcriptOutputKey, waMediaKey } from "./keys";

// docs/test-plan.md §3: the clock forms of every kind of world, a QA run id with upper case, and live
// `wamid`s, which are base64 and carry `=`, `+` and `/`.
const CLOCKS = ["GLOBAL#isp-demo", "JUDGE#isp-judge-07", "JUDGE#isp-judge-test", "qa-812-1-sc-02", "qa-local-01J9ZQXV6M3B-sc-02", "eval-812-1"];
const WAMIDS = ["wamid.HBgNNTIxNTUwMTAxMDAwMRUCABIYFjNFQjBDMEYzQzU+RjE5QjI4MUE5NwA=", "wamid.HBg/NTIx+NTUw/MTAx==", "wamid.SIM.0f3c9a1b2d"];
const MEDIA_IDS = ["1234567890123456", "sim-media:01J9ZQXV6M3B2Y8N4T5R7K0C1D", "a+b/c=="];
const BUCKET = "aws-cds-hackathon-poc-cuadrilla-poc-mediabucket-x7k2q9";
const JOB = "cuadrilla-poc-0123456789abcdef0123456789abcdef";
const UNSAFE_IN_URI = /[#?+=\s]/;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

describe("[FL-017] media keys for Transcribe and End User Messaging Social", () => {
  it("[FL-017] every OutputKey matches the StartTranscriptionJob pattern, for every kind of world", () => {
    for (const clockId of CLOCKS) {
      for (const messageId of [...WAMIDS, "msg-01J9ZQXV6M3B2Y8N4T5R7K0C1D"]) {
        const key = transcriptOutputKey(clockId, 4, messageId, JOB);
        expect(key, `${clockId} ${messageId}`).toMatch(OUTPUT_KEY_PATTERN);
        expect(key).toMatch(/^transcripts\/[0-9a-f]{16}-e4\/[0-9a-f]{32}\/cuadrilla-poc-[0-9a-f]{32}\.json$/);
        expect(key).not.toContain(clockId);
      }
    }
  });

  it("[FL-017] no MediaFileUri carries #, ?, +, = or spaces, whatever the world or the wamid", () => {
    for (const clockId of CLOCKS) {
      for (const epoch of [0, 1, 27]) {
        const uri = mediaFileUri(BUCKET, simMediaKey(clockId, epoch, "01J9ZQXV6M3B2Y8N4T5R7K0C1D"));
        expect(uri, uri).not.toMatch(UNSAFE_IN_URI);
        expect(uri.startsWith(`s3://${BUCKET}/sim/`)).toBe(true);
      }
    }
    for (const wamid of WAMIDS) {
      for (const mediaId of MEDIA_IDS) {
        const uri = mediaFileUri(BUCKET, waMediaKey(wamid, mediaId));
        expect(uri, uri).not.toMatch(UNSAFE_IN_URI);
        expect(uri).toMatch(/^s3:\/\/[a-z0-9.-]+\/wa\/[0-9a-f]{32}\/[0-9a-f]{16}$/);
      }
    }
  });

  it("[FL-017] distinct worlds or epochs give distinct segments; the same message gives the same keys", () => {
    const segments = CLOCKS.flatMap((clockId) => [0, 1, 2].map((epoch) => mediaKeySegment(clockId, epoch)));
    expect(new Set(segments).size).toBe(segments.length);
    const [first = "", second = ""] = CLOCKS;
    expect(transcriptOutputKey(first, 1, "wamid.X=", JOB)).not.toBe(transcriptOutputKey(second, 1, "wamid.X=", JOB));
    expect(transcriptOutputKey(first, 1, "wamid.X=", JOB)).not.toBe(transcriptOutputKey(first, 2, "wamid.X=", JOB));
    expect(transcriptOutputKey(first, 1, "wamid.X=", JOB)).toBe(transcriptOutputKey(first, 1, "wamid.X=", JOB));
    expect(waMediaKey("wamid.A=", "m-1")).toBe(waMediaKey("wamid.A=", "m-1"));
    expect(waMediaKey("wamid.A=", "m-1")).not.toBe(waMediaKey("wamid.A=", "m-2"));
  });

  it("follows the formulas of docs/architecture.md §6", () => {
    expect(mediaKeySegment("GLOBAL#isp-demo", 3)).toBe(`${sha256Hex("GLOBAL#isp-demo").slice(0, 16)}-e3`);
    expect(simMediaKey("JUDGE#isp-judge-test", 2, "upl_01J9")).toBe(`sim/${sha256Hex("JUDGE#isp-judge-test").slice(0, 16)}-e2/upl_01J9`);
    expect(waMediaKey("wamid.A+B/C=", "987")).toBe(`wa/${sha256Hex("wamid.A+B/C=").slice(0, 32)}/${sha256Hex("987").slice(0, 16)}`);
    expect(transcriptOutputKey("qa-812-1-sc-02", 0, "wamid.A+B/C=", JOB)).toBe(
      `transcripts/${sha256Hex("qa-812-1-sc-02").slice(0, 16)}-e0/${sha256Hex("wamid.A+B/C=").slice(0, 32)}/${JOB}.json`,
    );
  });

  it("rejects what would break a key or a URI", () => {
    expect(() => mediaKeySegment("", 1)).toThrow(RangeError);
    expect(() => mediaKeySegment("GLOBAL#isp-demo", -1)).toThrow(RangeError);
    expect(() => mediaKeySegment("GLOBAL#isp-demo", 1.5)).toThrow(RangeError);
    expect(() => simMediaKey("GLOBAL#isp-demo", 1, "../other")).toThrow(RangeError);
    expect(() => simMediaKey("GLOBAL#isp-demo", 1, "a/b")).toThrow(RangeError);
    expect(() => waMediaKey("", "1")).toThrow(RangeError);
    expect(() => transcriptOutputKey("GLOBAL#isp-demo", 1, "m", "job#1")).toThrow(RangeError);
    for (const key of ["sim/a#b", "wa/a+b", "wa/a=b", "wa/a b", "wa/a?b", "/wa/a", "wa//a", "wa/../x", "transcripts/GLOBAL#isp-demo/x.json"]) {
      expect(() => mediaFileUri(BUCKET, key), key).toThrow(RangeError);
    }
    for (const bucket of ["Media", "ab", "bucket_name", "a..b", "-bucket"]) expect(() => mediaFileUri(bucket, "wa/x"), bucket).toThrow(RangeError);
  });

  it("the OutputKey pattern is the API's, with a literal dash", () => {
    expect(OUTPUT_KEY_PATTERN.test("transcripts/a-b_c.d!e*f'g(h)/i.json")).toBe(true);
    for (const key of ["a:b", "a#b", "a+b", "a=b", "a b", "", "x".repeat(1025)]) expect(OUTPUT_KEY_PATTERN.test(key), key).toBe(false);
  });
});
