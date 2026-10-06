import { beforeEach, describe, expect, it } from "vitest";
import { openCase } from "../connector/testing";
import { CLOCK, ISP, ROGELIO, TURN_AT_SIM, WO, type WorkerKit, inboundEvent, inboundMessage, seedWorld, workerKit } from "./testing";

let kit: WorkerKit;

beforeEach(async () => {
  kit = workerKit();
  await seedWorld(kit);
});

const base = { clockId: CLOCK, ispId: ISP, installerId: ROGELIO };
const ref = { personId: ROGELIO, sentAtSim: TURN_AT_SIM, messageId: "wamid.SIM.TAP" };
const actions = async () => (await kit.connector.audit.listByMonth(ISP, "2026-10")).map((decision) => decision.action);
const VOICE = { content: "VOICE", text: undefined, media: { kind: "AUDIO", s3Key: "sim/abc-e3/up-1", mime: "audio/ogg", durationSec: 9 } } as const;

describe("worker: INBOUND_MESSAGE", () => {
  it("[FL-058] with the order's case TAKEN, the installer's message goes over the bridge to the supervisor: no turn", async () => {
    await kit.connector.cases.createCase(openCase({ workOrderId: WO, status: "TAKEN", takenBy: "sup-hector", takenAtSim: TURN_AT_SIM }));
    const message = await inboundMessage(kit, { text: "Ya cambié el conector, ¿ahora qué?" });
    await kit.run(inboundEvent(message));
    expect(kit.rec.relays).toMatchObject([{ workOrderId: WO, caseId: "case-01J9ZQX0000000000000000000", message: { messageId: message.messageId } }]);
    expect(kit.rec.harness).toEqual([]);
    expect(kit.rec.g1).toEqual([]);
    expect(await kit.connector.conversations.listTurnNotes(ROGELIO)).toEqual([]);
  });

  it("[FL-058] a photo with the case TAKEN is relayed as an image and never validated nor shown to the agent", async () => {
    await kit.connector.cases.createCase(openCase({ workOrderId: WO, status: "TAKEN", takenBy: "sup-hector", takenAtSim: TURN_AT_SIM }));
    const message = await inboundMessage(kit, { content: "IMAGE", text: undefined, media: { kind: "IMAGE", s3Key: "sim/abc-e3/up-9", mime: "image/jpeg", bytes: 412_331 } });
    await kit.run(inboundEvent(message));
    expect(kit.rec.relays[0]?.message.media?.kind).toBe("IMAGE");
    expect(kit.rec.harness).toEqual([]);
  });

  it("tells the simulated orchestrator the installer acted when the order has a PENDING step, once per event, then the turn", async () => {
    await kit.connector.workOrders.appendStep({ workOrderId: WO, clockId: CLOCK, symptom: "NO_PON_LIGHT", stepRef: "DIAG-02-a", outcome: "PENDING", recordedAtSim: TURN_AT_SIM });
    const message = await inboundMessage(kit, { text: "Ya limpié el conector, ya prende" });
    await kit.run(inboundEvent(message));
    expect(kit.rec.physical).toEqual(["DEMO3F2C19A0:INSTALLER_STEP"]);
    expect(await actions()).toContain("PHYSICAL_ACTION_REPORTED");
    expect(kit.rec.harness).toHaveLength(1);
  });

  it("runs the safety classifier before G1 and the agent; a match sends the fixed instruction through the safety handler and the turn goes on", async () => {
    const message = await inboundMessage(kit, { text: "Hay un cable pelado en el poste, está chispeando" });
    await kit.run(inboundEvent(message));
    expect(kit.rec.safety).toMatchObject([{ category: "ELECTRICAL", lexiconVersion: "v001", workOrderId: WO, messageId: message.messageId }]);
    expect(kit.rec.harness).toHaveLength(1);
  });

  it("transcribes a voice note inside the message and gives the turn its transcript with the confidence", async () => {
    const message = await inboundMessage(kit, VOICE);
    await kit.run(inboundEvent(message));
    expect(kit.rec.transcriptions).toEqual([message.messageId]);
    expect(kit.rec.harness[0]?.envelope).toMatch(/kind="VOICE_TRANSCRIPT" confidence="0\.93" truncated="false">Ya estoy con la clienta, la ONU no prende la luz PON<\//);
  });

  it("answers a voice note it could not use with its fixed notice and no turn", async () => {
    const cases = [
      [{ status: "LOW_CONFIDENCE", confidence: 0.4 }, "voiceUnclear"],
      [{ status: "TOO_LONG" }, "voiceTooLong"],
    ] as const;
    for (const [index, [outcome, notice]] of cases.entries()) {
      kit.transcription = outcome;
      const message = await inboundMessage(kit, { ...VOICE, messageId: `wamid.SIM.V${index}` });
      await kit.run(inboundEvent(message, `wa-in-v${index}`));
      expect(kit.rec.notices.at(-1)?.notice).toBe(notice);
    }
    expect(kit.rec.harness).toEqual([]);
  });

  it("[FL-099] a Transcribe failure answers 'no pude procesar el audio' and leaves the world quiet", async () => {
    kit.transcription = { status: "FAILED" };
    const message = await inboundMessage(kit, VOICE);
    await kit.connector.worlds.markInFlight(ROGELIO, CLOCK, "wa-in-0000000000000000000000000000000000000001");
    await kit.run(inboundEvent(message));
    expect(kit.rec.notices.map((notice) => notice.notice)).toEqual(["voiceFailed"]);
    expect((await kit.connector.worlds.getWorldState(CLOCK))?.inFlight).toEqual([]);
  });

  it("declares a photo by its candidate id only: the image never reaches the Harness", async () => {
    const message = await inboundMessage(kit, { content: "IMAGE", text: "la roseta", media: { kind: "IMAGE", s3Key: "sim/abc-e3/up-2", mime: "image/jpeg", bytes: 512_000 } });
    await kit.run(inboundEvent(message));
    const envelope = kit.rec.harness[0]?.envelope ?? "";
    expect(envelope).toContain(`<attachment kind="IMAGE" candidateId="${message.messageId}" bytes="512000"/>`);
    expect(envelope).toMatch(/kind="IMAGE_CAPTION" truncated="false">la roseta</);
    expect(envelope).not.toContain("s3Key");
  });

  it("acknowledges an event whose message is gone (a reset world) without a turn", async () => {
    await kit.run(inboundEvent({ messageId: "wamid.SIM.GONE", sentAtSim: TURN_AT_SIM }));
    expect(kit.rec.harness).toEqual([]);
  });
});

describe("worker: dispatch by type", () => {
  it("runs a BUTTON_ACTION through the channel's deterministic handlers, without a turn", async () => {
    await kit.run({ type: "BUTTON_ACTION", eventId: "evt-b1", ...base, action: "CUSTOMER_OK", workOrderId: WO, message: ref });
    expect(kit.rec.handled).toEqual(["CUSTOMER_OK"]);
    expect(kit.rec.harness).toEqual([]);
  });

  it("hands SUPERVISOR_ACTION, DISPATCH_EVENT, EMAIL_EVENT and OUTBOUND_SEND to their modules", async () => {
    await kit.run({ type: "SUPERVISOR_ACTION", eventId: "evt-s1", ...base, action: "TAKE_CASE", supervisorId: "sup-hector", caseId: "case-01J9ZQX0000000000000000000", message: ref });
    await kit.run({ type: "DISPATCH_EVENT", eventId: "evt-d1", ...base, workOrderId: WO, change: "RESCHEDULED", occurredAtSim: TURN_AT_SIM });
    const record = { type: "DELIVERY", providerMessageId: "ses-1", atReal: "2026-10-13T15:21:00.000Z", ispId: ISP, clockId: CLOCK, mailId: "mail-1", kind: "ZONE_CHIEF_ALERT" };
    await kit.run({ type: "EMAIL_EVENT", eventId: "evt-e1", ...base, record });
    await kit.run({ type: "OUTBOUND_SEND", eventId: "evt-o1", ...base, author: "USER:usr-sup-adriana", request: { kind: "SYSTEM_NOTICE" } });
    expect(kit.rec.handled).toEqual(["SUPERVISOR_ACTION", "DISPATCH_EVENT", "EMAIL_EVENT", "OUTBOUND_SEND"]);
  });

  it("fires a TIMER through the timer port and dispatches its kind; a timer not yet due dispatches nothing; an old version is audited", async () => {
    const timer = { type: "TIMER", ...base, dueAtSim: "2026-10-13T07:30:00-06:00", version: 1, firedBy: "CLOCK" };
    await kit.run({ ...timer, eventId: "evt-t1", timerKey: "WORK_ORDER|wo-24817|DAY_START|ds-1" });
    expect(kit.rec.fired).toMatchObject([{ eventAtSim: TURN_AT_SIM, timer: { kind: "DAY_START" } }]);
    await kit.run({ ...timer, eventId: "evt-t2", timerKey: "WORK_ORDER|wo-24817|DAY_START|LATER" });
    await kit.run({ ...timer, eventId: "evt-t3", timerKey: "WORK_ORDER|wo-24817|DAY_START|STALE" });
    expect(kit.rec.fired).toHaveLength(1);
    expect(await actions()).toContain("TIMER_STALE");
  });

  it("probes the mocks with the worker's role into PROBE#", async () => {
    await kit.run({ type: "HEALTH_PROBE", eventId: `qa-${"a".repeat(40)}`, probeId: "smk-3-run-1" });
    expect(await kit.connector.worlds.getProbe("smk-3-run-1")).toMatchObject({ detail: { mocks: { network: "OK" } } });
  });

  it("[FL-099] a poison event fails every attempt; on the last one it leaves inFlight with processError and EVENT_DEAD_LETTERED", async () => {
    const poison = { type: "POISON", eventId: `qa-${"b".repeat(40)}`, clockId: "qa-812-1-sc-14", ispId: "isp-qa-812-1-sc-14", installerId: "inst-qa-r" };
    await kit.connector.worlds.markInFlight("inst-qa-r", "qa-812-1-sc-14", poison.eventId);
    await expect(kit.run(poison, 1)).rejects.toThrow("poison");
    expect((await kit.connector.worlds.getWorldState("qa-812-1-sc-14"))?.inFlight).toEqual([poison.eventId]);
    await expect(kit.run(poison, 5)).rejects.toThrow("poison");
    expect((await kit.connector.worlds.getWorldState("qa-812-1-sc-14"))?.inFlight).toEqual([]);
    expect((await kit.connector.worlds.getInstallerState("inst-qa-r"))?.processError).toMatchObject({ eventId: poison.eventId });
    expect((await kit.connector.audit.listByMonth("isp-qa-812-1-sc-14", "2026-10")).map((decision) => decision.action)).toEqual(["EVENT_DEAD_LETTERED"]);
  });

  it("refuses a POISON event outside a qa-* world as malformed, and acknowledges it", async () => {
    await kit.run({ type: "POISON", eventId: `qa-${"c".repeat(40)}`, ...base });
    expect(kit.tools.logs.some((line) => line.message === "event.malformed")).toBe(true);
  });
});
