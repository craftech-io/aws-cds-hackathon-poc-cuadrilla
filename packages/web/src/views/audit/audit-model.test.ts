import { describe, expect, it } from "vitest";
import { actionText, actorText, decisionTone, listInput, monthLabel, reasonText, ruleOptions, totals, triggerText } from "./audit-model";

const byRule = {
  month: "2026-10",
  violations: 0,
  rules: [
    { ruleId: "CP-OPTOUT", ALLOW: 0, DENY: 2, DEFER: 0 },
    { ruleId: "CP-WA-24H", ALLOW: 5, DENY: 0, DEFER: 1 },
    { ruleId: "NONE", ALLOW: 3, DENY: 0, DEFER: 0 },
  ],
  blocks: [],
};

describe("decisions log model [FL-088]", () => {
  it("names actors by their kind, never by their id, and actions, triggers and reasons in words", () => {
    expect(actorText("PERSON:inst-rogelio")).toBe("Persona del mundo");
    expect(actorText("USER:usr-e2e-0000000000ab")).toBe("Usuario de la consola");
    expect(actorText("AGENT")).toBe("Agente");
    expect(actionText("SEND_WHATSAPP")).toBe("Envío de WhatsApp");
    expect(actionText("SOMETHING_NEW")).toBe("Something new");
    expect(triggerText("INSTALLER_MESSAGE")).toBe("Mensaje del instalador");
    expect(triggerText(null)).toBe("—");
    expect(reasonText("PHONE_NOT_SYNTHETIC")).toBe("Teléfono fuera del bloque sintético del mundo");
    expect(reasonText("SOME_NEW_REASON")).toBe("Some new reason");
    expect(reasonText("free text from somewhere")).toBe("—");
    expect(decisionTone("DENY")).toBe("danger");
  });

  it("builds the filter of audit.list and offers the rules the month names", () => {
    expect(listInput("ALL", "")).toEqual({});
    expect(listInput("DENY", "CP-OPTOUT")).toEqual({ decision: "DENY", ruleId: "CP-OPTOUT" });
    expect(ruleOptions(byRule)).toEqual(["CP-OPTOUT", "CP-WA-24H"]);
    expect(ruleOptions(undefined)).toEqual([]);
    expect(totals(byRule)).toEqual({ deny: 2, defer: 1 });
    expect(monthLabel("2026-10")).toBe("10/2026");
  });
});
