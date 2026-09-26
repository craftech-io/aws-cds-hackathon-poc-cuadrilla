import { describe, expect, it } from "vitest";
import { CASE_1, CLOCK, HASH_A, ISP, openCase, testConnector } from "../testing";

const meta = { createdAt: "2026-09-26T00:00:00.000Z", updatedAt: "2026-09-26T00:00:00.000Z", version: 1, synthetic: true };
const GUEST_ROW = { PK: `CASE#${CASE_1}`, SK: "META", entity: "Case", ...meta, ...openCase({ ispId: "isp-guest-07", clockId: "GUEST#isp-guest-07" }) };

describe("seed store", () => {
  it("loads valid rows at the key their codec computes and recomputes the index keys", async () => {
    const world = testConnector();
    const person = { PK: "PERSON#inst-rogelio", SK: "META", entity: "Person", ...meta, personId: "inst-rogelio", ispId: ISP, clockId: CLOCK, role: "INSTALLER", firstName: "Rogelio", lastName: "Méndez", phone: "+525501010001", phoneHash: HASH_A, active: true, phoneKey: "stale" };
    expect(await world.connector.seed.loadItems("People", [person])).toEqual({ table: "People", written: 2 });
    expect(await world.connector.people.getAddressClaim(CLOCK, HASH_A)).toMatchObject({ personId: "inst-rogelio", synthetic: true });
    const stored = await world.connector.seed.getItem("People", { PK: "PERSON#inst-rogelio", SK: "META" });
    expect(stored).toMatchObject({ phoneKey: `${CLOCK}#${HASH_A}`, ispKindKey: `ISP#${ISP}#INSTALLER`, synthetic: true });
    expect((await world.connector.people.findByPhone(CLOCK, HASH_A))?.personId).toBe("inst-rogelio");
    await world.connector.seed.deleteItems("People", [{ PK: "PERSON#inst-rogelio", SK: "META" }]);
    expect(await world.connector.people.getPerson("inst-rogelio")).toBeUndefined();
    const twin = { ...person, PK: "PERSON#inst-karina", personId: "inst-karina", firstName: "Karina" };
    await expect(world.connector.seed.loadItems("People", [person, twin])).rejects.toMatchObject({ code: "VALIDATION", message: expect.stringMatching(/share a phone/) });
  });

  it("stores sort-key instants in UTC and scopes rows of cloned worlds", async () => {
    const world = testConnector();
    await world.connector.seed.loadItems("Cases", [GUEST_ROW]);
    expect(await world.connector.seed.getItem("Cases", { PK: `CASE#${CASE_1}`, SK: "META" })).toMatchObject({ createdAtSim: "2026-10-13T17:50:00.000Z", world: "guest", ispStatusKey: "ISP#isp-guest-07#OPEN" });
  });

  it("refuses a row of another table, an invalid row or one stored at the wrong key, writing nothing", async () => {
    const world = testConnector();
    const isp = { PK: `ISP#${ISP}`, SK: "META", entity: "Isp", ...meta, ispId: ISP, kind: "DEMO", clockId: CLOCK };
    await expect(world.connector.seed.loadItems("People", [isp])).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(world.connector.seed.loadItems("Isps", [isp, { ...isp, kind: "PROD" }])).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(world.connector.seed.loadItems("Isps", [{ ...isp, SK: "SETTINGS" }])).rejects.toMatchObject({ code: "VALIDATION", message: expect.stringMatching(/key its codec computes/) });
    expect(world.client.dump("Isps")).toEqual([]);
  });
});
