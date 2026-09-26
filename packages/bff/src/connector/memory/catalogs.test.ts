import { beforeEach, describe, expect, it } from "vitest";
import { createUserDirectory } from "../../auth/staff";
import { CLOCK, ISP, QA_CLOCK, QA_ISP, testConnector } from "../testing";

const settings = {
  ispId: ISP,
  clockId: CLOCK,
  quietHours: { start: "21:00", end: "07:00" },
  caseTimeoutSec: 600,
  demoMode: true,
  demoCaseTimeoutSec: 60,
  whatsappMode: "simulated" as const,
  turnCaps: { perHour: 200, perDay: 1000 },
  simulatorCaps: { turnsPerHour: 60, turnsPerDay: 300, validationsPerDay: 100, transcribeSecPerDay: 1800, emailsPerDay: 20, messagesPerRealHourPerIdentity: 20 },
  templateStatus: { caso_escalado: "APPROVED" as const },
};

describe("operators over the memory connector", () => {
  let world: ReturnType<typeof testConnector>;

  beforeEach(async () => {
    world = testConnector();
    await world.connector.isps.putIsp({ ispId: ISP, kind: "DEMO", clockId: CLOCK, opsMailbox: "success+ops-demo@simulator.amazonses.com" });
    await world.connector.isps.putSettings(settings);
  });

  it("keeps the operator, stamps its brand name at runtime and records template state changes", async () => {
    expect((await world.connector.isps.setDisplayName(ISP, "Operadora de prueba")).displayName).toBe("Operadora de prueba");
    expect((await world.connector.isps.setDisplayName(ISP, null)).displayName).toBeUndefined();
    const plan = await world.connector.isps.setTemplateStatus(ISP, "caso_escalado", "PENDING", { actor: "USER:usr-guest-07", atSim: "2026-10-13T11:00:00-06:00" });
    expect(plan.templateStatus).toEqual({ caso_escalado: "PENDING" });
    expect(plan.history).toEqual([expect.objectContaining({ field: "templateStatus.caso_escalado", from: "APPROVED", to: "PENDING" })]);
    const updated = await world.connector.isps.updateSettings(ISP, { demoMode: false });
    expect(updated).toMatchObject({ demoMode: false, timezone: "America/Mexico_City" });
    await expect(world.connector.isps.updateSettings(ISP, { demoMode: true }, { expectedVersion: 1 })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("keeps zones, crews and rosters with the history of supervisor changes", async () => {
    await world.connector.isps.putZone({ ispId: ISP, clockId: CLOCK, zoneId: "zone-norte", name: "Zona Norte", opticalClass: "B+", acceptanceRange: { minDbm: -25, maxDbm: -8 }, zoneChiefId: "zc-marisol" });
    await world.connector.isps.putCrew({ ispId: ISP, clockId: CLOCK, crewId: "crew-n3", zoneId: "zone-norte", name: "Equipo Norte 3" });
    const roster = { ispId: ISP, clockId: CLOCK, crewId: "crew-n3", date: "2026-10-13", primaryId: "sup-adriana", secondaryId: "sup-hector", startsAtSim: "2026-10-13T07:00:00-06:00", endsAtSim: "2026-10-13T19:00:00-06:00" };
    await world.connector.isps.setRoster(roster, { actor: "SEED" });
    const swapped = await world.connector.isps.setRoster({ ...roster, primaryId: "sup-hector", secondaryId: "sup-adriana" }, { actor: "USER:usr-adriana", atSim: "2026-10-13T08:00:00-06:00" });
    expect(swapped.history.map((entry) => `${entry.from ?? ""}>${entry.to}`)).toEqual([">sup-adriana/sup-hector", "sup-adriana/sup-hector>sup-hector/sup-adriana"]);
    expect((await world.connector.isps.listZones(ISP))[0]?.acceptanceRange).toEqual({ minDbm: -25, maxDbm: -8 });
    expect((await world.connector.isps.listCrews(ISP)).map((crew) => crew.crewId)).toEqual(["crew-n3"]);
    expect(await world.connector.isps.listRosters(ISP, "crew-n3")).toHaveLength(1);
    expect(await world.connector.isps.getRoster(ISP, "crew-n3", "2026-10-14")).toBeUndefined();
  });

  it("finds a console user by Cognito sub only within its own operator and keeps the sub across reloads", async () => {
    await world.connector.isps.putUser({ ispId: ISP, userId: "usr-adriana", role: "SUPERVISOR", name: "Adriana Solís" });
    expect(await world.connector.isps.findUserBySub("")).toBeUndefined();
    await world.connector.isps.setCognitoSub(ISP, "usr-adriana", "sub-1");
    await world.connector.isps.putUser({ ispId: ISP, userId: "usr-adriana", role: "SUPERVISOR", name: "Adriana Solís", cognitoSub: "" });
    expect((await world.connector.isps.getUser(ISP, "usr-adriana"))?.cognitoSub).toBe("sub-1");
    expect(await world.connector.isps.findBySub(ISP, "sub-1")).toEqual({ userId: "usr-adriana", active: true });
    expect(await world.connector.isps.findBySub("isp-guest-07", "sub-1")).toBeUndefined();
    await world.connector.isps.setUserActive(ISP, "usr-adriana", false);
    const directory = createUserDirectory(world.connector.isps, world.now);
    expect(await directory.find(ISP, "sub-1")).toEqual({ userId: "usr-adriana", active: false });
    await world.connector.isps.putUser({ ispId: "isp-guest-07", userId: "usr-guest-07", role: "GUEST", name: "Invitado 07", cognitoSub: "sub-1" });
    expect(await world.connector.isps.findUserBySub("sub-1")).toBeUndefined();
    expect((await world.connector.isps.listUsers(ISP)).map((user) => user.userId)).toEqual(["usr-adriana"]);
  });
});

describe("reference catalogs and metrics over the memory connector", () => {
  it("reads versioned catalogs by their natural keys", async () => {
    const world = testConnector();
    const { reference } = world.connector;
    await reference.put("Template", { name: "caso_escalado", language: "es_MX", category: "UTILITY", body: "Tienes un caso nuevo de tu equipo: {{1}}.", buttons: ["Tomar caso", "No puedo"], status: "LOCAL_ONLY", examples: ["C-0412"] });
    await reference.put("KbThreshold", { thresholdVersion: "v001", value: 0.35, provisional: true });
    await reference.put("ManualIndex", { manualVersion: "v001", sectionId: "COM-04", title: "Cable dentro del domicilio", category: "COM" });
    await reference.put("Rubric", { rubricVersion: "v001", item: "ONU_LABEL_PHOTO", mustShow: ["serial completo legible"], criteria: { glare: "sin reflejo" } });
    await reference.put("EvalQuestion", { questionId: "q-A-14", type: "A", text: "¿Se cobra la roseta en otro cuarto?", expectedSections: ["COM-04"], acceptedOutcomes: ["ANSWERED_WITH_CITATION"] });
    await reference.put("EvalPhoto", { photoId: "ph-label-06", expectedVerdict: "REJECT", expectedReason: "GLARE" });
    await reference.put("RejectReasonCopy", { reason: "GLARE", locale: "es-MX", text: "Hay reflejo sobre la etiqueta: inclina el teléfono." });
    await reference.put("RateCard", { key: "ses:outbound", price: null, unit: "email", provisional: true });
    await reference.put("NameCheck", { term: "ONU-G1", kind: "MODEL", checkedAt: "2026-09-25", result: "CLEAR" });
    await reference.put("SafetyLexicon", { lexiconVersion: "v001", entryKey: "ELECTRICAL-01", phrases: ["cable pelado"] });
    expect((await reference.getTemplate("caso_escalado"))?.buttons).toEqual(["Tomar caso", "No puedo"]);
    expect((await reference.getKbThreshold("v001"))?.value).toBe(0.35);
    expect((await reference.listManualIndex("v001")).map((section) => section.sectionId)).toEqual(["COM-04"]);
    expect(await reference.getRubric("v001", "ONU_LABEL_PHOTO")).toMatchObject({ criteria: { glare: "sin reflejo" } });
    expect((await reference.listEvalQuestions())[0]?.questionId).toBe("q-A-14");
    expect((await reference.listEvalPhotos())[0]?.expectedReason).toBe("GLARE");
    expect((await reference.getRejectReasonCopy("GLARE"))?.text).toContain("reflejo");
    expect(await reference.listRateCard()).toHaveLength(1);
    expect(await reference.listNameChecks()).toHaveLength(1);
    expect(await reference.listSafetyLexicon("v001")).toHaveLength(1);
    expect(await reference.listTemplates()).toHaveLength(1);
    expect(world.client.dump("Reference").every((row) => row.expiresAt === undefined)).toBe(true);
  });

  it("adds up a conversation's KPIs with bounded latency samples, apart from evaluation results", async () => {
    const world = testConnector();
    const ref = { ispId: ISP, source: "WORLD" as const, clockId: CLOCK, workOrderId: "wo-24817", agentMode: "SCRIPTED" as const };
    await world.connector.metrics.addToKpi(ref, { counters: { turns: 1, inputTokens: 1200, outputTokens: 300 }, firstReplyLatencyMs: 8_400.4, turnLatencyMs: 8_000 });
    const kpi = await world.connector.metrics.addToKpi(ref, { counters: { turns: 1 }, turnLatencyMs: 6_000, costUsd: 0.02 });
    expect(kpi).toMatchObject({ turns: 2, inputTokens: 1200, firstReplyLatenciesMs: [8400], turnLatenciesMs: [8000, 6000], costUsd: 0.02, agentMode: "SCRIPTED" });
    await world.connector.metrics.putEvalResult({ ispId: QA_ISP, runId: "812-1", kind: "P", itemId: "ph-label-06", clockId: QA_CLOCK, outcome: "REJECT/GLARE", passed: true });
    await world.connector.metrics.addToKpi({ ...ref, ispId: QA_ISP, source: "EVAL", clockId: QA_CLOCK, workOrderId: "wo-80001" }, { counters: { validations: 1 } });
    expect(await world.connector.metrics.listKpis(ISP)).toHaveLength(1);
    expect((await world.connector.metrics.listKpis(QA_ISP, "EVAL")).map((listed) => listed.workOrderId)).toEqual(["wo-80001"]);
    expect((await world.connector.metrics.listEvalResults(QA_ISP, "812-1", "P")).map((result) => result.itemId)).toEqual(["ph-label-06"]);
    expect(await world.connector.metrics.listEvalResults(QA_ISP, "812-1", "Q")).toEqual([]);
  });
});
