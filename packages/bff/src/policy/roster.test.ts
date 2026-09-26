import { describe, expect, it } from "vitest";
import { HASH_B, HASH_C, openCase, supervisor as supervisorRecord } from "../connector/testing";
import { evaluateAt } from "./as-of";
import { ruleEntry } from "./engine";
import { rosterIdsAt } from "./history";
import { loadPolicyRecords } from "./records";
import { CASE_ID, OTHER_CASE_ID, ROSTER_N3, at, decide, entryOf, facts, mx, policyWorld, summary, supervisor, system } from "./testing";

const caseRequest = system("CASE_REQUEST", { form: "TEMPLATE", templateName: "caso_escalado", caseId: CASE_ID, workOrderId: "wo-24818" });
const roster = { primaryId: "sup-adriana", secondaryId: "sup-hector" };
const onRoster = (localSim: string) => facts({ now: at(localSim), roster, caseState: { caseId: CASE_ID, status: "OPEN" } });

describe("[FL-007] CP-ROSTER: case messages only to the supervisors of the roster", () => {
  it("sends the case request to the supervisor on duty and to the backup, and to nobody else", () => {
    const toAdriana = decide({ message: caseRequest, recipient: supervisor("sup-adriana"), facts: onRoster("2026-10-13 11:50") });
    expect(summary(toAdriana)).toBe("ALLOW");
    expect(ruleEntry(toAdriana, "CP-ROSTER")).toEqual({ ruleId: "CP-ROSTER", result: "PASS", detail: "PRIMARY" });
    expect(entryOf({ message: caseRequest, recipient: supervisor("sup-hector"), facts: onRoster("2026-10-13 12:00") }, "CP-ROSTER").detail).toBe("SECONDARY");
    expect(summary(decide({ message: caseRequest, recipient: supervisor("sup-daniel"), facts: onRoster("2026-10-13 11:50") }))).toBe("DENY CP-ROSTER NOT_ON_ROSTER");
  });

  it("applies to case requests, safety alerts and case briefs, and not to the notice of a taken case", () => {
    const alert = system("SAFETY_ALERT", { form: "TEMPLATE", templateName: "alerta_seguridad", caseId: CASE_ID });
    const brief = system("CASE_BRIEF", { text: "Caso C-0412 · Orden 24818 · Rogelio.", caseId: CASE_ID, inResponseToInbound: true });
    const takenNotice = system("CASE_TAKEN_NOTICE", { text: "Ya lo tomó Héctor.", caseId: CASE_ID });
    const outsider = supervisor("sup-daniel");
    expect(summary(decide({ message: alert, recipient: outsider, facts: onRoster("2026-10-13 15:10") }))).toBe("DENY CP-ROSTER NOT_ON_ROSTER");
    expect(summary(decide({ message: brief, recipient: outsider, facts: onRoster("2026-10-13 12:05") }))).toBe("DENY CP-ROSTER NOT_ON_ROSTER");
    expect(entryOf({ message: takenNotice, recipient: outsider, facts: onRoster("2026-10-13 12:05") }, "CP-ROSTER")).toEqual({ ruleId: "CP-ROSTER", result: "NOT_APPLICABLE" });
  });

  it("keeps the case's roster at any hour (a safety alert at 21:30 still reaches it) and denies without a roster", () => {
    const alert = system("SAFETY_ALERT", { form: "TEMPLATE", templateName: "alerta_seguridad", caseId: CASE_ID });
    expect(summary(decide({ message: alert, recipient: supervisor(), facts: onRoster("2026-10-13 21:30") }))).toBe("ALLOW");
    expect(summary(decide({ message: caseRequest, recipient: supervisor(), facts: facts({ now: at("2026-10-13 11:50") }) }))).toBe("DENY CP-ROSTER NO_ROSTER");
  });

  it("reads the roster of a crew at any instant from its history", async () => {
    const world = await policyWorld();
    const changed = await world.connector.isps.setRoster({ ...ROSTER_N3, primaryId: "sup-hector", secondaryId: "sup-adriana" }, { actor: "USER:usr-adriana", atSim: mx("2026-10-13 10:00") });
    expect(rosterIdsAt(changed, at("2026-10-13 09:00"))).toEqual({ primaryId: "sup-adriana", secondaryId: "sup-hector" });
    expect(rosterIdsAt(changed, at("2026-10-13 10:00"))).toEqual({ primaryId: "sup-hector", secondaryId: "sup-adriana" });
    expect(rosterIdsAt(changed, at("2026-10-12 23:00"))).toEqual({ primaryId: "sup-adriana", secondaryId: "sup-hector" });
  });

  it("lets an open case keep the roster it was opened with, while the next case copies the new one", async () => {
    const world = await policyWorld();
    const { cases, isps, people } = world.connector;
    const staff = [
      ["sup-adriana", HASH_B, "+525501020001"],
      ["sup-hector", HASH_C, "+525501020002"],
      ["sup-daniel", "d".repeat(64), "+525501020003"],
    ] as const;
    for (const [id, phoneHash, phone] of staff) {
      await people.createPerson(supervisorRecord(id, phoneHash, { phone }));
      await people.grantConsent({ personId: id, clockId: "GLOBAL#isp-demo", medium: "WHATSAPP_KEYWORD", textVersion: "v001" }, { actor: "SEED", atSim: mx("2026-10-01 08:00") });
    }
    await cases.createCase(openCase({ caseId: CASE_ID, createdAtSim: mx("2026-10-13 09:50") }));
    // At 10:00 Daniel replaces Adriana on duty; the case opened at 09:50 keeps Adriana and Héctor.
    await isps.setRoster({ ...ROSTER_N3, primaryId: "sup-daniel" }, { actor: "USER:usr-adriana", atSim: mx("2026-10-13 10:00") });
    await cases.createCase(openCase({ caseId: OTHER_CASE_ID, createdAtSim: mx("2026-10-13 11:50"), roster: { primaryId: "sup-daniel", secondaryId: "sup-hector", zoneChiefId: "zc-marisol" } }));

    const request = async (personId: string, caseId: string) => {
      const when = at("2026-10-13 12:00");
      const records = await loadPolicyRecords(world.connector, { ispId: "isp-demo", personId, route: "SIMULATED", workOrderId: "wo-24818", crewId: "crew-n3", at: when });
      return summary(evaluateAt({ ...caseRequest, caseId }, { kind: "PERSON", route: "SIMULATED" }, records, when));
    };
    expect(await request("sup-adriana", CASE_ID)).toBe("ALLOW");
    expect(await request("sup-daniel", CASE_ID)).toBe("DENY CP-ROSTER NOT_ON_ROSTER");
    expect(await request("sup-daniel", OTHER_CASE_ID)).toBe("ALLOW");
    expect(await request("sup-adriana", OTHER_CASE_ID)).toBe("DENY CP-ROSTER NOT_ON_ROSTER");
  });
});
