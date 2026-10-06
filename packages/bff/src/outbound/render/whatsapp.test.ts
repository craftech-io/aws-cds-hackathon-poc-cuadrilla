import { describe, expect, it } from "vitest";
import { type WhatsAppSendRequest, WhatsAppSendRequest as Schema } from "../types";
import { sendOutbound } from "../pipeline";
import { NONCE_KEY, mx, pipelineKit } from "../testing";
import { createMemoryConnector } from "../../connector/memory/index";
import { defaultObjectOf, displayTextOf, formOf, renderWhatsApp, shapeOf } from "./whatsapp";

const TARGET = { to: "+525501010001", personId: "inst-rogelio", phoneHash: "a".repeat(64), clockId: "GLOBAL#isp-demo", messageId: "msg-01JB8Z9Q2W3E4R5T6Y7V8X0001", day: "2026-10-13" };

function request(overrides: Partial<WhatsAppSendRequest>): WhatsAppSendRequest {
  return Schema.parse({ channel: "WHATSAPP", personId: "inst-rogelio", kind: "REPLY", author: "AGENT", eventAtSim: mx("2026-10-13 09:21"), workOrderId: "wo-24817", ...overrides });
}

function nonceDeps() {
  const { connector } = createMemoryConnector({ now: () => new Date("2026-10-13T15:20:00.000Z") });
  return { connector, deps: { runtime: connector.runtime, nonceKey: NONCE_KEY, realClock: { now: async () => new Date("2026-10-13T15:20:00.000Z") } } };
}

describe("render of a WhatsApp send", () => {
  it("[FL-009] ordenes_del_dia: the template with its parameters and a nonce bound to the phone, the day and VIEW_ORDERS", async () => {
    const { connector, deps } = nonceDeps();
    const send = request({ kind: "DAY_START", author: "SYSTEM", workOrderId: undefined, template: { name: "ordenes_del_dia", params: ["Rogelio", "3", "09:00 a 11:00"] } });
    const rendered = await renderWhatsApp(send, TARGET, deps);
    expect(rendered.content).toBe("TEMPLATE");
    expect(rendered.payload).toMatchObject({ type: "template", to: "525501010001", template: { name: "ordenes_del_dia", language: { code: "es_MX" } } });
    const payload = JSON.stringify(rendered.payload);
    const nonce = /"payload":"([^"]+)"/.exec(payload)?.[1] ?? "";
    expect(await connector.runtime.getNonce(nonce)).toMatchObject({ action: "VIEW_ORDERS", object: { kind: "DAY", id: "2026-10-13" }, phoneHash: TARGET.phoneHash, personId: "inst-rogelio", messageId: TARGET.messageId });
    expect(displayTextOf(send)).toBe("Hola Rogelio, hoy tienes 3 instalaciones asignadas en tu ruta. La primera cita es de 09:00 a 11:00. Toca Ver órdenes para recibir el detalle de cada una.");
  });

  it("buttons take their titles from copy/ and act on the session's order, the item or the message", async () => {
    const { deps } = nonceDeps();
    const send = request({ text: "¿Cuál foto me mandas?", buttons: [{ action: "CHOOSE_ITEM", item: "ONU_LABEL_PHOTO" }, { action: "CUSTOMER_OK" }, { action: "NO_THANKS" }] });
    expect(formOf(send)).toBe("INTERACTIVE");
    const rendered = await renderWhatsApp(send, TARGET, deps);
    expect(rendered.payload).toMatchObject({ type: "interactive", interactive: { type: "button", body: { text: "¿Cuál foto me mandas?" } } });
    expect((rendered.interactive?.buttons as Array<{ title: string }>).map((button) => button.title)).toEqual(["Etiqueta de la ONU", "Cliente conforme", "No, gracias"]);
    expect(defaultObjectOf("CUSTOMER_OK", send, TARGET)).toEqual({ kind: "WORK_ORDER", id: "wo-24817" });
    expect(defaultObjectOf("NO_THANKS", send, TARGET)).toEqual({ kind: "MESSAGE", id: TARGET.messageId });
  });

  it("the certificate template carries the document header with the media placeholder the transport replaces", async () => {
    const { deps } = nonceDeps();
    const send = request({ kind: "CERTIFICATE", author: "SYSTEM", template: { name: "acta_instalacion", params: ["24817"], document: { media: { bucket: "Evidence", key: "certificates/wo-24817/acta-24817.pdf" }, filename: "acta-24817.pdf" } } });
    const rendered = await renderWhatsApp(send, TARGET, deps);
    expect(rendered.media).toEqual({ bucket: "Evidence", key: "certificates/wo-24817/acta-24817.pdf" });
    expect(JSON.stringify(rendered.payload)).toContain('"id":"pending-media"');
  });

  it("refuses up front what WhatsApp would refuse, without issuing nonces", async () => {
    await expect(shapeOf(request({ kind: "DAY_START", author: "SYSTEM", template: { name: "ordenes_del_dia", params: ["Rogelio", "3"] } }), TARGET)).rejects.toMatchObject({ code: "INVALID" });
    await expect(shapeOf(request({ kind: "DAY_START", author: "SYSTEM", template: { name: "ordenes_del_dia", params: ["Rogelio\nMéndez", "3", "09:00 a 11:00"] } }), TARGET)).rejects.toMatchObject({ code: "INVALID" });
    await expect(shapeOf(request({ text: "x".repeat(1100), buttons: [{ action: "CUSTOMER_OK" }] }), TARGET)).rejects.toMatchObject({ code: "INVALID" });
    await expect(shapeOf(request({ text: "¿Tomas el caso?", buttons: [{ action: "TAKE_CASE" }] }), TARGET)).rejects.toMatchObject({ code: "INVALID" });
  });

  it("[FL-053] no template parameter that leaves carries a phone, an email, a CURP or an RFC", async () => {
    const kit = await pipelineKit();
    const result = await sendOutbound(
      kit.deps,
      { channel: "WHATSAPP", personId: "inst-rogelio", kind: "DAY_START", author: "SYSTEM", eventAtSim: mx("2026-10-13 07:30"), template: { name: "ordenes_del_dia", params: ["Rogelio MEGR800101HDFNRG09", "3", "09:00 a 11:00 tel 5598765432 rogelio@correo-falso.mx"] } },
      kit.call,
    );
    expect(result.status).toBe("SENT");
    const payload = JSON.stringify(kit.sends[0]?.payload);
    expect(payload).not.toMatch(/MEGR800101HDFNRG09|5598765432|correo-falso/);
    const stored = (await kit.world.connector.conversations.listMessages("inst-rogelio")).find((message) => message.direction === "OUT");
    expect(JSON.stringify(stored?.templateParams)).not.toMatch(/MEGR800101HDFNRG09|5598765432|correo-falso/);
  });
});
