import { beforeEach, describe, expect, it } from "vitest";
import { CLOCK, ISP, MSG, ROGELIO, TURN_AT_SIM, type WorkerKit, fillCounter, inboundEvent, inboundMessage, metricLines, seedWorld, workerKit } from "./testing";

let kit: WorkerKit;

beforeEach(async () => {
  kit = workerKit();
  await seedWorld(kit);
});

const used = (key: string): unknown => kit.tools.store.items.get(key)?.used;
const capRows = async () => (await kit.connector.audit.listByMonth(ISP, "2026-10")).filter((decision) => decision.action === "TURN_CAP");

async function message(n: number) {
  const stored = await inboundMessage(kit, { messageId: `${MSG}-${n}`, text: `mensaje ${n}` });
  await kit.run(inboundEvent(stored, `wa-in-${n.toString().padStart(40, "0")}`));
}

describe("worker/turn-cap", () => {
  it("[FL-098] over the operator's turn cap: TURN_CAP audited with its scope, the fixed turnCap notice and no Harness", async () => {
    await kit.connector.isps.updateSettings(ISP, { turnCaps: { perHour: 1, perDay: 1_000 } });
    await message(1);
    await message(2);
    expect(kit.rec.harness).toHaveLength(1);
    expect(await capRows()).toMatchObject([{ decision: "DENY", detail: { scope: "OPERATOR", ledger: "OPERATOR", period: "HOUR", limit: 1 } }]);
    expect(kit.rec.notices.map((notice) => notice.notice)).toEqual(["turnCap"]);
    expect(metricLines(kit, "TurnCapHits")).toMatchObject([{ scope: "OPERATOR", period: "HOUR", ledger: "OPERATOR" }]);
  });

  it("[FL-098] over the stage's ceiling of the day: TURN_CAP with scope GLOBAL and TurnCapHits{scope=GLOBAL}", async () => {
    fillCounter(kit, "TURNCAP#GLOBAL#2026-10-13", 100, 100);
    await message(1);
    expect(kit.rec.harness).toEqual([]);
    expect(await capRows()).toMatchObject([{ detail: { scope: "GLOBAL", period: "DAY", limit: 100 } }]);
    expect(metricLines(kit, "TurnCapHits").some((line) => line.scope === "GLOBAL")).toBe(true);
  });

  it("[FL-098] a redelivered event never takes a second turn of any cap", async () => {
    kit.harnessScripts.push(async () => Promise.reject(new Error("connection reset")));
    const stored = await inboundMessage(kit);
    await expect(kit.run(inboundEvent(stored))).rejects.toThrow("connection reset");
    await kit.run(inboundEvent(stored), 2);
    expect(kit.rec.harness).toHaveLength(2);
    expect(used("TURNCAP#GLOBAL#2026-10-13")).toBe(1);
    expect(used(`TURNCAP#${ISP}#2026-10-13T15`)).toBe(1);
    expect(used(`SIMCAP#${CLOCK}#turns#2026-10-13`)).toBe(1);
  });

  it("[FL-098] a turn the installer did not ask for (an order changed) is refused without a notice", async () => {
    await kit.connector.isps.updateSettings(ISP, { turnCaps: { perHour: 0, perDay: 0 } });
    await kit.run({ type: "AGENT_TURN", trigger: "WORK_ORDER_CHANGED", eventId: "evt-wo-1", clockId: CLOCK, ispId: ISP, installerId: ROGELIO, eventAtSim: TURN_AT_SIM });
    expect(kit.rec.harness).toEqual([]);
    expect(kit.rec.notices).toEqual([]);
    expect(await capRows()).toHaveLength(1);
  });
});
