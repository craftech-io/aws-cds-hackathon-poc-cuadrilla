// The connector plugged into the modules that were written against a port before it existed: the
// turn session (services/session), the world clock (lib/clock) and the tool gate of `LAM-SCOPE`.
import { describe, expect, it } from "vitest";
import { ToolError } from "@cuadrilla/shared";
import { worldClock } from "../../lib/clock";
import { deriveSubkey } from "../../lib/crypto";
import { openSession, resolveSession, type SessionStore, type SessionWriter } from "../../services/session/session";
import { CLOCK, ISP, testConnector } from "../testing";

const KEY = deriveSubkey("test-master-key-test-master-key-00000000", "session");

describe("connector as the store of the session service and the world clock", () => {
  it("opens and resolves a turn session, and refuses it once the turn is closed", async () => {
    const world = testConnector();
    const store: SessionStore & SessionWriter = world.connector.runtime;
    const nowMs = world.now().getTime();
    const input = { turnId: "01J9ZQX0000000000000000TRN", ispId: ISP, installerId: "inst-rogelio", workOrderId: "wo-24817", trigger: "INSTALLER_MESSAGE" as const, clockId: CLOCK, eventAtSim: "2026-10-13T09:20:00-06:00" };
    const opened = await openSession({ sessionKey: KEY, store, nowMs }, input);
    expect(await resolveSession(KEY, opened.token, store, nowMs)).toMatchObject({ installerId: "inst-rogelio", workOrderId: "wo-24817" });
    await world.connector.runtime.closeTurn(input.turnId);
    await expect(resolveSession(KEY, opened.token, store, nowMs)).rejects.toBeInstanceOf(ToolError);
  });

  it("gives the world clock its stored state", async () => {
    const world = testConnector();
    await world.connector.runtime.createClock({ clockId: CLOCK, ispId: ISP, kind: "DEMO", mode: "PAUSED", offsetMs: 0, pausedSimNow: "2026-10-13T07:00:00-06:00", worldEpoch: 3 });
    const clock = worldClock(CLOCK, { readClock: (clockId) => world.connector.runtime.getClock(clockId), realClock: { now: async () => world.now() } });
    expect(await clock.snapshot()).toMatchObject({ mode: "PAUSED", worldEpoch: 3, simNow: new Date("2026-10-13T13:00:00.000Z") });
  });
});
