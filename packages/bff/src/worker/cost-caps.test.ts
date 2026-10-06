import { beforeEach, describe, expect, it } from "vitest";
import { CLOCK, ISP, MSG, TURN_AT_SIM, type WorkerKit, fillCounter, inboundEvent, inboundMessage, metricLines, seedWorld, workerKit } from "./testing";

let kit: WorkerKit;

beforeEach(async () => {
  kit = workerKit();
  await seedWorld(kit);
});

const used = (key: string): unknown => kit.tools.store.items.get(key)?.used;
const GLOBAL_TURNS = "TURNCAP#GLOBAL#2026-10-13";

async function message(n: number, fields: Record<string, unknown> = {}) {
  const stored = await inboundMessage(kit, { messageId: `${MSG}-${n}`, text: `mensaje ${n}`, ...fields });
  await kit.run(inboundEvent(stored, `wa-in-${n.toString().padStart(40, "0")}`));
}

/** A world with its clock and caps, and one turn of an installer in it (no order: the day session). */
async function seedWorldOf(clockId: string, ispId: string, kind: "GUEST" | "QA", extra: Record<string, unknown> = {}) {
  await kit.connector.runtime.createClock({ clockId, ispId, kind, mode: "PAUSED", offsetMs: 0, pausedSimNow: TURN_AT_SIM, worldEpoch: 1 });
  await kit.connector.isps.putSettings({
    ispId,
    clockId,
    quietHours: { start: "21:00", end: "07:00" },
    caseTimeoutSec: 600,
    demoMode: false,
    demoCaseTimeoutSec: 60,
    whatsappMode: "simulated",
    turnCaps: { perHour: 200, perDay: 1_000 },
    simulatorCaps: { turnsPerHour: 60, turnsPerDay: 300, validationsPerDay: 100, transcribeSecPerDay: 1_800, emailsPerDay: 20, messagesPerRealHourPerIdentity: 60 },
    ...extra,
  });
}

const turnIn = (clockId: string, ispId: string, eventId: string) => kit.run({ type: "AGENT_TURN", trigger: "WORK_ORDER_CHANGED", eventId, clockId, ispId, installerId: "inst-world-1", eventAtSim: TURN_AT_SIM });

describe("worker/cost-caps", () => {
  it("[FL-098] reserves the turn in every ledger before InvokeHarness", async () => {
    const seen: unknown[] = [];
    kit.harnessScripts.push(async () => (seen.push(used(GLOBAL_TURNS)), {}));
    await message(1);
    expect(seen).toEqual([1]);
    expect(used(`SIMCAP#${CLOCK}#turns#2026-10-13T15`)).toBe(1);
  });

  it("[FL-083] over the world's simulator cap: no Harness; moving the world's clock an hour does not reset the real hour", async () => {
    await kit.connector.isps.updateSettings(ISP, { simulatorCaps: { turnsPerHour: 1, turnsPerDay: 300, validationsPerDay: 100, transcribeSecPerDay: 1_800, emailsPerDay: 20, messagesPerRealHourPerIdentity: 60 } });
    await message(1);
    const clock = await kit.connector.runtime.getClock(CLOCK);
    await kit.connector.runtime.updateClock(CLOCK, { pausedSimNow: "2026-10-13T10:20:00-06:00" }, clock?.version ?? 1);
    await message(2);
    expect(kit.rec.harness).toHaveLength(1);
    expect(metricLines(kit, "SimulatorCapHits")).toHaveLength(1);
    expect(kit.rec.notices.map((notice) => notice.notice)).toEqual(["turnCap"]);
  });

  it("[FL-083] with the stage's ceiling full, no call reaches Bedrock nor Transcribe", async () => {
    fillCounter(kit, GLOBAL_TURNS, 100, 100);
    kit.transcription = { status: "CAP_REACHED", resetsAtReal: "2026-10-14T00:00:00.000Z" };
    await message(1);
    await message(2, { content: "VOICE", text: undefined, media: { kind: "AUDIO", s3Key: "sim/abc-e3/up-1", mime: "audio/ogg", durationSec: 8 } });
    expect(kit.rec.harness).toEqual([]);
    expect(kit.rec.notices.map((notice) => notice.notice)).toEqual(["turnCap", "turnCap"]);
  });

  it("[FL-098] QA worlds never consume the stage's ceiling", async () => {
    await seedWorldOf("qa-812-1-sc-12", "isp-qa-812-1-sc-12", "QA");
    await turnIn("qa-812-1-sc-12", "isp-qa-812-1-sc-12", "evt-qa-1");
    expect(kit.rec.harness).toHaveLength(1);
    expect(used(GLOBAL_TURNS)).toBeUndefined();
  });

  it("[FL-112] a sign-up world spends inside its account quota and the sign-up sub-ceiling; an INVITED world keeps its capacity", async () => {
    const signup = { clockId: "GUEST#isp-guest-s261013abcde", ispId: "isp-guest-s261013abcde" };
    const invited = { clockId: "GUEST#isp-guest-07", ispId: "isp-guest-07" };
    await seedWorldOf(signup.clockId, signup.ispId, "GUEST", { ownerUserId: "usr-gst-01jb8z9q", capsProfile: "SIGNUP" });
    await seedWorldOf(invited.clockId, invited.ispId, "GUEST", { capsProfile: "INVITED" });
    fillCounter(kit, "TURNCAP#GUESTSIGNUP#2026-10-13", 20, 20);
    await turnIn(signup.clockId, signup.ispId, "evt-s-1");
    await turnIn(invited.clockId, invited.ispId, "evt-i-1");
    expect(kit.rec.harness).toHaveLength(1);
    expect(metricLines(kit, "GuestSignupCapHits")).toMatchObject([{ scope: "GUEST_SIGNUP" }]);
    expect(used(GLOBAL_TURNS)).toBe(1);
  });

  it("[FL-100] with KILL#AGENT the worker answers servicePaused without the Harness or Transcribe; safety still runs; off again, the next message has its turn", async () => {
    await kit.tools.killAgent();
    await message(1, { text: "Hay un cable pelado en el poste, está chispeando" });
    await message(2, { content: "VOICE", text: undefined, media: { kind: "AUDIO", s3Key: "sim/abc-e3/up-2", mime: "audio/ogg", durationSec: 8 } });
    expect(kit.rec.harness).toEqual([]);
    expect(kit.rec.transcriptions).toEqual([]);
    expect(kit.rec.safety).toHaveLength(1);
    // The safety instruction answered the first message; the voice note gets the pause notice.
    expect(kit.rec.notices.map((notice) => notice.notice)).toEqual(["servicePaused"]);
    expect(metricLines(kit, "KillSwitchActive").length).toBeGreaterThanOrEqual(1);
    expect((await kit.connector.audit.listByMonth(ISP, "2026-10")).map((decision) => decision.action)).toContain("KILL_SWITCH_ACTIVE");
    await kit.tools.store.write("KILL#AGENT", { scope: "AGENT", state: "off", setBy: "OPERATOR", setAtReal: "2026-10-13T15:21:00.000Z" });
    await message(3);
    expect(kit.rec.harness).toHaveLength(1);
  });

  it("[FL-100] the kill switch of one world cuts only that world", async () => {
    await kit.tools.killAgent(CLOCK);
    await message(1);
    await seedWorldOf("qa-812-1-sc-14", "isp-qa-812-1-sc-14", "QA");
    await turnIn("qa-812-1-sc-14", "isp-qa-812-1-sc-14", "evt-qa-2");
    expect(kit.rec.harness).toHaveLength(1);
    expect(kit.rec.notices.map((notice) => notice.notice)).toEqual(["servicePaused"]);
  });
});
