import { describe, expect, it } from "vitest";
import { type CaseStatus, ToolError } from "@cuadrilla/shared";
import { InstallerQueueEvent } from "../../worker/events";
import { DEMO, GUEST_07, QA, type ServiceWorld, serviceWorld } from "../people/testing";
import { requestCaseAction } from "./case-actions";

async function refusal(promise: Promise<unknown>): Promise<ToolError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ToolError);
  return error as ToolError;
}

async function withCase(world: ServiceWorld, status: CaseStatus): Promise<void> {
  await world.deps.connector.cases.createCase({
    caseId: world.ids.case,
    ispId: world.ispId,
    clockId: world.clockId,
    workOrderId: world.ids.order,
    installerId: world.ids.rogelio,
    kind: "ESCALATION",
    reason: "DIAGNOSIS_ATTEMPTS",
    status,
    rung: "PRIMARY",
    rungVersion: 1,
    roster: { primaryId: world.ids.adriana, secondaryId: world.ids.hector, zoneChiefId: world.ids.marisol },
    summary: "Potencia fuera de rango después de 3 pasos.",
    createdAtSim: "2026-10-13T09:00:00-06:00",
    ...(status === "TAKEN" ? { takenBy: world.ids.adriana, takenAtSim: "2026-10-13T09:05:00-06:00" } : {}),
  });
}

const deps = (world: ServiceWorld) => ({ ...world.deps, queue: world.queue });

describe("case actions of the console [FL-065]", () => {
  it("[FL-065] \"Tomar\" queues a SUPERVISOR_ACTION in the group of the case's installer, for the rung's supervisor, by the user", async () => {
    const world = await serviceWorld(DEMO);
    await withCase(world, "OPEN");
    const result = await requestCaseAction(deps(world), world.console(), { caseId: world.ids.case, action: "TAKE" });
    expect(result).toMatchObject({ queued: true, action: "TAKE_CASE", supervisorId: world.ids.adriana });
    expect(world.queued).toEqual([
      {
        type: "SUPERVISOR_ACTION",
        action: "TAKE_CASE",
        eventId: result.eventId,
        clockId: world.clockId,
        ispId: world.ispId,
        installerId: world.ids.rogelio,
        supervisorId: world.ids.adriana,
        caseId: world.ids.case,
        rungVersion: 1,
        actor: "USER:usr-adriana",
      },
    ]);
    // The event is one the InstallerWorker accepts as it is.
    expect(InstallerQueueEvent.parse(world.queued[0])).toEqual(world.queued[0]);
    // The console never changes the case itself: the worker's take_case does, conditionally.
    expect((await world.deps.connector.cases.getCase(world.ids.case))?.status).toBe("OPEN");
    // A retried request is the same event.
    expect((await requestCaseAction(deps(world), world.console(), { caseId: world.ids.case, action: "TAKE" })).eventId).toBe(result.eventId);
  });

  it("[FL-065] at the second rung the take is the backup's; \"Cerrar\" needs a taken case and is the holder's", async () => {
    const world = await serviceWorld(GUEST_07);
    await withCase(world, "TAKEN");
    expect(await refusal(requestCaseAction(deps(world), world.console(), { caseId: world.ids.case, action: "TAKE" }))).toMatchObject({ code: "CONFLICT", reason: "CASE_NOT_OPEN" });
    await requestCaseAction(deps(world), world.console(), { caseId: world.ids.case, action: "CLOSE" });
    expect(world.queued).toMatchObject([{ type: "SUPERVISOR_ACTION", action: "CLOSE_CASE", supervisorId: world.ids.adriana, actor: "USER:usr-guest-07" }]);
    const second = await serviceWorld(DEMO);
    await withCase(second, "OPEN");
    await second.deps.connector.cases.updateCase(second.ids.case, { rung: "SECONDARY" }, {});
    expect(await requestCaseAction(deps(second), second.console(), { caseId: second.ids.case, action: "TAKE" })).toMatchObject({ supervisorId: second.ids.hector });
  });

  it("[FL-065] OPS → FORBIDDEN; a case not taken, a case of another world and unknown fields are refused", async () => {
    const demo = await serviceWorld(DEMO);
    const guest = await serviceWorld(GUEST_07, demo);
    await withCase(demo, "OPEN");
    expect(await refusal(requestCaseAction(deps(demo), demo.console("OPS", "usr-ops"), { caseId: demo.ids.case, action: "TAKE" }))).toMatchObject({ code: "FORBIDDEN" });
    expect(await refusal(requestCaseAction(deps(guest), guest.console(), { caseId: demo.ids.case, action: "TAKE" }))).toMatchObject({ code: "NOT_FOUND" });
    expect(await refusal(requestCaseAction(deps(demo), demo.console(), { caseId: demo.ids.case, action: "TAKE", closeSummary: "x" }))).toMatchObject({ code: "INVALID" });
    expect(await refusal(requestCaseAction(deps(demo), demo.console(), { caseId: demo.ids.case, action: "CLOSE" }))).toMatchObject({ reason: "CASE_NOT_TAKEN" });
    expect(demo.queued).toEqual([]);
  });

  it("QA takes a case in its world as its usr-qa principal", async () => {
    const world = await serviceWorld(QA);
    await withCase(world, "OPEN");
    await requestCaseAction(deps(world), world.qa(), { caseId: world.ids.case, action: "TAKE" });
    expect(world.queued).toMatchObject([{ actor: "QA", installerId: world.ids.rogelio, supervisorId: world.ids.adriana }]);
  });
});
