import { GetWhatsAppMessageMediaCommand, SocialMessagingClient } from "@aws-sdk/client-socialmessaging";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { simMediaKey, waMediaKey } from "@cuadrilla/shared/media/keys";
import { createSocialMessaging } from "./client";
import { processInboundEvent } from "./inbound";
import { type MediaDeps, contentOf, fetchInboundMedia, sniffMediaType } from "./media";
import { AWS_ID, JPEG, JUDGE, OGG, PEOPLE, inboundHarness, liveEvent, memoryMediaStore, recorder, fakeSocial, simEvent, simUpload, waAudio, waImage, waOther } from "./testing";

const socialMock = mockClient(SocialMessagingClient);
const ROGELIO = PEOPLE.rogelio;
const WAMID = "wamid.HBgMNTI1NTAxMDEwMDAxFQIAEhgg+QkYz/Tq=";
const MB = 1024 * 1024;

function liveDeps(store = memoryMediaStore()): MediaDeps & { store: ReturnType<typeof memoryMediaStore> } {
  const client = new SocialMessagingClient({ region: "us-east-1", credentials: { accessKeyId: "test", secretAccessKey: "test" } });
  return { store, mediaBucket: () => "poc-media", social: createSocialMessaging({ client, originationPhoneNumberId: () => AWS_ID }), worlds: { getUpload: async () => undefined } };
}

describe("inbound media, live", () => {
  beforeEach(() => socialMock.reset());

  it("[FL-017] [FL-091] a voice note: GetWhatsAppMessageMedia with the AWS id of the number, metadataOnly first, then to waMediaKey", async () => {
    const deps = liveDeps();
    socialMock.on(GetWhatsAppMessageMediaCommand).callsFake((input: { metadataOnly?: boolean; destinationS3File?: { key?: string } }) => {
      if (input.destinationS3File?.key !== undefined) deps.store.put(input.destinationS3File.key, OGG(), "audio/ogg");
      return { mimeType: "audio/ogg", fileSize: 2048 };
    });
    const content = contentOf(waAudio(ROGELIO.phone, WAMID, "1123581321345589"));
    if (content.kind !== "VOICE") throw new Error("expected a voice note");
    const outcome = await fetchInboundMedia({ origin: "LIVE", clockId: "GLOBAL#isp-demo", worldEpoch: 3, wamid: WAMID, content }, deps);
    const key = waMediaKey(WAMID, "1123581321345589");
    expect(outcome).toEqual({ ok: true, media: { kind: "AUDIO", s3Key: key, mime: "audio/ogg", bytes: 2048 } });
    expect(key).toMatch(/^wa\/[0-9a-f]{32}\/[0-9a-f]{16}$/);
    const calls = socialMock.commandCalls(GetWhatsAppMessageMediaCommand).map((call) => call.args[0].input);
    expect(calls).toEqual([
      { mediaId: "1123581321345589", originationPhoneNumberId: AWS_ID, metadataOnly: true },
      { mediaId: "1123581321345589", originationPhoneNumberId: AWS_ID, destinationS3File: { bucketName: "poc-media", key } },
    ]);
  });

  it("[FL-018] a voice note over 16 MB is refused from its metadata, never downloaded", async () => {
    const deps = liveDeps();
    socialMock.on(GetWhatsAppMessageMediaCommand).resolves({ mimeType: "audio/ogg", fileSize: 17 * MB });
    const content = contentOf(waAudio(ROGELIO.phone, WAMID));
    if (content.kind !== "VOICE") throw new Error("expected a voice note");
    expect(await fetchInboundMedia({ origin: "LIVE", clockId: "GLOBAL#isp-demo", worldEpoch: 3, wamid: WAMID, content }, deps)).toEqual({ ok: false, notice: "voiceTooLong", deleted: false });
    expect(socialMock.commandCalls(GetWhatsAppMessageMediaCommand)).toHaveLength(1);
  });

  it("[FL-046] a photo over 3.75 MB gets 'mándala como foto' and nothing is downloaded", async () => {
    const h = await inboundHarness({ media: { mimeType: "image/jpeg", fileSize: 4.5 * MB } });
    const result = await processInboundEvent(liveEvent({ messages: [waImage(ROGELIO.phone, "wamid.I1")] }), h.deps);
    expect(result.records[0]?.messages).toEqual(["MEDIA_REFUSED"]);
    expect(h.rec.notices).toMatchObject([{ notice: "imageTooLarge", text: "La imagen pesa demasiado: mándala como foto, no como documento." }]);
    expect(h.rec.media.map((call) => call.op)).toEqual(["metadata"]);
    expect(h.rec.queued).toEqual([]);
  });

  it("[FL-046] a stored object whose bytes are not what it says is deleted", async () => {
    const store = memoryMediaStore();
    const social = fakeSocial(recorder(), store, { mimeType: "image/jpeg", fileSize: 4096, bytes: OGG(4096) });
    const content = contentOf(waImage(ROGELIO.phone, "wamid.I2"));
    if (content.kind !== "IMAGE") throw new Error("expected an image");
    const outcome = await fetchInboundMedia({ origin: "LIVE", clockId: "GLOBAL#isp-demo", worldEpoch: 3, wamid: "wamid.I2", content }, { store, mediaBucket: () => "poc-media", social, worlds: { getUpload: async () => undefined } });
    expect(outcome).toEqual({ ok: false, notice: "imageUnreadable", deleted: true });
    expect(store.keys()).toEqual([]);
  });

  it("[FL-046] a valid photo becomes a candidate: the Message IN with its media, on the installer's queue, never validated here", async () => {
    const h = await inboundHarness();
    await processInboundEvent(liveEvent({ messages: [waImage(ROGELIO.phone, "wamid.I3", "2233445566778899", "la roseta")] }), h.deps);
    const [stored] = await h.world.connector.conversations.listMessages(ROGELIO.personId);
    expect(stored).toMatchObject({ content: "IMAGE", text: "la roseta", media: { kind: "IMAGE", mime: "image/jpeg", s3Key: waMediaKey("wamid.I3", "2233445566778899") } });
    expect(h.rec.queued).toMatchObject([{ type: "INBOUND_MESSAGE", installerId: ROGELIO.personId }]);
    expect(h.rec.notices).toEqual([]);
  });

  it("[FL-018] [FL-046] video, document and sticker get the fixed reply, no media fetched and no turn", async () => {
    for (const type of ["video", "document", "sticker"]) {
      const h = await inboundHarness();
      await processInboundEvent(liveEvent({ messages: [waOther(ROGELIO.phone, `wamid.O-${type}`, type)] }), h.deps);
      expect(h.rec.notices).toMatchObject([{ notice: "unsupportedMedia", text: "Por aquí solo puedo recibir texto, notas de voz y fotos." }]);
      expect(h.rec.media).toEqual([]);
      expect(h.rec.queued).toEqual([]);
      const [stored] = await h.world.connector.conversations.listMessages(ROGELIO.personId);
      expect(stored?.content).toBe(type === "sticker" ? "STICKER" : type === "document" ? "DOCUMENT" : "OTHER");
    }
  });
});

describe("inbound media, simulated", () => {
  it("[FL-017] sim-media:<uploadId> resolves to simMediaKey of the world through UPLOAD#, never a key from the client", async () => {
    const h = await inboundHarness();
    const key = await simUpload(h, "up-voice-02", "VOICE", OGG(), "audio/ogg");
    expect(key).toBe(simMediaKey(JUDGE, 3, "up-voice-02"));
    await processInboundEvent(simEvent(JUDGE, PEOPLE.rogelioJ07.phone, "wamid.SIM.V1", { type: "voice", uploadId: "up-voice-02", mimeType: "audio/ogg" }), h.deps);
    const [stored] = await h.world.connector.conversations.listMessages(PEOPLE.rogelioJ07.personId);
    expect(stored).toMatchObject({ content: "VOICE", media: { kind: "AUDIO", s3Key: key, mime: "audio/ogg" } });
    expect(key).not.toContain("#");
    expect(h.rec.queued).toHaveLength(1);
  });

  it("[FL-017] a browser recording goes on as WebM/Opus or, from Safari, audio/mp4", async () => {
    const h = await inboundHarness();
    const webm = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]);
    const mp4 = Uint8Array.from([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]);
    await simUpload(h, "up-voice-05", "VOICE", webm, "audio/webm");
    await simUpload(h, "up-voice-06", "VOICE", mp4, "audio/mp4");
    await processInboundEvent(simEvent(JUDGE, PEOPLE.rogelioJ07.phone, "wamid.SIM.W1", { type: "voice", uploadId: "up-voice-05", mimeType: "audio/webm;codecs=opus" }), h.deps);
    await processInboundEvent(simEvent(JUDGE, PEOPLE.rogelioJ07.phone, "wamid.SIM.W2", { type: "voice", uploadId: "up-voice-06", mimeType: "audio/mp4" }), h.deps);
    const stored = await h.world.connector.conversations.listMessages(PEOPLE.rogelioJ07.personId);
    expect(stored.map((message) => message.media?.mime)).toEqual(["audio/webm", "audio/mp4"]);
    expect(h.rec.queued).toHaveLength(2);
  });

  it("[FL-017] an upload of another world, of another kind or of an old epoch is refused", async () => {
    const h = await inboundHarness();
    await simUpload(h, "up-photo-02", "PHOTO", JPEG(), "image/jpeg");
    const voiceFromPhoto = simEvent(JUDGE, PEOPLE.rogelioJ07.phone, "wamid.SIM.V2", { type: "voice", uploadId: "up-photo-02", mimeType: "audio/ogg" });
    expect((await processInboundEvent(voiceFromPhoto, h.deps)).records[0]?.messages).toEqual(["MEDIA_REFUSED"]);
    const oldKey = simMediaKey(JUDGE, 2, "up-voice-03");
    await h.world.connector.worlds.createUpload({ uploadId: "up-voice-03", userId: "usr-judge-07", clockId: JUDGE, key: oldKey, kind: "VOICE", maxBytes: 1_000_000 });
    h.store.put(oldKey, OGG(), "audio/ogg");
    const oldEpoch = simEvent(JUDGE, PEOPLE.rogelioJ07.phone, "wamid.SIM.V3", { type: "voice", uploadId: "up-voice-03", mimeType: "audio/ogg" });
    expect((await processInboundEvent(oldEpoch, h.deps)).records[0]?.messages).toEqual(["MEDIA_REFUSED"]);
    expect(h.rec.notices.map((notice) => notice.notice)).toEqual(["voiceFailed", "voiceFailed"]);
    expect(h.rec.queued).toEqual([]);
  });

  it("[FL-018] [FL-046] an upload over its limit or of an unsupported type is deleted and answered", async () => {
    const h = await inboundHarness();
    const big = await simUpload(h, "up-photo-03", "PHOTO", JPEG(4 * MB), "image/jpeg");
    await processInboundEvent(simEvent(JUDGE, PEOPLE.rogelioJ07.phone, "wamid.SIM.P1", { type: "photo", uploadId: "up-photo-03", mimeType: "image/jpeg" }), h.deps);
    const mp3 = await simUpload(h, "up-voice-04", "VOICE", Uint8Array.from([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0]), "audio/mpeg");
    await processInboundEvent(simEvent(JUDGE, PEOPLE.rogelioJ07.phone, "wamid.SIM.P2", { type: "voice", uploadId: "up-voice-04", mimeType: "audio/mpeg" }), h.deps);
    expect(h.rec.notices.map((notice) => notice.notice)).toEqual(["imageTooLarge", "unsupportedMedia"]);
    expect(h.store.keys()).not.toContain(big);
    expect(h.store.keys()).not.toContain(mp3);
  });
});

describe("magic bytes", () => {
  it("[FL-017] recognizes JPEG, PNG, Ogg, WebM and MP4 by their first bytes, nothing else", () => {
    expect(sniffMediaType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe1]))).toBe("image/jpeg");
    expect(sniffMediaType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(sniffMediaType(new TextEncoder().encode("OggS\u0000\u0002"))).toBe("audio/ogg");
    expect(sniffMediaType(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3]))).toBe("audio/webm");
    expect(sniffMediaType(Uint8Array.from([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70]))).toBe("audio/mp4");
    expect(sniffMediaType(new TextEncoder().encode("<svg"))).toBeUndefined();
  });
});
