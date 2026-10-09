import { describe, expect, it } from "vitest";
import type { z } from "zod";
import type { ConsoleApi } from "../../lib/console-api";
import { apiErrorOf } from "../../lib/api-error";
import { joinQrValue } from "./LivePanel";
import { type PresignedPost, UPLOAD_REFUSED, UploadRefused, createSimulatorApi, uploadToPresignedPost } from "./simulator-api";

interface Call {
  readonly kind: "query" | "mutation";
  readonly path: string;
  readonly input: unknown;
}

/** A console API that records every call and answers what the BFF would (parsed by the caller's schema). */
function recordingApi(answers: Readonly<Record<string, unknown>>): { readonly api: ConsoleApi; readonly calls: Call[] } {
  const calls: Call[] = [];
  const answer = <T>(kind: Call["kind"], path: string, input: unknown, schema: z.ZodType<T>): Promise<T> => {
    calls.push({ kind, path, input });
    return Promise.resolve(schema.parse(answers[path]));
  };
  return { calls, api: { query: (path, input, schema) => answer("query", path, input, schema), mutation: (path, input, schema) => answer("mutation", path, input, schema) } };
}

const SENT = { wamid: "wamid.SIM.1", sentAtReal: "2026-10-20T15:00:00.000Z" };
const POST: PresignedPost = { uploadId: "upl-01", url: "http://127.0.0.1:4174/s3/Media", fields: { key: "sim/k", "Content-Type": "audio/webm", "x-max-bytes": "100" }, maxBytes: 100 };

describe("simulator edge [FL-082]", () => {
  it("[FL-082] a recorded note goes by presignMedia, the presigned POST and then sendVoiceNote with the uploadId; never an S3 key", async () => {
    const { api, calls } = recordingApi({ "simulator.presignMedia": POST, "simulator.sendVoiceNote": SENT });
    const uploads: Array<{ post: PresignedPost; type: string }> = [];
    const sim = createSimulatorApi(api, async (post, _file, type) => void uploads.push({ post, type }));
    await sim.run({ kind: "ownVoice", identity: "inst-rogelio-g07", file: new Blob(["webm"]), contentType: "audio/webm" });
    expect(calls).toEqual([
      { kind: "mutation", path: "simulator.presignMedia", input: { kind: "VOICE", contentType: "audio/webm" } },
      { kind: "mutation", path: "simulator.sendVoiceNote", input: { identity: "inst-rogelio-g07", uploadId: "upl-01" } },
    ]);
    expect(uploads).toEqual([{ post: POST, type: "audio/webm" }]);
  });

  it("[FL-082] a photo of the set goes by its id; an own photo by an upload with its caption; taps, quick messages and reads by their ids", async () => {
    const { api, calls } = recordingApi({
      "simulator.presignMedia": { ...POST, fields: { ...POST.fields, "Content-Type": "image/jpeg" } },
      "simulator.sendPhoto": SENT,
      "simulator.tapButton": SENT,
      "simulator.sendQuick": { quickId: "s1-voice-note", ...SENT },
      "simulator.markRead": { read: 2 },
      "simulator.sendText": SENT,
    });
    const sim = createSimulatorApi(api, async () => undefined);
    await sim.run({ kind: "samplePhoto", identity: "i", photoId: "ph-meter-01" });
    await sim.run({ kind: "ownPhoto", identity: "i", file: new Blob(["jpg"]), caption: "Etiqueta" });
    await sim.run({ kind: "tap", identity: "i", messageId: "m", buttonId: "nonce" });
    await sim.run({ kind: "quick", quickId: "s1-voice-note" });
    await sim.run({ kind: "markRead", identity: "i" });
    await sim.run({ kind: "text", identity: "UNKNOWN", text: "Hola" });
    expect(calls.map((call) => [call.path, call.input])).toEqual([
      ["simulator.sendPhoto", { identity: "i", photoId: "ph-meter-01" }],
      ["simulator.presignMedia", { kind: "PHOTO", contentType: "image/jpeg" }],
      ["simulator.sendPhoto", { identity: "i", uploadId: "upl-01", caption: "Etiqueta" }],
      ["simulator.tapButton", { identity: "i", messageId: "m", buttonId: "nonce" }],
      ["simulator.sendQuick", { quickId: "s1-voice-note" }],
      ["simulator.markRead", { identity: "i" }],
      ["simulator.sendText", { identity: "UNKNOWN", text: "Hola" }],
    ]);
  });

  it("[FL-082] the presigned POST carries its fields first and the file last, typed as the note; a refusal is told as UPLOAD_REFUSED", async () => {
    const sent: Array<{ url: string; names: string[]; type: string }> = [];
    const fetcher = async (url: RequestInfo | URL, init?: RequestInit) => {
      const form = init?.body as FormData;
      const file = form.get("file") as Blob;
      sent.push({ url: String(url), names: [...form.keys()], type: file.type });
      return new Response(null, { status: sent.length === 1 ? 204 : 403 });
    };
    await uploadToPresignedPost(POST, new Blob(["note"]), "audio/webm", fetcher);
    expect(sent[0]).toEqual({ url: POST.url, names: ["key", "Content-Type", "x-max-bytes", "file"], type: "audio/webm" });
    const refused = await uploadToPresignedPost(POST, new Blob(["note"]), "audio/webm", fetcher).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(UploadRefused);
    expect(apiErrorOf(refused)).toMatchObject({ kind: "invalid", reason: UPLOAD_REFUSED });
    await expect(uploadToPresignedPost(POST, new Blob([]), "audio/webm", fetcher)).rejects.toBeInstanceOf(UploadRefused);
    await expect(uploadToPresignedPost(POST, new Blob(["x".repeat(101)]), "audio/webm", fetcher)).rejects.toBeInstanceOf(UploadRefused);
    expect(sent).toHaveLength(2);
  });
});

describe("join code [FL-101]", () => {
  it("[FL-101] the QR opens WhatsApp with the message ready when the number is known, and carries the message alone otherwise", () => {
    expect(joinQrValue({ message: "ALTA G07-4F2K", number: "+525512345678" })).toBe("https://wa.me/525512345678?text=ALTA%20G07-4F2K");
    expect(joinQrValue({ message: "ALTA G07-4F2K" })).toBe("ALTA G07-4F2K");
  });
});
