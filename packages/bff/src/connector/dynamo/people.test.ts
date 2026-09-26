import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { AmbiguousIdentityError } from "../../domain/people";
import { CLOCK, HASH_A, HASH_B, HASH_C, ISP, QA_CLOCK, QA_ISP, installer, supervisor, testConnector } from "../testing";
import { DynamoTableClient } from "./client";
import { createConnector } from "./connector";
import { createRepoContext } from "./repo";

const change = { actor: "USER:usr-adriana", atSim: "2026-10-13T08:00:00-06:00", reason: "baja" } as const;

describe("people repository", () => {
  let world: ReturnType<typeof testConnector>;

  beforeEach(() => {
    world = testConnector();
  });

  it("creates a person with its ADDR# claim and the identity and listing index keys", async () => {
    const person = await world.connector.people.createPerson(installer());
    expect(person).toMatchObject({ personId: "inst-rogelio", version: 1, active: true, history: [] });
    const rows = world.client.dump("People");
    expect(rows.find((row) => row.SK === "META")).toMatchObject({
      PK: "PERSON#inst-rogelio",
      entity: "Person",
      phoneKey: `${CLOCK}#${HASH_A}`,
      ispKindKey: `ISP#${ISP}#INSTALLER`,
      sortName: "mendez#rogelio#inst-rogelio",
    });
    expect(rows.find((row) => row.SK === "CLAIM")).toMatchObject({ PK: `ADDR#${CLOCK}#${HASH_A}`, entity: "AddressClaim", personId: "inst-rogelio" });
    expect(await world.connector.people.getAddressClaim(CLOCK, HASH_A)).toMatchObject({ personId: "inst-rogelio" });
  });

  it("refuses a phone already used in the same world and writes nothing; another world may reuse it", async () => {
    await world.connector.people.createPerson(installer());
    await expect(world.connector.people.createPerson(installer({ personId: "inst-karina", firstName: "Karina", lastName: "Olvera" }))).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await world.connector.people.getPerson("inst-karina")).toBeUndefined();
    const qa = installer({ personId: "inst-qa-812-1-sc-02-a", ispId: QA_ISP, clockId: QA_CLOCK });
    await world.connector.people.createPerson(qa);
    expect((await world.connector.people.findByPhone(QA_CLOCK, HASH_A))?.personId).toBe("inst-qa-812-1-sc-02-a");
    expect((await world.connector.people.findByPhone(CLOCK, HASH_A))?.personId).toBe("inst-rogelio");
  });

  it("finds a person only by the phone of its own world, and never guesses between two", async () => {
    await world.connector.people.createPerson(installer());
    expect(await world.connector.people.findByPhone("GUEST#isp-guest-07", HASH_A)).toBeUndefined();
    // The index does not enforce uniqueness: a second row with the same identity key (a bug, a bad import).
    const row = await world.client.get("People", { PK: "PERSON#inst-rogelio", SK: "META" });
    if (row === undefined) throw new Error("fixture missing");
    await world.client.put("People", { ...row, PK: "PERSON#inst-rogue", personId: "inst-rogue" });
    await expect(world.connector.people.findByPhone(CLOCK, HASH_A)).rejects.toBeInstanceOf(AmbiguousIdentityError);
  });

  it("moves the phone claim when the phone changes and releases it when removed", async () => {
    await world.connector.people.createPerson(installer());
    const moved = await world.connector.people.updatePerson("inst-rogelio", { contact: { phone: "+525501010009", phoneHash: HASH_B } });
    expect(moved).toMatchObject({ phoneHash: HASH_B, phone: "+525501010009", version: 2 });
    expect(await world.connector.people.getAddressClaim(CLOCK, HASH_A)).toBeUndefined();
    expect(await world.connector.people.getAddressClaim(CLOCK, HASH_B)).toMatchObject({ personId: "inst-rogelio" });
    expect((await world.connector.people.findByPhone(CLOCK, HASH_B))?.personId).toBe("inst-rogelio");
    const cleared = await world.connector.people.updatePerson("inst-rogelio", { contact: null });
    expect(cleared.phoneHash).toBeUndefined();
    expect(await world.connector.people.getAddressClaim(CLOCK, HASH_B)).toBeUndefined();
    expect(await world.connector.people.findByPhone(CLOCK, HASH_B)).toBeUndefined();
    expect(world.client.dump("People").find((row) => row.SK === "META")?.phoneKey).toBeUndefined();
  });

  it("refuses to move a phone onto one taken in the world, and a stale version", async () => {
    await world.connector.people.createPerson(installer());
    await world.connector.people.createPerson(supervisor("sup-hector", HASH_C));
    await expect(world.connector.people.updatePerson("inst-rogelio", { contact: { phone: "+525501020001", phoneHash: HASH_C } })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await world.connector.people.requirePerson("inst-rogelio")).phoneHash).toBe(HASH_A);
    await expect(world.connector.people.updatePerson("inst-rogelio", { firstName: "Roge" }, { expectedVersion: 9 })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await world.connector.people.updatePerson("inst-rogelio", { firstName: "Roge", email: null })).firstName).toBe("Roge");
  });

  it("requires phone and hash together", async () => {
    await expect(world.connector.people.createPerson(installer({ phoneHash: undefined }))).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("lists the operator's people of a role by name, keeps the allow-list history and records inbound messages", async () => {
    await world.connector.people.createPerson(installer({ personId: "inst-karina", firstName: "Karina", lastName: "Olvera", phoneHash: HASH_B }));
    await world.connector.people.createPerson(installer());
    await world.connector.people.createPerson(supervisor("sup-adriana", HASH_C));
    expect((await world.connector.people.listPeople(ISP, "INSTALLER")).map((person) => person.personId)).toEqual(["inst-rogelio", "inst-karina"]);
    const inactive = await world.connector.people.setActive("inst-karina", false, change);
    expect(inactive.history).toEqual([expect.objectContaining({ field: "active", from: "true", to: "false", actor: "USER:usr-adriana", atSim: change.atSim, reason: "baja" })]);
    const touched = await world.connector.people.recordInbound("inst-rogelio", { atSim: "2026-10-13T09:20:00-06:00" });
    expect(touched.lastInboundAtSim).toBe("2026-10-13T09:20:00-06:00");
    await expect(world.connector.people.recordInbound("inst-nobody", { atSim: change.atSim })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("grants and revokes the WhatsApp opt-in with a dated history", async () => {
    const granted = await world.connector.people.grantConsent({ personId: "inst-rogelio", clockId: CLOCK, medium: "WHATSAPP_KEYWORD", textVersion: "v1" }, { actor: "PERSON:inst-rogelio", atSim: "2026-10-01T09:00:00-06:00" });
    expect(granted).toMatchObject({ status: "GRANTED", grantedAtSim: "2026-10-01T09:00:00-06:00", kind: "WHATSAPP_OPT_IN" });
    const revoked = await world.connector.people.revokeConsent("inst-rogelio", { actor: "PERSON:inst-rogelio", atSim: "2026-10-09T09:00:00-06:00" });
    expect(revoked).toMatchObject({ status: "REVOKED", revokedAtSim: "2026-10-09T09:00:00-06:00" });
    const again = await world.connector.people.grantConsent({ personId: "inst-rogelio", clockId: CLOCK, medium: "CONSOLE", textVersion: "v1" }, { actor: "USER:usr-adriana", atSim: "2026-10-13T08:00:00-06:00" });
    expect(again.revokedAtSim).toBeUndefined();
    expect(again.history.map((entry) => `${entry.from ?? ""}>${entry.to}`)).toEqual([">GRANTED", "GRANTED>REVOKED", "REVOKED>GRANTED"]);
    await expect(world.connector.people.revokeConsent("inst-nobody", change)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("measures the installer profile, keeps shift windows and customers", async () => {
    await world.connector.people.recordProfileEvent("inst-karina", CLOCK, { kind: "REJECT", code: "GLARE", atSim: "2026-10-12T10:00:00-06:00" });
    const profile = await world.connector.people.recordProfileEvent("inst-karina", CLOCK, { kind: "REJECT", code: "GLARE", atSim: "2026-10-12T11:00:00-06:00" });
    expect(profile.rejects).toEqual({ GLARE: 2 });
    expect(profile.events).toHaveLength(2);
    const window = await world.connector.people.openShiftWindow({ personId: "sup-hector", clockId: CLOCK, openedAtSim: "2026-10-13T07:05:00-06:00", closesAtSim: "2026-10-14T07:05:00-06:00" });
    expect((await world.connector.people.getShiftWindow("sup-hector"))?.closesAtSim).toBe(window.closesAtSim);
    await world.connector.people.putCustomer({ customerId: "cust-10421", ispId: ISP, clockId: CLOCK, firstName: "Lucía", lastName: "Treviño", addressLine: "Calle Jacaranda 214", neighborhood: "Las Lomitas", email: "success+c10421@simulator.amazonses.com" });
    expect((await world.connector.people.listCustomers(ISP)).map((customer) => customer.customerId)).toEqual(["cust-10421"]);
  });
});

describe("people repository over DynamoDB", () => {
  const docMock = mockClient(DynamoDBDocumentClient);

  beforeEach(() => docMock.reset());

  it("creates the person and its claim in one conditional transaction", async () => {
    docMock.on(TransactWriteCommand).resolves({});
    const client = new DynamoTableClient(DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" })), { resolveName: (table) => `poc-${table}` });
    const connector = createConnector(createRepoContext(client, { now: () => new Date("2026-10-13T13:00:00.000Z") }));
    await connector.people.createPerson(installer());
    const items = docMock.commandCalls(TransactWriteCommand)[0]?.args[0].input.TransactItems ?? [];
    expect(items).toHaveLength(2);
    expect(items[0]?.Put).toMatchObject({ TableName: "poc-People", ConditionExpression: "attribute_not_exists(#n0)", Item: { PK: "PERSON#inst-rogelio", SK: "META", phoneKey: `${CLOCK}#${HASH_A}` } });
    expect(items[1]?.Put).toMatchObject({ Item: { PK: `ADDR#${CLOCK}#${HASH_A}`, SK: "CLAIM", personId: "inst-rogelio" }, ConditionExpression: "attribute_not_exists(#n0)" });
  });
});
