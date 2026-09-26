import { PostWhatsAppMessageMediaCommand, SendWhatsAppMessageCommand, SocialMessagingClient, ThrottledRequestException } from "@aws-sdk/client-socialmessaging";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { testConnector } from "../../connector/testing";
import { TEMPLATES } from "../../copy/templates";
import { createSocialMessaging } from "./client";
import { META_API_VERSION } from "./config";
import { createLiveTransport } from "./outbound";
import { renderDocument, renderImage, renderList, renderReaction, renderReplyButtons, renderTemplate, renderText } from "./render";
import { createSimulatedTransport } from "./simulated";
import { AWS_ID, DEMO, PEOPLE, REAL_NOW, seedWorlds } from "./testing";
import { PENDING_MEDIA_ID } from "./transport";

const socialMock = mockClient(SocialMessagingClient);
const TO = PEOPLE.rogelio.phone;
const PDF_KEY = "certificates/wo-24817/acta-24817.pdf";

async function world() {
  const w = testConnector(REAL_NOW);
  await seedWorlds(w);
  return w;
}

async function outboundRow(w: Awaited<ReturnType<typeof world>>, messageId: string, extra: { kind?: "CERTIFICATE" | "REPLY"; content?: "DOCUMENT" | "TEXT" | "TEMPLATE" } = {}) {
  const message = await w.connector.conversations.appendMessage({
    messageId,
    personId: PEOPLE.rogelio.personId,
    ispId: "isp-demo",
    clockId: DEMO,
    direction: "OUT",
    channel: "WHATSAPP",
    content: extra.content ?? "TEXT",
    kind: extra.kind ?? "REPLY",
    status: "QUEUED",
    author: "SYSTEM",
    simulated: false,
    transport: "live",
    sentAtSim: "2026-10-13T11:30:00-06:00",
  });
  return { personId: message.personId, sentAtSim: message.sentAtSim, messageId: message.messageId };
}

function liveTransport(w: Awaited<ReturnType<typeof world>>) {
  const client = new SocialMessagingClient({ region: "us-east-1", credentials: { accessKeyId: "test", secretAccessKey: "test" } });
  const social = createSocialMessaging({ client, originationPhoneNumberId: () => AWS_ID });
  return createLiveTransport({ social, conversations: w.connector.conversations, templates: w.connector.reference, bucketName: (bucket) => `poc-${bucket.toLowerCase()}`, realClock: { now: async () => w.now() } });
}

async function approve(w: Awaited<ReturnType<typeof world>>, name: "acta_instalacion" | "respuesta_supervisor", status: "APPROVED" | "PENDING") {
  const template = TEMPLATES[name];
  await w.connector.reference.put("Template", { name, language: "es_MX", category: "UTILITY", body: template.body, status });
}

const sentJson = (index: number): unknown => {
  const message = socialMock.commandCalls(SendWhatsAppMessageCommand)[index]?.args[0].input.message;
  return message === undefined ? undefined : JSON.parse(new TextDecoder().decode(message));
};

describe("rendering Cloud API JSON", () => {
  it("[FL-092] every builder returns a payload validated with zod: text, buttons, list, image, document, reaction and template with a document header", () => {
    expect(renderText(TO, "Hola")).toMatchObject({ to: "525501010001", type: "text", text: { preview_url: false, body: "Hola" } });
    expect(renderReplyButtons(TO, "¿Algo más?", [{ id: "n1", title: "Cliente conforme" }])).toMatchObject({ interactive: { type: "button" } });
    expect(renderList(TO, "¿Cuál orden?", "Elegir orden", [{ id: "n2", title: "OT 24817", description: "09:00 a 11:00 · Centro" }])).toMatchObject({ interactive: { type: "list" } });
    expect(renderImage(TO, "media-1", "Roseta")).toMatchObject({ type: "image", image: { id: "media-1" } });
    expect(renderDocument(TO, "media-2", "acta-24817.pdf")).toMatchObject({ type: "document", document: { filename: "acta-24817.pdf" } });
    expect(renderReaction(TO, "wamid.IN1", "✅")).toMatchObject({ type: "reaction", reaction: { message_id: "wamid.IN1", emoji: "✅" } });
    const acta = renderTemplate(TO, { name: "acta_instalacion", params: ["24817"], document: { id: "media-3", filename: "acta-24817.pdf" } });
    expect(acta).toMatchObject({ type: "template", template: { name: "acta_instalacion", language: { code: "es_MX" }, components: [{ type: "header" }, { type: "body", parameters: [{ type: "text", text: "24817" }] }] } });
    const escalated = renderTemplate(TO, { name: "caso_escalado", params: ["C-0412", "Rogelio", "24818", "potencia fuera de rango después de 3 pasos"], buttonNonces: ["n-take", "n-decline"] });
    expect(escalated).toMatchObject({ template: { components: [{ type: "body" }, { type: "button", index: "0", parameters: [{ payload: "n-take" }] }, { type: "button", index: "1" }] } });
  });

  it("[FL-092] refuses what Meta would refuse: long titles, a fourth button, eleven rows, wrong parameters or a missing header", () => {
    expect(() => renderReplyButtons(TO, "x", [{ id: "n", title: "Un título de botón demasiado largo" }])).toThrow();
    expect(() => renderReplyButtons(TO, "x", [1, 2, 3, 4].map((n) => ({ id: `n${n}`, title: `B${n}` })))).toThrow();
    expect(() => renderList(TO, "x", "Elegir", Array.from({ length: 11 }, (_, n) => ({ id: `r${n}`, title: `Fila ${n}` })))).toThrow();
    expect(() => renderTemplate(TO, { name: "respuesta_supervisor", params: ["Héctor"], buttonNonces: ["n"] })).toThrow();
    expect(() => renderTemplate(TO, { name: "respuesta_supervisor", params: ["Héctor\nIbarra", "24818"], buttonNonces: ["n"] })).toThrow();
    expect(() => renderTemplate(TO, { name: "acta_instalacion", params: ["24817"] })).toThrow();
    expect(() => renderTemplate(TO, { name: "caso_escalado", params: ["C-1", "R", "1", "m"], buttonNonces: ["only-one"] })).toThrow();
  });
});

describe("live transport", () => {
  beforeEach(() => socialMock.reset());

  it("[FL-092] sends with SendWhatsAppMessage from the AWS id of the number and records the send on the message", async () => {
    const w = await world();
    socialMock.on(SendWhatsAppMessageCommand).resolves({ messageId: "wamid.OUT-1" });
    const ref = await outboundRow(w, "msg-out-0001");
    const payload = renderText(TO, "La potencia está en rango: −21,4 dBm.");
    const result = await liveTransport(w).send({ message: ref, clockId: DEMO, ispId: "isp-demo", payload });
    expect(result).toMatchObject({ ok: true, providerMessageId: "wamid.OUT-1" });
    const input = socialMock.commandCalls(SendWhatsAppMessageCommand)[0]?.args[0].input;
    expect(input).toMatchObject({ originationPhoneNumberId: AWS_ID, metaApiVersion: META_API_VERSION });
    expect(sentJson(0)).toEqual(payload);
    expect(await w.connector.conversations.getMessage(ref)).toMatchObject({ status: "SENT", providerMessageId: "wamid.OUT-1", sentAtReal: REAL_NOW, refs: { whatsapp: payload } });
  });

  it("[FL-049] the certificate as a document: PostWhatsAppMessageMedia from the Evidence bucket, then document.id; the media id is reused", async () => {
    const w = await world();
    socialMock.on(PostWhatsAppMessageMediaCommand).resolves({ mediaId: "meta-media-77" });
    socialMock.on(SendWhatsAppMessageCommand).resolves({ messageId: "wamid.OUT-2" });
    const transport = liveTransport(w);
    for (const id of ["msg-out-0002", "msg-out-0003"]) {
      const ref = await outboundRow(w, id, { kind: "CERTIFICATE", content: "DOCUMENT" });
      await transport.send({ message: ref, clockId: DEMO, ispId: "isp-demo", payload: renderDocument(TO, PENDING_MEDIA_ID, "acta-24817.pdf"), media: { bucket: "Evidence", key: PDF_KEY } });
    }
    expect(socialMock.commandCalls(PostWhatsAppMessageMediaCommand).map((call) => call.args[0].input)).toEqual([
      { originationPhoneNumberId: AWS_ID, sourceS3File: { bucketName: "poc-evidence", key: PDF_KEY } },
    ]);
    expect(sentJson(1)).toMatchObject({ type: "document", document: { id: "meta-media-77", filename: "acta-24817.pdf" } });
  });

  it("[FL-049] [FL-092] the template acta_instalacion with its document header, only when Meta approved it", async () => {
    const w = await world();
    socialMock.on(PostWhatsAppMessageMediaCommand).resolves({ mediaId: "meta-media-88" });
    socialMock.on(SendWhatsAppMessageCommand).resolves({ messageId: "wamid.OUT-3" });
    const payload = renderTemplate(TO, { name: "acta_instalacion", params: ["24817"], document: { id: PENDING_MEDIA_ID, filename: "acta-24817.pdf" } });
    await approve(w, "acta_instalacion", "PENDING");
    const ref = await outboundRow(w, "msg-out-0004", { kind: "CERTIFICATE", content: "TEMPLATE" });
    await expect(liveTransport(w).send({ message: ref, clockId: DEMO, ispId: "isp-demo", payload, media: { bucket: "Evidence", key: PDF_KEY } })).resolves.toEqual({ ok: false, code: "POLICY_DENIED", reason: "TEMPLATE_NOT_APPROVED", retryable: false });
    expect(socialMock.commandCalls(SendWhatsAppMessageCommand)).toHaveLength(0);
    await approve(w, "acta_instalacion", "APPROVED");
    await liveTransport(w).send({ message: ref, clockId: DEMO, ispId: "isp-demo", payload, media: { bucket: "Evidence", key: PDF_KEY } });
    expect(sentJson(0)).toMatchObject({ template: { name: "acta_instalacion", components: [{ type: "header", parameters: [{ type: "document", document: { id: "meta-media-88" } }] }, { type: "body" }] } });
  });

  it("[FL-092] the photos of a case go out as images uploaded from our bucket", async () => {
    const w = await world();
    socialMock.on(PostWhatsAppMessageMediaCommand).resolves({ mediaId: "meta-media-99" });
    socialMock.on(SendWhatsAppMessageCommand).resolves({ messageId: "wamid.OUT-4" });
    const ref = await outboundRow(w, "msg-out-0005");
    await liveTransport(w).send({ message: ref, clockId: DEMO, ispId: "isp-demo", payload: renderImage(TO, PENDING_MEDIA_ID, "Etiqueta de la ONU"), media: { bucket: "Evidence", key: "photos/wo-24818/ONU_LABEL_PHOTO/ev-1.jpg" } });
    expect(sentJson(0)).toMatchObject({ type: "image", image: { id: "meta-media-99" } });
  });

  it("[FL-092] answers a throttled send as a retryable failure, never an exception", async () => {
    const w = await world();
    socialMock.on(SendWhatsAppMessageCommand).rejects(new ThrottledRequestException({ message: "slow down", $metadata: {} }));
    const ref = await outboundRow(w, "msg-out-0006");
    const failure = await liveTransport(w).send({ message: ref, clockId: DEMO, ispId: "isp-demo", payload: renderText(TO, "Hola") });
    expect(failure).toEqual({ ok: false, code: "UNAVAILABLE", reason: "RATE_LIMITED", retryable: true });
    expect((await w.connector.conversations.getMessage(ref))?.status).toBe("QUEUED");
  });
});

describe("simulated transport for the certificate", () => {
  it("[FL-049] keeps the key of the PDF instead of uploading it, and the document reaches delivered", async () => {
    const w = await world();
    const applied: unknown[] = [];
    const transport = createSimulatedTransport({ conversations: w.connector.conversations, isps: w.connector.isps, applyStatuses: async (statuses) => void applied.push(...statuses), realClock: { now: async () => w.now() }, newId: () => "01J9ZQX0000000000000000009" });
    const ref = await outboundRow(w, "msg-out-0007", { kind: "CERTIFICATE", content: "DOCUMENT" });
    const result = await transport.send({ message: ref, clockId: DEMO, ispId: "isp-demo", payload: renderDocument(TO, PENDING_MEDIA_ID, "acta-24817.pdf"), media: { bucket: "Evidence", key: PDF_KEY } });
    expect(result).toMatchObject({ ok: true, payload: { document: { id: `sim-s3:Evidence:${PDF_KEY}` } } });
    expect(socialMock.commandCalls(PostWhatsAppMessageMediaCommand)).toHaveLength(0);
    expect(applied).toMatchObject([{ status: "sent" }, { status: "delivered" }]);
  });
});
