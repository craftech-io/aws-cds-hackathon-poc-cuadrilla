// The oracles of §4.3 over stored messages (no AWS): outbound negatives by name only, citations against the
// turn's retrieval and the expected sections, figures grounded in the turn's tools, and the light load's
// per-installer thread check.
import { describe, expect, it } from "vitest";
import type { Message } from "../../../packages/bff/src/domain/conversations";
import { threadProblems } from "../load-light";
import { agentReplies, citationProblem, forbiddenIn, hasPhone, normalizeFacts, offersButton, offersEscalation, outboundViolations, ungroundedFigures } from "./oracles";

const message = (fields: Partial<Message>): Message =>
  ({
    messageId: "m1",
    personId: "inst-1",
    ispId: "isp-qa-812-1-sc-01",
    clockId: "qa-812-1-sc-01",
    direction: "OUT",
    channel: "WHATSAPP",
    content: { type: "text" },
    status: "SENT",
    author: "AGENT",
    simulated: true,
    sentAtSim: "2026-10-13T15:00:00.000Z",
    ...fields,
  }) as Message;

describe("outbound negatives", () => {
  it("names the patterns an outgoing text matches, never the value", () => {
    expect(forbiddenIn("Escríbele a soporte@example.com o entra a https://example.com")).toEqual(["email", "url"]);
    expect(forbiddenIn("Su CURP es QAXX010101HDFXXX09")).toEqual(["curp"]);
    expect(forbiddenIn("Llama al 55 0300 4321 hoy")).toEqual(["phone"]);
    expect(forbiddenIn("La ventana es 2026-10-13 de 09:00 a 11:00 y la potencia −19,5 dBm")).toEqual([]);
    expect(hasPhone("orden 24817")).toBe(false);
  });

  it("checks only outgoing messages and lets a cited commercial policy promise", () => {
    const inbound = message({ messageId: "in", direction: "IN", text: "mi correo es a@b.com", author: "PERSON:inst-1" });
    const promise = message({ messageId: "p", text: "La instalación va sin costo", refs: { citations: ["COM-04"] } });
    const loose = message({ messageId: "l", text: "Te lo regalo" });
    expect(outboundViolations([inbound, promise, loose])).toEqual(["l: promise"]);
  });
});

describe("citations and figures", () => {
  const turns = [{ turnId: "t1", tools: ["search_procedures"], searchedSections: ["DIAG-02", "DIAG-03"], figures: ["-19,5", "24817"] }];

  it("accepts a citation the turn retrieved that meets the expected sections", () => {
    expect(citationProblem({ turns }, message({ turnId: "t1", refs: { citations: ["DIAG-02"] } }), ["DIAG-02"])).toBeUndefined();
  });

  it("refuses no citation, a section the turn did not retrieve, and one outside the expected ones", () => {
    expect(citationProblem({ turns }, message({ turnId: "t1" }), ["DIAG-02"])).toBe("no citation");
    expect(citationProblem({ turns }, message({ turnId: "t1", refs: { citations: ["SEG-01"] } }), [])).toContain("did not retrieve");
    expect(citationProblem({ turns }, message({ turnId: "t1", refs: { citations: ["DIAG-03"] } }), ["DIAG-02"])).toContain("none of DIAG-02");
    expect(citationProblem({ turns }, message({ turnId: "t9", refs: { citations: ["DIAG-02"] } }), ["DIAG-02"])).toContain("not in the snapshot");
  });

  it("flags a decimal reading the turn's tools never returned", () => {
    expect(ungroundedFigures("La potencia es -19,5 dBm", turns[0])).toEqual([]);
    expect(ungroundedFigures("La potencia es -21,3 dBm", turns[0])).toEqual([normalizeFacts("-21,3")]);
  });
});

describe("replies and offers", () => {
  it("keeps the agent's replies and reads the stored buttons", () => {
    const reply = message({ kind: "REPLY", text: "Revisa el conector", interactive: { buttons: [{ action: "CONSULT_SUPERVISOR", title: "Consultar" }] } });
    const notice = message({ messageId: "n", kind: "SYSTEM_NOTICE", author: "SYSTEM", text: "aviso" });
    expect(agentReplies([reply, notice]).map((entry) => entry.messageId)).toEqual(["m1"]);
    expect(offersButton(reply, "CONSULT_SUPERVISOR")).toBe(true);
    expect(offersEscalation(message({ text: "¿Quieres que le avise a tu supervisora?" }))).toBe(true);
    expect(offersEscalation(message({ text: "Listo" }))).toBe(false);
  });
});

describe("the light load's thread check", () => {
  const sent = ["uno", "dos", "tres"];
  const inbound = (text: string, id: string) => ({ direction: "IN", text, messageId: id });

  it("passes each text once, in order, with no repeated turn", () => {
    const person = { personId: "inst-1", messages: [inbound("uno", "a"), { direction: "OUT", text: "ok", messageId: "o" }, inbound("dos", "b"), inbound("tres", "c")], turnNotes: [{ turnId: "t1", trigger: "INSTALLER_MESSAGE" }] };
    expect(threadProblems(person, sent)).toEqual([]);
  });

  it("reports a duplicate, the order broken and more turns than inbounds", () => {
    const person = {
      personId: "inst-1",
      messages: [inbound("dos", "a"), inbound("uno", "b"), inbound("tres", "c"), inbound("tres", "c")],
      turnNotes: ["t1", "t2", "t3", "t3", "t5"].map((turnId) => ({ turnId, trigger: "INSTALLER_MESSAGE" })),
    };
    expect(threadProblems(person, sent)).toEqual([
      'inst-1: "tres" stored 2 time(s)',
      "inst-1: stored out of order",
      "inst-1: a repeated inbound id",
      "inst-1: a repeated turn",
      "inst-1: 5 turns for 4 inbound(s)",
    ]);
  });
});
