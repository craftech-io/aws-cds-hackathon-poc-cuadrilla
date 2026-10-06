import { describe, expect, it } from "vitest";
import { ToolError } from "@cuadrilla/shared";
import { setPersonActive } from "./people";
import { setRoster } from "./roster";
import { registerShift } from "./shift";
import { DEMO, GUEST_07, QA, serviceWorld } from "./testing";

async function refusal(promise: Promise<unknown>): Promise<ToolError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ToolError);
  return error as ToolError;
}

describe("set_roster: supervisors of a crew for a day [FL-007]", () => {
  it("[FL-007] a new roster takes 07:00-19:00 of the day; a change keeps the hours and enters the dated history", async () => {
    const world = await serviceWorld(DEMO);
    const { adriana, hector } = world.ids;
    const first = await setRoster(world.deps, world.console(), { crewId: "crew-n3", date: "2026-10-13", primaryId: adriana, secondaryId: hector });
    expect(first).toMatchObject({ primaryId: adriana, secondaryId: hector, startsAtSim: "2026-10-13T07:00:00-06:00", endsAtSim: "2026-10-13T19:00:00-06:00", changes: 1 });
    const swapped = await setRoster(world.deps, world.console(), { crewId: "crew-n3", date: "2026-10-13", primaryId: hector, secondaryId: adriana });
    expect(swapped).toMatchObject({ primaryId: hector, secondaryId: adriana, startsAtSim: first.startsAtSim, endsAtSim: first.endsAtSim, changes: 2 });
    const stored = await world.deps.connector.isps.getRoster(world.ispId, "crew-n3", "2026-10-13");
    expect(stored?.history.at(-1)).toMatchObject({ field: "roster", from: `${adriana}/${hector}`, to: `${hector}/${adriana}`, actor: "USER:usr-adriana", atSim: "2026-10-13T09:20:00-06:00" });
    expect((await world.decisions()).filter((row) => row.action === "ROSTER_SET")).toHaveLength(2);
  });

  it("[FL-007] a case opened before the change keeps its roster: the change touches only the roster row", async () => {
    const world = await serviceWorld(DEMO);
    const { adriana, hector } = world.ids;
    await setRoster(world.deps, world.console(), { crewId: "crew-n3", date: "2026-10-13", primaryId: adriana, secondaryId: hector });
    await world.deps.connector.cases.createCase({
      caseId: world.ids.case,
      ispId: world.ispId,
      clockId: world.clockId,
      workOrderId: world.ids.order,
      installerId: world.ids.rogelio,
      kind: "ESCALATION",
      reason: "DIAGNOSIS_ATTEMPTS",
      status: "OPEN",
      rung: "PRIMARY",
      rungVersion: 0,
      roster: { primaryId: adriana, secondaryId: hector, zoneChiefId: world.ids.marisol },
      summary: "Potencia fuera de rango después de 3 pasos.",
      createdAtSim: "2026-10-13T09:00:00-06:00",
    });
    await setRoster(world.deps, world.console(), { crewId: "crew-n3", date: "2026-10-13", primaryId: hector, secondaryId: adriana });
    expect((await world.deps.connector.cases.getCase(world.ids.case))?.roster).toMatchObject({ primaryId: adriana, secondaryId: hector });
  });

  it("refuses the same supervisor twice, a non-supervisor, an inactive one, half a shift and an unknown crew", async () => {
    const world = await serviceWorld(DEMO);
    const { adriana, hector, rogelio } = world.ids;
    const base = { crewId: "crew-n3", date: "2026-10-13", primaryId: adriana, secondaryId: hector };
    expect(await refusal(setRoster(world.deps, world.console(), { ...base, secondaryId: adriana }))).toMatchObject({ reason: "SAME_SUPERVISOR" });
    expect(await refusal(setRoster(world.deps, world.console(), { ...base, secondaryId: rogelio.replace("inst-", "sup-") }))).toMatchObject({ code: "NOT_FOUND" });
    expect(await refusal(setRoster(world.deps, world.console(), { ...base, startsAtSim: "2026-10-13T08:00:00-06:00" }))).toMatchObject({ reason: "HOURS_INCOMPLETE" });
    expect(await refusal(setRoster(world.deps, world.console(), { ...base, startsAtSim: "2026-10-13T18:00:00-06:00", endsAtSim: "2026-10-13T08:00:00-06:00" }))).toMatchObject({ reason: "HOURS_INVERTED" });
    expect(await refusal(setRoster(world.deps, world.console(), { ...base, crewId: "crew-x9" }))).toMatchObject({ code: "NOT_FOUND" });
    await setPersonActive(world.deps, world.console(), { personId: hector, active: false });
    expect(await refusal(setRoster(world.deps, world.console(), base))).toMatchObject({ reason: "SUPERVISOR_INACTIVE" });
  });

  it("[FL-007] a supervisor of another world never goes on this world's roster; OPS cannot change it", async () => {
    const demo = await serviceWorld(DEMO);
    const guest = await serviceWorld(GUEST_07, demo);
    expect(await refusal(setRoster(guest.deps, guest.console(), { crewId: "crew-n3", date: "2026-10-13", primaryId: guest.ids.adriana, secondaryId: demo.ids.hector }))).toMatchObject({ code: "NOT_FOUND" });
    expect(await refusal(setRoster(demo.deps, demo.console("OPS", "usr-ops"), { crewId: "crew-n3", date: "2026-10-13", primaryId: demo.ids.adriana, secondaryId: demo.ids.hector }))).toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("register_shift: plan B \"TURNO\" [FL-074]", () => {
  it("[FL-074] opens a 24 h shift window from the message's instant and audits SHIFT_REGISTERED", async () => {
    const world = await serviceWorld(DEMO);
    const result = await registerShift(world.deps, world.channel("wa-in-turno"), { personId: world.ids.adriana, atSim: "2026-10-13T07:05:00-06:00", sourceMessageId: "wamid.T1" });
    expect(result).toEqual({ openedAtSim: "2026-10-13T07:05:00-06:00", closesAtSim: "2026-10-14T07:05:00-06:00" });
    expect(await world.deps.connector.people.getShiftWindow(world.ids.adriana)).toMatchObject({ openedAtSim: result.openedAtSim, closesAtSim: result.closesAtSim, clockId: world.clockId });
    expect((await world.decisions()).filter((row) => row.action === "SHIFT_REGISTERED")).toMatchObject([{ actor: "CHANNEL", messageId: "wamid.T1", refs: { personId: world.ids.adriana } }]);
  });

  it("[FL-074] only an active supervisor with opt-in; QA uses the world's now and never brings a message", async () => {
    const world = await serviceWorld(DEMO);
    expect(await refusal(registerShift(world.deps, world.channel(), { personId: world.ids.rogelio.replace("inst-", "sup-") }))).toMatchObject({ code: "NOT_FOUND" });
    await world.deps.connector.people.revokeConsent(world.ids.hector, { actor: "SEED", atSim: "2026-10-12T08:00:00-06:00" });
    expect(await refusal(registerShift(world.deps, world.channel(), { personId: world.ids.hector }))).toMatchObject({ code: "POLICY_DENIED", reason: "NO_OPT_IN" });
    expect(await refusal(registerShift(world.deps, world.console(), { personId: world.ids.adriana }))).toMatchObject({ code: "FORBIDDEN" });
    const qa = await serviceWorld(QA);
    expect(await registerShift(qa.deps, qa.qa(), { personId: qa.ids.adriana })).toMatchObject({ openedAtSim: "2026-10-13T09:20:00-06:00" });
    expect(await refusal(registerShift(qa.deps, qa.qa(), { personId: qa.ids.adriana, atSim: "2026-10-13T07:05:00-06:00" }))).toMatchObject({ reason: "CHANNEL_ONLY_FIELD" });
  });
});
