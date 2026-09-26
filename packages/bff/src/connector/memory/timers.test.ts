import { beforeEach, describe, expect, it } from "vitest";
import { parseTimerRefKey, timerRefKey } from "../keys";
import { CASE_1, CLOCK, ISP, QA_CLOCK, installer, testConnector } from "../testing";

const dayStart = {
  timerId: "inst-rogelio-2026-10-13",
  kind: "DAY_START" as const,
  home: { kind: "WORK_ORDER" as const, id: "wo-24817" },
  clockId: CLOCK,
  dueAtSim: "2026-10-13T07:30:00-06:00",
  status: "SCHEDULED" as const,
};
const caseTimeout = {
  timerId: "PRIMARY",
  kind: "CASE_TIMEOUT" as const,
  home: { kind: "CASE" as const, id: CASE_1 },
  clockId: CLOCK,
  dueAtSim: "2026-10-13T12:00:00-06:00",
  status: "SCHEDULED" as const,
  payload: { rungVersion: 0 },
};

describe("timers over the memory connector", () => {
  let world: ReturnType<typeof testConnector>;

  beforeEach(async () => {
    world = testConnector();
    await world.connector.timers.createTimer(dayStart);
    await world.connector.timers.createTimer(caseTimeout);
  });

  it("lists due timers of a world from orders and cases, in due order, up to an instant", async () => {
    expect((await world.connector.timers.listDueTimers(CLOCK)).map((timer) => timer.kind)).toEqual(["DAY_START", "CASE_TIMEOUT"]);
    expect((await world.connector.timers.listDueTimers(CLOCK, "2026-10-13T11:00:00-06:00")).map((timer) => timer.timerId)).toEqual(["inst-rogelio-2026-10-13"]);
    expect(await world.connector.timers.listDueTimers(QA_CLOCK)).toEqual([]);
    expect(await world.connector.timers.listDueTimers(CLOCK, undefined, 1)).toHaveLength(1);
    expect(world.client.dump("Cases")[0]).toMatchObject({ SK: "TIMER#CASE_TIMEOUT#PRIMARY", clockDueKey: `CLOCK#${CLOCK}`, dueAtSim: "2026-10-13T18:00:00.000Z" });
  });

  it("fires a timer once: the version guard stops a stale second firing and it leaves the due index", async () => {
    const ref = { home: dayStart.home, kind: dayStart.kind, timerId: dayStart.timerId };
    const fired = await world.connector.timers.setTimerStatus(ref, { status: "FIRED", firedBy: "CLOCK", firedAtSim: dayStart.dueAtSim }, 1);
    expect(fired).toMatchObject({ status: "FIRED", firedBy: "CLOCK", version: 2 });
    await expect(world.connector.timers.setTimerStatus(ref, { status: "FIRED", firedBy: "SCHEDULER" }, 1)).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await world.connector.timers.listDueTimers(CLOCK)).map((timer) => timer.kind)).toEqual(["CASE_TIMEOUT"]);
    await expect(world.connector.timers.createTimer(dayStart)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("reschedules a timer back into the index and keeps its schedule name", async () => {
    const ref = { home: caseTimeout.home, kind: caseTimeout.kind, timerId: caseTimeout.timerId };
    await world.connector.timers.setTimerStatus(ref, { status: "SKIPPED", reason: "NOT_DUE_YET" }, 1);
    const again = await world.connector.timers.rescheduleTimer(ref, "2026-10-13T12:01:00-06:00", 2, { payload: { rungVersion: 0 } });
    expect(again).toMatchObject({ status: "SCHEDULED", dueAtSim: "2026-10-13T18:01:00.000Z" });
    expect(again.firedBy).toBeUndefined();
    const named = await world.connector.timers.setScheduleName(ref, "tm-d-PRIMARY", 3);
    expect(named.scheduleName).toBe("tm-d-PRIMARY");
    expect((await world.connector.timers.listTimers(caseTimeout.home)).map((timer) => timer.version)).toEqual([4]);
    await world.connector.timers.deleteTimer(ref);
    expect(await world.connector.timers.getTimer(ref)).toBeUndefined();
  });

  it("finds DAY_START timers of installers without orders on their person", async () => {
    await world.connector.people.createPerson(installer({ personId: "inst-lorena", firstName: "Lorena", lastName: "Ávila", phone: undefined, phoneHash: undefined }));
    await world.connector.timers.createTimer({ ...dayStart, timerId: "inst-lorena-2026-10-13", home: { kind: "PERSON", id: "inst-lorena" } });
    expect(world.client.dump("People").some((row) => row.SK === "TIMER#DAY_START#inst-lorena-2026-10-13")).toBe(true);
    expect((await world.connector.timers.listDuePersonTimers(ISP, "2026-10-13T08:00:00-06:00")).map((timer) => timer.home)).toEqual([{ kind: "PERSON", id: "inst-lorena" }]);
    expect(await world.connector.timers.listDuePersonTimers(ISP, "2026-10-13T07:00:00-06:00")).toEqual([]);
  });

  it("round-trips the timer reference a schedule carries and rejects anything else", () => {
    const key = timerRefKey({ home: caseTimeout.home, kind: caseTimeout.kind, timerId: caseTimeout.timerId });
    expect(key).toBe(`CASE|${CASE_1}|CASE_TIMEOUT|PRIMARY`);
    expect(parseTimerRefKey(key)).toEqual({ home: caseTimeout.home, kind: "CASE_TIMEOUT", timerId: "PRIMARY" });
    expect(parseTimerRefKey("CASE|case-x|CASE_TIMEOUT|PRIMARY")).toBeUndefined();
    expect(parseTimerRefKey("WORK_ORDER|wo-24817|DAY_START|a|b")).toBeUndefined();
    expect(parseTimerRefKey("WORK_ORDER|wo-24817|NAP|a")).toBeUndefined();
  });
});
