import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { CASE_1, CASE_2, ISP, openCase, testConnector } from "../testing";
import { DynamoTableClient } from "./client";
import { createConnector } from "./connector";
import { createRepoContext, entityRow } from "./repo";
import { Case } from "../../domain/cases";

const hector = { actor: "PERSON:sup-hector", atSim: "2026-10-13T12:02:00-06:00" } as const;
const adriana = { actor: "PERSON:sup-adriana", atSim: "2026-10-13T12:02:00-06:00" } as const;
const timeout = { rung: "PRIMARY" as const, outcome: "TIMED_OUT" as const, atSim: "2026-10-13T12:00:00-06:00" };

describe("cases repository", () => {
  let world: ReturnType<typeof testConnector>;

  beforeEach(async () => {
    world = testConnector();
    await world.connector.cases.createCase(openCase());
  });

  it("stores the order, inbox and creation keys; no taken key while OPEN", async () => {
    const row = world.client.dump("Cases")[0];
    expect(row).toMatchObject({ PK: `CASE#${CASE_1}`, SK: "META", workOrderKey: "WO#wo-24818", ispStatusKey: `ISP#${ISP}#OPEN`, createdAtSim: "2026-10-13T17:50:00.000Z" });
    expect(row?.takenByKey).toBeUndefined();
    await world.connector.cases.createCase(openCase({ caseId: CASE_2, reason: "INSTALLER_ASKED", createdAtSim: "2026-10-13T12:10:00-06:00" }));
    expect((await world.connector.cases.listCasesOfWorkOrder("wo-24818")).map((item) => item.caseId)).toEqual([CASE_1, CASE_2]);
    expect(await world.connector.cases.listCasesByStatus(ISP, "OPEN")).toHaveLength(2);
    await expect(world.connector.cases.createCase(openCase())).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("lets only the first supervisor take an OPEN case and routes by the taken index", async () => {
    const taken = await world.connector.cases.takeCase(CASE_1, "sup-hector", hector);
    expect(taken).toMatchObject({ status: "TAKEN", takenBy: "sup-hector", takenAtSim: hector.atSim, bridge: { open: true, pendingRelays: [] } });
    expect(taken.ladder.at(-1)).toMatchObject({ rung: "PRIMARY", outcome: "TAKEN", personId: "sup-hector" });
    expect(taken.history).toEqual([expect.objectContaining({ field: "status", from: "OPEN", to: "TAKEN", actor: "PERSON:sup-hector" })]);
    await expect(world.connector.cases.takeCase(CASE_1, "sup-adriana", adriana)).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await world.connector.cases.listTakenBy("sup-hector")).map((item) => item.caseId)).toEqual([CASE_1]);
    expect(await world.connector.cases.listTakenBy("sup-adriana")).toEqual([]);
    expect(await world.connector.cases.listCasesByStatus(ISP, "OPEN")).toEqual([]);
    expect(await world.connector.cases.listCasesByStatus(ISP, "TAKEN")).toHaveLength(1);
  });

  it("resolves a race between two takes with exactly one winner", async () => {
    const results = await Promise.allSettled([world.connector.cases.takeCase(CASE_1, "sup-hector", hector), world.connector.cases.takeCase(CASE_1, "sup-adriana", adriana)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("moves up the ladder only with the rungVersion it was armed with", async () => {
    const moved = await world.connector.cases.advanceLadder(CASE_1, timeout, { rungVersion: 0 }, { rung: "SECONDARY" });
    expect(moved).toMatchObject({ rung: "SECONDARY", rungVersion: 1, ladder: [timeout] });
    expect(moved.history).toEqual([expect.objectContaining({ field: "rung", from: "PRIMARY", to: "SECONDARY", reason: "TIMED_OUT" })]);
    await expect(world.connector.cases.advanceLadder(CASE_1, timeout, { rungVersion: 0 }, { rung: "ZONE_CHIEF" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(world.connector.cases.takeCase(CASE_1, "sup-adriana", adriana, { rungVersion: 0 })).rejects.toMatchObject({ code: "CONFLICT" });
    const noted = await world.connector.cases.advanceLadder(CASE_1, { rung: "SECONDARY", outcome: "NOTIFIED", personId: "sup-hector", channel: "TEMPLATE", atSim: timeout.atSim }, { rungVersion: 1 });
    expect(noted).toMatchObject({ rung: "SECONDARY", rungVersion: 1 });
    expect((await world.connector.cases.takeCase(CASE_1, "sup-hector", hector, { rungVersion: 1 })).status).toBe("TAKEN");
  });

  it("closes a case, closes the bridge and leaves the taken index", async () => {
    await world.connector.cases.takeCase(CASE_1, "sup-hector", hector);
    const closed = await world.connector.cases.closeCase(CASE_1, { closeSummary: "Se cambió el conector de la roseta." }, { actor: "PERSON:sup-hector", atSim: "2026-10-13T12:20:00-06:00" });
    expect(closed).toMatchObject({ status: "CLOSED", closedBy: "PERSON:sup-hector", closedAtSim: "2026-10-13T12:20:00-06:00", bridge: { open: false } });
    expect(await world.connector.cases.listTakenBy("sup-hector")).toEqual([]);
    expect(world.client.dump("Cases")[0]?.takenByKey).toBeUndefined();
    expect(world.client.dump("Cases")[0]?.ispStatusKey).toBe(`ISP#${ISP}#CLOSED`);
    await expect(world.connector.cases.closeCase(CASE_1, {}, { actor: "USER:usr-adriana", atSim: "2026-10-13T12:21:00-06:00" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("updates under an explicit version or status guard and records status and rung changes", async () => {
    await expect(world.connector.cases.updateCase(CASE_1, { summary: "otro" }, { expectedVersion: 7 })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(world.connector.cases.updateCase(CASE_1, { summary: "otro" }, { status: ["TAKEN"] })).rejects.toMatchObject({ code: "CONFLICT" });
    const bridged = await world.connector.cases.updateCase(CASE_1, { bridge: { open: false, pendingRelays: [{ messageId: "msg-1", from: "SUPERVISOR", atSim: hector.atSim }] } }, { status: ["OPEN"] });
    expect(bridged.bridge.pendingRelays).toHaveLength(1);
    const escalated = await world.connector.cases.updateCase(CASE_1, { rung: "ZONE_CHIEF" }, {}, { actor: "SYSTEM", atSim: timeout.atSim });
    expect(escalated).toMatchObject({ rung: "ZONE_CHIEF", rungVersion: 1, history: [expect.objectContaining({ field: "rung", to: "ZONE_CHIEF" })] });
    await expect(world.connector.cases.requireCase(CASE_2)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("cases repository over DynamoDB", () => {
  const docMock = mockClient(DynamoDBDocumentClient);

  beforeEach(() => docMock.reset());

  it("takes a case with one conditional update on version and status that sets the taken key", async () => {
    const ctx = createRepoContext(new DynamoTableClient(DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" })), { resolveName: (table) => `poc-${table}` }), {
      now: () => new Date("2026-10-13T18:00:00.000Z"),
    });
    const stored = entityRow(ctx, Case, "Case", openCase()).item;
    docMock.on(GetCommand).resolves({ Item: stored });
    docMock.on(UpdateCommand).resolves({ Attributes: { ...stored, status: "TAKEN", takenBy: "sup-hector", version: 2 } });
    await createConnector(ctx).cases.takeCase(CASE_1, "sup-hector", hector);
    const input = docMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    const names = Object.entries(input?.ExpressionAttributeNames ?? {});
    const placeholder = (attribute: string) => names.find(([, name]) => name === attribute)?.[0];
    expect(input?.TableName).toBe("poc-Cases");
    expect(input?.ConditionExpression).toContain(`attribute_exists(${placeholder("PK")})`);
    expect(input?.ConditionExpression).toContain(`${placeholder("version")} = `);
    expect(input?.ConditionExpression).toContain(`${placeholder("status")} IN (`);
    expect(input?.UpdateExpression).toContain(`${placeholder("takenByKey")} = `);
    expect(Object.values(input?.ExpressionAttributeValues ?? {})).toEqual(expect.arrayContaining(["SUP#sup-hector#TAKEN", `ISP#${ISP}#TAKEN`, 1, "OPEN"]));
  });
});
