import { TRPCError } from "@trpc/server";
import { describe, expect, it } from "vitest";
import { ToolError } from "@cuadrilla/shared";
import { simMediaKey } from "@cuadrilla/shared/media/keys";
import { admitMessage } from "../channels/rate-limit";
import { type SnsNotification } from "../channels/whatsapp/payloads";
import { verifySimulatedEnvelope } from "../channels/whatsapp/sim-envelope";
import { killSwitchKey } from "../ops/kill-switch";
import { reserveCost } from "../ops/cost-caps";
import { DEMO, GUEST_07, REAL_NOW, hashPhone, phoneOf } from "../services/people/testing";
import { type ConsoleTestWorld, JPEG_BYTES, OGG_BYTES, consoleTestWorld } from "./console-testing";

async function failure(call: Promise<unknown>): Promise<{ code: string; reason: string | undefined }> {
  const error = await call.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(TRPCError);
  const cause = (error as TRPCError).cause;
  return { code: (error as TRPCError).code, reason: cause instanceof ToolError ? cause.reason : undefined };
}

/** The SNS record and the Meta message inside an envelope the simulator handed to InboundWhatsApp. */
function envelopeOf(t: ConsoleTestWorld, index = -1) {
  const event = t.ports.envelopes.at(index) as { Records: Array<{ Sns: SnsNotification }> };
  const sns = event.Records[0]?.Sns as SnsNotification;
  const body = JSON.parse(sns.Message) as { whatsAppWebhookEntry: string };
  const entry = JSON.parse(body.whatsAppWebhookEntry) as { changes: Array<{ value: { messages: Array<Record<string, unknown>> } }> };
  return { sns, message: entry.changes[0]?.value.messages[0] ?? {} };
}

describe("phone simulator [FL-082]", () => {
  it("[FL-082] a text enters by the signed envelope of the principal's world, as the chosen identity or the world's unknown number", async () => {
    const t = await consoleTestWorld(GUEST_07);
    const guest = await t.as();
    const identities = await guest.simulator.identities();
    expect(identities.identities.map((identity) => identity.identity)).toEqual(expect.arrayContaining([t.world.ids.rogelio, t.world.ids.adriana, "UNKNOWN"]));
    const sent = await guest.simulator.sendText({ identity: t.world.ids.rogelio, text: "Ya llegué" });
    expect(sent.wamid).toMatch(/^wamid\.SIM\./);
    const { sns, message } = envelopeOf(t);
    expect(verifySimulatedEnvelope(sns, "sim-envelope-test-key")).toBe(t.world.clockId);
    expect(message).toMatchObject({ from: phoneOf("0207", 1).slice(1), type: "text", text: { body: "Ya llegué" } });
    await guest.simulator.sendText({ identity: "UNKNOWN", text: "Hola" });
    expect(envelopeOf(t).message).toMatchObject({ from: "525502070999" });
  });

  it("[FL-082] the thread shows an agent's buttons, and a tap goes back with the button's id", async () => {
    const t = await consoleTestWorld(DEMO);
    await t.memory.connector.conversations.appendMessage({
      messageId: "wa-out-0010",
      personId: t.world.ids.rogelio,
      ispId: t.world.ispId,
      clockId: t.world.clockId,
      direction: "OUT",
      channel: "WHATSAPP",
      content: "INTERACTIVE",
      kind: "REPLY",
      status: "DELIVERED",
      author: "AGENT",
      simulated: true,
      sentAtSim: "2026-10-13T09:51:00-06:00",
      refs: { whatsapp: { messaging_product: "whatsapp", recipient_type: "individual", type: "interactive", interactive: { type: "button", body: { text: "¿Cliente conforme?" }, action: { buttons: [{ type: "reply", reply: { id: "nonce-abc", title: "Cliente conforme" } }] } } } },
    });
    const console = await t.as();
    const thread = await console.simulator.thread({ identity: t.world.ids.rogelio });
    expect(thread.bubbles).toEqual([expect.objectContaining({ text: "¿Cliente conforme?", buttons: [{ id: "nonce-abc", title: "Cliente conforme", kind: "button_reply" }], sentAtSim: "2026-10-13T09:51:00-06:00" })]);
    await console.simulator.tapButton({ identity: t.world.ids.rogelio, messageId: "wa-out-0010", buttonId: "nonce-abc" });
    expect(envelopeOf(t).message).toMatchObject({ type: "interactive", interactive: { type: "button_reply", button_reply: { id: "nonce-abc", title: "Cliente conforme" } } });
    expect((await failure(console.simulator.tapButton({ identity: t.world.ids.rogelio, messageId: "wa-out-0010", buttonId: "forged" }))).code).toBe("NOT_FOUND");
    await console.simulator.markRead({ identity: t.world.ids.rogelio });
    expect(t.ports.read).toEqual([t.world.ids.rogelio]);
  });

  it("[FL-082] a photo only by an uploadId of the same user and world, used once, after HeadObject and its magic bytes", async () => {
    const demo = await consoleTestWorld(DEMO);
    const guestWorld = await consoleTestWorld(GUEST_07, demo);
    const guest = await guestWorld.as();
    const upload = await guest.simulator.presignMedia({ kind: "PHOTO", contentType: "image/jpeg" });
    expect(upload).toMatchObject({ maxBytes: 3.5 * 1024 * 1024, fields: { "Content-Type": "image/jpeg" } });
    const key = simMediaKey(guestWorld.world.clockId, 1, upload.uploadId);
    expect(upload.fields.key).toBe(key);
    guestWorld.ports.objects.put("Media", key, JPEG_BYTES, "image/jpeg");
    // Another user of the same world, and a user of another world, cannot use it.
    expect(await failure((await guestWorld.as("GUEST", "usr-guest-otro")).simulator.sendPhoto({ identity: guestWorld.world.ids.rogelio, uploadId: upload.uploadId }))).toEqual({ code: "FORBIDDEN", reason: "UPLOAD_NOT_YOURS" });
    expect(await failure((await demo.as()).simulator.sendPhoto({ identity: demo.world.ids.rogelio, uploadId: upload.uploadId }))).toEqual({ code: "FORBIDDEN", reason: "UPLOAD_NOT_YOURS" });
    await guest.simulator.sendPhoto({ identity: guestWorld.world.ids.rogelio, uploadId: upload.uploadId });
    expect(envelopeOf(guestWorld).message).toMatchObject({ type: "image", image: { id: `sim-media:${upload.uploadId}`, mime_type: "image/jpeg" } });
    expect(await failure(guest.simulator.sendPhoto({ identity: guestWorld.world.ids.rogelio, uploadId: upload.uploadId }))).toMatchObject({ code: "CONFLICT" });
  });

  it("[FL-082] an upload whose bytes are not what it claims is refused and deleted; a voice note of the synthetic set travels as an upload too", async () => {
    const t = await consoleTestWorld(DEMO);
    const console = await t.as();
    const upload = await console.simulator.presignMedia({ kind: "PHOTO", contentType: "image/jpeg" });
    const key = simMediaKey(t.world.clockId, 1, upload.uploadId);
    t.ports.objects.put("Media", key, OGG_BYTES, "image/jpeg");
    expect(await failure(console.simulator.sendPhoto({ identity: t.world.ids.rogelio, uploadId: upload.uploadId }))).toEqual({ code: "BAD_REQUEST", reason: "MEDIA_REJECTED" });
    expect(await t.ports.objects.media.head(key)).toBeUndefined();
    expect(t.ports.envelopes).toEqual([]);
    t.ports.objects.put("Seed", "audio/vn-01.ogg", OGG_BYTES, "audio/ogg");
    await console.simulator.sendVoiceNote({ identity: t.world.ids.rogelio, voiceId: "vn-01" });
    expect(envelopeOf(t).message).toMatchObject({ type: "audio", audio: { mime_type: "audio/ogg", voice: true } });
    expect((await console.simulator.catalog()).voices.map((voice) => voice.voiceId)).toContain("vn-01");
  });

  it("[FL-082] a world on the live channel is not the simulator's", async () => {
    const t = await consoleTestWorld(DEMO);
    await t.memory.connector.isps.updateSettings(t.world.ispId, { whatsappMode: "live" });
    expect(await failure((await t.as()).simulator.sendText({ identity: t.world.ids.rogelio, text: "hola" }))).toEqual({ code: "FORBIDDEN", reason: "WORLD_NOT_SIMULATED" });
  });

  it("[FL-082] a quick message of the tour also does its physical action on the order's ONU", async () => {
    const t = await consoleTestWorld(DEMO);
    const console = await t.as();
    const quick = await console.simulator.quickMessages();
    expect(quick.find((entry) => entry.quickId === "s1-connector-cleaned")).toMatchObject({ identity: t.world.ids.rogelio, type: "TEXT", physicalAction: "INSTALLER_STEP" });
    await console.simulator.sendQuick({ quickId: "s1-connector-cleaned" });
    expect(envelopeOf(t).message).toMatchObject({ type: "text", text: { body: "Ya limpié el conector, ya prende." } });
    expect(t.ports.network.calls).toEqual([{ op: "action", serial: "DEMO3F2C19A0", kind: "INSTALLER_STEP" }]);
  });
});

describe("caps of the simulator [FL-083]", () => {
  it("[FL-083] the identity's messages per real hour: the 21st is refused, and \"+1 h\" of the demo clock never frees it", async () => {
    const t = await consoleTestWorld(GUEST_07);
    const settings = await t.memory.connector.isps.getSettings(t.world.ispId);
    // What InboundWhatsApp counts for each envelope (channels/rate-limit.ts).
    t.ports.onInbound = async () =>
      admitMessage(t.memory.connector.runtime, { clockId: t.world.clockId, addressHash: hashPhone(phoneOf("0207", 1)), simNow: new Date("2026-10-13T15:20:00Z"), realNow: new Date(REAL_NOW), settings });
    const guest = await t.as();
    for (let message = 1; message <= 20; message += 1) await guest.simulator.sendText({ identity: t.world.ids.rogelio, text: `mensaje ${message}` });
    expect(await failure(guest.simulator.sendText({ identity: t.world.ids.rogelio, text: "otro" }))).toEqual({ code: "TOO_MANY_REQUESTS", reason: "RATE_LIMIT" });
    await guest.clock.advance({ minutes: 60 });
    expect(await failure(guest.simulator.sendText({ identity: t.world.ids.rogelio, text: "otro" }))).toEqual({ code: "TOO_MANY_REQUESTS", reason: "RATE_LIMIT" });
    expect(t.ports.envelopes).toHaveLength(20);
    // Another identity of the world still writes.
    await guest.simulator.sendText({ identity: t.world.ids.adriana, text: "hola" });
  });

  it("[FL-083] the world's cap and the kill switch stop the simulator before anything is handed over", async () => {
    const t = await consoleTestWorld(GUEST_07);
    const settings = await t.memory.connector.isps.getSettings(t.world.ispId);
    const full = await reserveCost(t.ports.costCaps, { world: { clockId: t.world.clockId, settings }, resource: "turns", amount: 60, reserve: ["SIMULATOR"] });
    expect(full.ok).toBe(true);
    const guest = await t.as();
    expect(await failure(guest.simulator.sendText({ identity: t.world.ids.rogelio, text: "hola" }))).toEqual({ code: "TOO_MANY_REQUESTS", reason: "SIMULATOR" });
    const other = await consoleTestWorld(DEMO);
    await other.ports.runtimeStore.write(killSwitchKey("SIMULATOR"), { scope: "SIMULATOR", state: "on", setBy: "OPERATOR", setAtReal: REAL_NOW });
    expect(await failure((await other.as()).simulator.sendText({ identity: other.world.ids.rogelio, text: "hola" }))).toEqual({ code: "SERVICE_UNAVAILABLE", reason: "KILL_SWITCH_ACTIVE" });
    expect([...t.ports.envelopes, ...other.ports.envelopes]).toEqual([]);
  });
});

describe("a real phone in a guest world [FL-101]", () => {
  it("[FL-101] the join code exists only with the live transport in the stage, for a person of the world", async () => {
    const t = await consoleTestWorld(GUEST_07);
    const guest = await t.as();
    expect(await failure(guest.simulator.joinCode({ personId: t.world.ids.rogelio }))).toEqual({ code: "FORBIDDEN", reason: "LIVE_TRANSPORT_OFF" });
    expect(await guest.simulator.kit()).toEqual({ available: false });
    t.ports.transports = ["simulated", "live"];
    const code = await guest.simulator.joinCode({ personId: t.world.ids.rogelio });
    expect(code).toMatchObject({ code: expect.stringMatching(/^G07-[A-Z0-9]{4}$/), expiresInMinutes: 30 });
    expect(code.message).toBe(`ALTA ${code.code}`);
    expect(await t.memory.connector.worlds.getJoinCode(code.code)).toMatchObject({ clockId: t.world.clockId, personId: t.world.ids.rogelio });
    const kit = await guest.simulator.kit();
    expect(kit).toMatchObject({ available: true, voices: [expect.objectContaining({ voiceId: "vn-01" })] });
  });
});
