import { describe, expect, it } from "vitest";
import { type PersonRow, canManage, compactPhone, crewLabel, crewsOf, dayLabel, emptyForm, optInText, roleCounts, sortedPeople, upsertInputOf, zoneLabel, zonesOf } from "./people-model";

const person = (overrides: Partial<PersonRow>): PersonRow =>
  ({ personId: "inst-x", role: "INSTALLER", firstName: "Ana", lastName: "Ruiz", active: true, crewId: "crew-n3", zoneId: "zone-norte", phoneMasked: "+52******0001", optIn: { status: "NONE" }, ...overrides }) as PersonRow;

describe("people model [FL-001] [FL-005] [FL-007] [FL-008]", () => {
  it("lets supervisors and guests manage people, never operations staff", () => {
    expect(canManage("SUPERVISOR")).toBe(true);
    expect(canManage("GUEST")).toBe(true);
    expect(canManage("OPS")).toBe(false);
    expect(canManage(undefined)).toBe(false);
  });

  it("says the opt-in with its date and text version, the opt-out, or its absence", () => {
    expect(optInText({ status: "NONE" })).toBe("Sin opt-in");
    expect(optInText({ status: "GRANTED", medium: "WHATSAPP_KEYWORD", textVersion: "v001", grantedAtSim: "2026-10-13T07:12:00-06:00", revokedAtSim: null })).toBe("Con opt-in desde mar 13/10 07:12 · texto v001 (por «ALTA» en WhatsApp)");
    expect(optInText({ status: "REVOKED", medium: "WHATSAPP_KEYWORD", textVersion: "v001", grantedAtSim: null, revokedAtSim: "2026-10-13T08:00:00-06:00" })).toBe("Dado de baja mar 13/10 08:00");
  });

  it("sorts installers first and counts by role; derives the crews and zones that have staff", () => {
    const rows = [person({ personId: "zc-a", role: "ZONE_CHIEF", firstName: "Zoe", crewId: undefined }), person({ personId: "sup-b", role: "SUPERVISOR", firstName: "Beto", crewId: "crew-s1", zoneId: "zone-sur" }), person({ personId: "inst-c", firstName: "Carla" })];
    expect(sortedPeople(rows, "ALL").map((row) => row.personId)).toEqual(["inst-c", "sup-b", "zc-a"]);
    expect(sortedPeople(rows, "SUPERVISOR").map((row) => row.personId)).toEqual(["sup-b"]);
    expect(roleCounts(rows)).toEqual({ ALL: 3, INSTALLER: 1, SUPERVISOR: 1, ZONE_CHIEF: 1 });
    expect(crewsOf(rows)).toEqual(["crew-n3", "crew-s1"]);
    expect(zonesOf(rows)).toEqual(["zone-norte", "zone-sur"]);
  });

  it("labels zones and crews without showing their ids", () => {
    expect(zoneLabel("zone-norte")).toBe("Zona Norte");
    expect(crewLabel("crew-n3", { "crew-n3": "Equipo Norte 3" })).toBe("Equipo Norte 3");
    expect(crewLabel("crew-s1", {})).toBe("Equipo S1");
    expect(dayLabel("2026-10-13")).toBe("mar 13/10");
  });

  it("builds the upsert input: the role only for a new person, the crew for field staff, the zone for a zone chief", () => {
    const form = { ...emptyForm(["crew-n3"], ["zone-norte"]), firstName: " Lucía ", lastName: "Paz", phone: "+52 55 0207 0123" };
    expect(upsertInputOf(form, undefined)).toEqual({ role: "INSTALLER", firstName: "Lucía", lastName: "Paz", crewId: "crew-n3", zoneId: null, phone: "+525502070123" });
    expect(upsertInputOf({ ...form, role: "ZONE_CHIEF", email: "success+zc-x@simulator.amazonses.com", phone: "" }, undefined)).toEqual({
      role: "ZONE_CHIEF",
      firstName: "Lucía",
      lastName: "Paz",
      zoneId: "zone-norte",
      crewId: null,
      email: "success+zc-x@simulator.amazonses.com",
    });
    expect(upsertInputOf({ ...form, phone: "" }, "inst-x")).toEqual({ personId: "inst-x", firstName: "Lucía", lastName: "Paz", crewId: "crew-n3", zoneId: null });
    expect(upsertInputOf({ ...form, lastName: "  " }, undefined)).toBeUndefined();
    expect(compactPhone("+52 (55) 0207-0123")).toBe("+525502070123");
  });
});
