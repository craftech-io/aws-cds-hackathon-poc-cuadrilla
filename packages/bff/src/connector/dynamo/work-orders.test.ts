import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { CLOCK, EV_1, EV_2, ISP, SHA_1, VAL_1, testConnector, workOrder } from "../testing";
import { DynamoTableClient } from "./client";
import { createConnector } from "./connector";
import { createRepoContext } from "./repo";

const agent = { actor: "AGENT", atSim: "2026-10-13T10:40:00-06:00" } as const;

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    evidenceId: EV_1,
    workOrderId: "wo-24817",
    clockId: CLOCK,
    worldEpoch: 1,
    item: "POWER_READING_PHOTO" as const,
    sha256: SHA_1,
    s3Key: "photos/wo-24817/POWER_READING_PHOTO/ev-01J9ZQX0000000000000000000.jpg",
    mime: "image/jpeg" as const,
    bytes: 412_331,
    receivedAtSim: "2026-10-13T10:35:00-06:00",
    ...overrides,
  };
}

describe("work orders repository", () => {
  let world: ReturnType<typeof testConnector>;

  beforeEach(async () => {
    world = testConnector();
    await world.connector.workOrders.createWorkOrder(workOrder());
  });

  it("creates the order and its five checklist items in PENDING, with the day index keys in UTC", async () => {
    const rows = world.client.dump("WorkOrders");
    expect(rows.find((row) => row.SK === "META")).toMatchObject({
      installerDayKey: "INST#inst-rogelio#2026-10-13",
      windowStartSim: "2026-10-13T15:00:00.000Z",
      ispDayKey: `ISP#${ISP}#2026-10-13`,
      status: "SCHEDULED",
    });
    const checklist = await world.connector.workOrders.listChecklist("wo-24817");
    expect(checklist.map((entry) => `${entry.item}:${entry.status}:${entry.attempts}`).sort()).toEqual([
      "CUSTOMER_OK:PENDING:0",
      "ONU_LABEL_PHOTO:PENDING:0",
      "ONU_ONLINE:PENDING:0",
      "POWER_READING_PHOTO:PENDING:0",
      "ROSETTE_PHOTO:PENDING:0",
    ]);
    await expect(world.connector.workOrders.createWorkOrder(workOrder())).rejects.toMatchObject({ code: "CONFLICT" });
    await world.connector.workOrders.createWorkOrder(workOrder({ workOrderId: "wo-24850", workOrderNumber: "24850", date: "2026-10-14" }), { checklist: false });
    expect(await world.connector.workOrders.listChecklist("wo-24850")).toEqual([]);
  });

  it("lists an installer's day by appointment start and an operator's day by status", async () => {
    await world.connector.workOrders.createWorkOrder(workOrder({ workOrderId: "wo-24818", workOrderNumber: "24818", appointmentWindow: { startSim: "2026-10-13T11:30:00-06:00", endSim: "2026-10-13T13:30:00-06:00" } }));
    await world.connector.workOrders.createWorkOrder(workOrder({ workOrderId: "wo-24816", workOrderNumber: "24816", appointmentWindow: { startSim: "2026-10-13T07:30:00-06:00", endSim: "2026-10-13T08:30:00-06:00" }, status: "CLOSED" }));
    expect((await world.connector.workOrders.listInstallerDay("inst-rogelio", "2026-10-13")).map((order) => order.workOrderNumber)).toEqual(["24816", "24817", "24818"]);
    expect((await world.connector.workOrders.listIspDay(ISP, "2026-10-13", "SCHEDULED")).map((order) => order.workOrderNumber).sort()).toEqual(["24817", "24818"]);
    expect(await world.connector.workOrders.listIspDay(ISP, "2026-10-13")).toHaveLength(3);
  });

  it("moves status with history and a guard on the current status", async () => {
    const started = await world.connector.workOrders.setStatus("wo-24817", "IN_PROGRESS", agent, { from: ["SCHEDULED"] });
    expect(started.history).toEqual([expect.objectContaining({ field: "status", from: "SCHEDULED", to: "IN_PROGRESS", actor: "AGENT" })]);
    await expect(world.connector.workOrders.setStatus("wo-24817", "IN_PROGRESS", agent, { from: ["SCHEDULED"] })).rejects.toMatchObject({ code: "CONFLICT" });
    const closed = await world.connector.workOrders.setStatus("wo-24817", "CLOSED", { actor: "AGENT", atSim: "2026-10-13T10:58:00-06:00" });
    expect(closed).toMatchObject({ status: "CLOSED", closedAtSim: "2026-10-13T10:58:00-06:00" });
    expect(await world.connector.workOrders.listIspDay(ISP, "2026-10-13", "CLOSED")).toHaveLength(1);
    await expect(world.connector.workOrders.setStatus("wo-00000", "CLOSED", agent)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("reassigns and reschedules by moving the day index keys", async () => {
    await world.connector.workOrders.updateWorkOrder("wo-24817", { installerId: "inst-karina" });
    expect(await world.connector.workOrders.listInstallerDay("inst-rogelio", "2026-10-13")).toEqual([]);
    expect(await world.connector.workOrders.listInstallerDay("inst-karina", "2026-10-13")).toHaveLength(1);
    await world.connector.workOrders.updateWorkOrder("wo-24817", { date: "2026-10-14", appointmentWindow: { startSim: "2026-10-14T09:00:00-06:00", endSim: "2026-10-14T11:00:00-06:00" } });
    expect(await world.connector.workOrders.listIspDay(ISP, "2026-10-13")).toEqual([]);
    const [moved] = await world.connector.workOrders.listInstallerDay("inst-karina", "2026-10-14");
    expect(moved?.appointmentWindow.startSim).toBe("2026-10-14T09:00:00-06:00");
    expect(world.client.dump("WorkOrders").find((row) => row.SK === "META")?.windowStartSim).toBe("2026-10-14T15:00:00.000Z");
    await expect(world.connector.workOrders.updateWorkOrder("wo-24817", { plan: "Fibra 500" }, { expectedVersion: 1 })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("keeps the last ONU reading, the safety hold and the session epoch", async () => {
    const reading = { operState: "ONLINE" as const, rxPowerDbm: -21.4, inRange: true, observedAtSim: "2026-10-13T09:40:00-06:00", source: "AGENT" as const };
    expect((await world.connector.workOrders.recordOnuReading("wo-24817", reading)).lastOnuReading).toEqual(reading);
    const held = await world.connector.workOrders.setOnHoldSafety("wo-24817", true, { actor: "SYSTEM", atSim: "2026-10-13T15:10:00-06:00" });
    expect(held).toMatchObject({ onHoldSafety: true, history: [expect.objectContaining({ field: "onHoldSafety", to: "true" })] });
    expect((await world.connector.workOrders.bumpSessionEpoch("wo-24817")).sessionEpoch).toBe(1);
  });

  it("moves a checklist item conditionally and counts rejected attempts", async () => {
    const rejected = await world.connector.workOrders.updateChecklistItem("wo-24817", "ONU_LABEL_PHOTO", { status: "REJECTED", addAttempts: 1, lastRejectReason: "GLARE", validationId: VAL_1 }, agent);
    expect(rejected).toMatchObject({ status: "REJECTED", attempts: 1, lastRejectReason: "GLARE", validationId: VAL_1, updatedAtSim: agent.atSim });
    const again = await world.connector.workOrders.updateChecklistItem("wo-24817", "ONU_LABEL_PHOTO", { addAttempts: 1 }, agent);
    expect(again).toMatchObject({ attempts: 2, history: [expect.objectContaining({ from: "PENDING", to: "REJECTED" })] });
    await expect(
      world.connector.workOrders.updateChecklistItem("wo-24817", "ONU_LABEL_PHOTO", { status: "PASSED" }, agent, { expectedStatus: ["PENDING", "IN_REVIEW"] }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const overridden = await world.connector.workOrders.updateChecklistItem(
      "wo-24817",
      "ONU_LABEL_PHOTO",
      { status: "OVERRIDDEN", override: { userId: "usr-adriana", reason: "etiqueta legible en persona", atSim: "2026-10-13T10:50:00-06:00" }, lastRejectReason: null },
      { actor: "USER:usr-adriana", atSim: "2026-10-13T10:50:00-06:00" },
      { expectedStatus: ["REJECTED"] },
    );
    expect(overridden.lastRejectReason).toBeUndefined();
    expect(overridden.override?.userId).toBe("usr-adriana");
  });

  it("finds a repeated photo only within the same world and epoch", async () => {
    await world.connector.workOrders.createEvidence(evidence());
    await world.connector.workOrders.createEvidence(evidence({ evidenceId: EV_2, workOrderId: "wo-24818", clockId: "GUEST#isp-guest-07" }));
    expect((await world.connector.workOrders.findEvidenceByHash(CLOCK, 1, SHA_1)).map((found) => found.evidenceId)).toEqual([EV_1]);
    expect(await world.connector.workOrders.findEvidenceByHash(CLOCK, 2, SHA_1)).toEqual([]);
    expect(await world.connector.workOrders.findEvidenceByHash("GUEST#isp-guest-07", 1, SHA_1)).toHaveLength(1);
    expect((await world.connector.workOrders.listEvidence("wo-24817")).map((found) => found.evidenceId)).toEqual([EV_1]);
    await expect(world.connector.workOrders.createEvidence(evidence())).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("stores validations and filters them by item", async () => {
    await world.connector.workOrders.createValidation({ validationId: VAL_1, workOrderId: "wo-24817", clockId: CLOCK, item: "POWER_READING_PHOTO", verdict: "PASS", readings: { readingDbm: -21.4, wavelengthNm: 1490 }, source: "SCRIPTED", atSim: agent.atSim });
    expect(await world.connector.workOrders.listValidations("wo-24817", "POWER_READING_PHOTO")).toHaveLength(1);
    expect(await world.connector.workOrders.listValidations("wo-24817", "ROSETTE_PHOTO")).toEqual([]);
    expect((await world.connector.workOrders.getValidation("wo-24817", VAL_1))?.readings.readingDbm).toBe(-21.4);
  });

  it("numbers troubleshooting steps in order, also under concurrent appends", async () => {
    const step = { workOrderId: "wo-24817", clockId: CLOCK, symptom: "NO_PON_LIGHT" as const, stepRef: "DIAG-02-a", outcome: "PENDING" as const, recordedAtSim: agent.atSim };
    expect((await world.connector.workOrders.appendStep(step)).seq).toBe(1);
    const seqs = (await Promise.all([world.connector.workOrders.appendStep(step), world.connector.workOrders.appendStep(step)])).map((appended) => appended.seq);
    expect(seqs.sort()).toEqual([2, 3]);
    const fixed = await world.connector.workOrders.updateStepOutcome("wo-24817", 1, "FIXED", agent);
    expect(fixed).toMatchObject({ outcome: "FIXED", history: [expect.objectContaining({ from: "PENDING", to: "FIXED" })] });
    expect((await world.connector.workOrders.listSteps("wo-24817")).map((listed) => listed.seq)).toEqual([1, 2, 3]);
  });

  it("keeps one delivery per recipient and channel, also across a re-render", async () => {
    await world.connector.workOrders.putCertificate({ workOrderId: "wo-24817", clockId: CLOCK, certificateId: "cert-wo-24817-1", n: 1, issuedAtSim: "2026-10-13T10:58:00-06:00", sha256: SHA_1, s3Key: "certificates/wo-24817/acta-1.pdf" });
    await world.connector.workOrders.setDelivery("wo-24817", { to: "CUSTOMER", channel: "EMAIL", status: "QUEUED", mailId: "mail-1" });
    const delivered = await world.connector.workOrders.setDelivery("wo-24817", { to: "CUSTOMER", channel: "EMAIL", status: "DELIVERED", mailId: "mail-1" });
    await world.connector.workOrders.setDelivery("wo-24817", { to: "INSTALLER", channel: "WHATSAPP", status: "SENT" });
    expect(delivered.deliveries).toEqual([expect.objectContaining({ to: "CUSTOMER", status: "DELIVERED" })]);
    const rerendered = await world.connector.workOrders.putCertificate({ workOrderId: "wo-24817", clockId: CLOCK, certificateId: "cert-wo-24817-1", n: 1, issuedAtSim: "2026-10-13T10:58:00-06:00", sha256: "2".repeat(64) });
    expect(rerendered.deliveries.map((delivery) => delivery.to).sort()).toEqual(["CUSTOMER", "INSTALLER"]);
    expect(rerendered.version).toBe(5);
  });
});

describe("work orders repository over DynamoDB", () => {
  const docMock = mockClient(DynamoDBDocumentClient);

  beforeEach(() => docMock.reset());

  it("creates an order with its checklist in one transaction and queries the operator's day by status", async () => {
    docMock.on(TransactWriteCommand).resolves({});
    docMock.on(QueryCommand).resolves({ Items: [] });
    const client = new DynamoTableClient(DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" })), { resolveName: (table) => `poc-${table}` });
    const connector = createConnector(createRepoContext(client, { now: () => new Date("2026-10-13T13:00:00.000Z") }));
    await connector.workOrders.createWorkOrder(workOrder());
    const items = docMock.commandCalls(TransactWriteCommand)[0]?.args[0].input.TransactItems ?? [];
    expect(items.map((item) => item.Put?.Item?.SK)).toEqual(["META", "CHECK#ONU_ONLINE", "CHECK#POWER_READING_PHOTO", "CHECK#ONU_LABEL_PHOTO", "CHECK#ROSETTE_PHOTO", "CHECK#CUSTOMER_OK"]);
    expect(items.every((item) => item.Put?.ConditionExpression === "attribute_not_exists(#n0)")).toBe(true);
    await connector.workOrders.listIspDay(ISP, "2026-10-13", "IN_PROGRESS");
    expect(docMock.commandCalls(QueryCommand)[0]?.args[0].input).toMatchObject({
      TableName: "poc-WorkOrders",
      IndexName: "GSI2",
      ExpressionAttributeNames: { "#n0": "ispDayKey", "#n2": "status" },
      ExpressionAttributeValues: { ":v1": `ISP#${ISP}#2026-10-13`, ":v3": "IN_PROGRESS" },
    });
  });
});
