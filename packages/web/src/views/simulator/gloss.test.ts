import { describe, expect, it } from "vitest";
import { BUTTON_LABELS } from "@cuadrilla/bff/copy/buttons";
import { TEMPLATE_GLOSS, enGloss } from "@cuadrilla/bff/copy/en-gloss";
import { esMX } from "@cuadrilla/bff/copy/es-MX";
import { fillPlaceholders } from "@cuadrilla/bff/copy/helpers";
import { renderTemplateBody } from "@cuadrilla/bff/copy/templates";
import { MAIN_STORY } from "@cuadrilla/bff/story/main-story";
import { buttonGloss, glossOf, patternOf } from "./gloss";

const plain = (text: string) => ({ text, templateName: null });

describe("English gloss of the phone [FL-082]", () => {
  it("[FL-082] every WhatsApp message of the main story has its gloss from the story itself", () => {
    const messages = MAIN_STORY.filter((entry) => entry.channel === "WHATSAPP" && entry.kind !== "TEMPLATE");
    expect(messages.length).toBeGreaterThan(10);
    for (const entry of messages) expect(glossOf(plain(entry.text)), entry.id).toBe(entry.glossEn);
  });

  it("[FL-082] a template's body is glossed with its own parameters, the words the code put there in English", () => {
    const body = renderTemplateBody("ordenes_del_dia", ["Rogelio", "3", "09:00 a 11:00"]);
    expect(glossOf({ text: body, templateName: "ordenes_del_dia" })).toBe(fillPlaceholders(TEMPLATE_GLOSS.ordenes_del_dia, ["Rogelio", "3", "09:00 a 11:00"]));
    const reason = esMX.caseReason({ reason: "DIAGNOSIS_ATTEMPTS", symptom: "LOW_POWER" });
    const escalated = renderTemplateBody("caso_escalado", ["C-0412", "Rogelio", "24818", reason]);
    const english = enGloss.caseReason({ reason: "DIAGNOSIS_ATTEMPTS", symptom: "LOW_POWER" });
    expect(glossOf({ text: escalated, templateName: "caso_escalado" })).toBe(fillPlaceholders(TEMPLATE_GLOSS.caso_escalado, ["C-0412", "Rogelio", "24818", english]));
    const alert = renderTemplateBody("alerta_seguridad", ["24819", "Rogelio", esMX.hazard.ELECTRICAL]);
    expect(glossOf({ text: alert, templateName: "alerta_seguridad" })).toBe(fillPlaceholders(TEMPLATE_GLOSS.alerta_seguridad, ["24819", "Rogelio", enGloss.hazard.ELECTRICAL]));
  });

  it("[FL-082] fixed texts of copy/ are glossed key by key, including the ones built from names, items and reasons", () => {
    expect(glossOf(plain(esMX.safetyInstruction))).toBe(enGloss.safetyInstruction);
    expect(glossOf(plain(esMX.unknownNumber))).toBe(enGloss.unknownNumber);
    expect(glossOf(plain(esMX.welcome("Julián", "INSTALLER")))).toBe(enGloss.welcome("Julián", "INSTALLER"));
    expect(glossOf(plain(esMX.welcome("Adriana", "SUPERVISOR")))).toBe(enGloss.welcome("Adriana", "SUPERVISOR"));
    expect(glossOf(plain(esMX.caseOpened("Adriana")))).toBe(enGloss.caseOpened("Adriana"));
    expect(glossOf(plain(esMX.caseTakenByOther("Héctor")))).toBe(enGloss.caseTakenByOther("Héctor"));
    expect(glossOf(plain(esMX.shiftRegistered("15:00")))).toBe(enGloss.shiftRegistered("15:00"));
    expect(glossOf(plain(esMX.caseClosedConfirmation("24818", "Rogelio")))).toBe(enGloss.caseClosedConfirmation("24818", "Rogelio"));
    expect(glossOf(plain(esMX.leaseBound("Rogelio", 48)))).toBe(enGloss.leaseBound("Rogelio", 48));
    expect(glossOf(plain(esMX.rejectReason("GLARE", "ONU_LABEL_PHOTO")))).toBe(enGloss.rejectReason("GLARE", "ONU_LABEL_PHOTO"));
    expect(glossOf(plain(esMX.closeNotComplete(["ROSETTE_PHOTO", "CUSTOMER_OK"])))).toBe(enGloss.closeNotComplete(["ROSETTE_PHOTO", "CUSTOMER_OK"]));
  });

  it("[FL-082] the case brief repeats the installer's name and keeps the verified summary as written", () => {
    const input = { caseLabel: "C-0412", workOrderNumber: "24818", installerFirstName: "Rogelio", reasonText: esMX.caseReason({ reason: "SAFETY" }), summary: "Potencia baja tras tres pasos." };
    expect(glossOf(plain(esMX.caseBrief(input)))).toBe(enGloss.caseBrief({ ...input, reasonText: enGloss.caseReason({ reason: "SAFETY" }) }));
  });

  it("[FL-082] a relayed message keeps the bridge's prefix in English and glosses what was relayed", () => {
    const relayed = MAIN_STORY.find((entry) => entry.kind === "TEXT" && entry.from === "sup-hector");
    expect(relayed).toBeDefined();
    const text = `${esMX.relayPrefix("Héctor", "SUPERVISOR")}${relayed?.text ?? ""}`;
    expect(glossOf(plain(text))).toBe(`${enGloss.relayPrefix("Héctor", "SUPERVISOR")}${relayed?.glossEn ?? ""}`);
    expect(glossOf(plain(`${esMX.relayPrefix("Rogelio", "INSTALLER")}texto libre`))).toBe(`${enGloss.relayPrefix("Rogelio", "INSTALLER")}texto libre`);
  });

  it("[FL-082] a free reply of the agent has no gloss, and buttons are glossed by their labels", () => {
    expect(glossOf(plain("Revisa la roseta y dime qué ves."))).toBeUndefined();
    expect(glossOf(plain(""))).toBeUndefined();
    expect(glossOf({ text: null, templateName: null })).toBeUndefined();
    expect(buttonGloss(BUTTON_LABELS.TAKE_CASE.es)).toBe(BUTTON_LABELS.TAKE_CASE.en);
    expect(buttonGloss("Otro")).toBeUndefined();
  });

  it("a repeated argument is matched once and read back where the text names it", () => {
    const pattern = patternOf(2, (name, order) => `${name} y ${order}; otra vez ${name}.`, (name, order) => `${name} and ${order}; ${name} again.`);
    const match = pattern.regex.exec("Ana y 12; otra vez Ana.");
    expect(match).not.toBeNull();
    expect(pattern.gloss(match?.slice(1) ?? [])).toBe("Ana and 12; Ana again.");
    expect(pattern.regex.exec("Ana y 12; otra vez Luis.")).toBeNull();
  });
});
