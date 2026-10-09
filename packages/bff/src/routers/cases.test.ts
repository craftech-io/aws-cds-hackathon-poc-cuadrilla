import { TRPCError } from "@trpc/server";
import { describe, expect, it } from "vitest";
import type { CaseStatus } from "@cuadrilla/shared";
import { InstallerQueueEvent } from "../worker/events";
import { DEMO, GUEST_07, QA } from "../services/people/testing";
import { type ConsoleTestWorld, consoleTestWorld } from "./console-testing";

async function withCase(t: ConsoleTestWorld, status: CaseStatus): Promise<void> {
  const { world } = t;
  await t.memory.connector.cases.createCase({
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
    ladder: [{ rung: "PRIMARY", outcome: "NOTIFIED", personId: world.ids.adriana, channel: "TEMPLATE", atSim: "2026-10-13T11:50:00-06:00" }],
    summary: "Potencia fuera de rango después de 3 pasos.",
    createdAtSim: "2026-10-13T11:50:00-06:00",
    ...(status === "TAKEN" ? { takenBy: world.ids.hector, takenAtSim: "2026-10-13T12:02:00-06:00" } : {}),
  });
  await t.memory.connector.timers.createTimer({ timerId: "case-timeout-1", kind: "CASE_TIMEOUT", home: { kind: "CASE", id: world.ids.case }, clockId: world.clockId, dueAtSim: "2026-10-13T12:00:00-06:00", status: "SCHEDULED" });
}

async function codeOf(call: Promise<unknown>): Promise<string> {
  const error = await call.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(TRPCError);
  return (error as TRPCError).code;
}

describe("cases router [FL-065]", () => {
  it("[FL-065] lists the world's cases and shows the ladder, the pending timeout and the roster by name", async () => {
    const t = await consoleTestWorld(DEMO);
    await withCase(t, "OPEN");
    const ops = await t.as("OPS", "usr-ops");
    expect(await ops.cases.list({ status: "OPEN" })).toMatchObject([{ caseId: t.world.ids.case, workOrderNumber: "24817", installer: "Rogelio Ficticio", rung: "PRIMARY", createdAtSim: "2026-10-13T11:50:00-06:00" }]);
    expect(await ops.cases.list({ status: "CLOSED" })).toEqual([]);
    const detail = await ops.cases.get({ caseId: t.world.ids.case });
    expect(detail.ladder).toEqual([expect.objectContaining({ rung: "PRIMARY", outcome: "NOTIFIED", person: "Adriana Ficticio" })]);
    expect(detail.pendingTimeout).toEqual({ dueAtSim: "2026-10-13T12:00:00-06:00", rung: "PRIMARY" });
    expect(detail.roster).toEqual({ primary: "Adriana Ficticio", secondary: "Héctor Ficticio", zoneChief: "Marisol Ficticio" });
  });

  it("[FL-065] \"Tomar\" queues the same take_case in the installer's group, by the console user; the case itself does not change here", async () => {
    const t = await consoleTestWorld(DEMO);
    await withCase(t, "OPEN");
    const result = await (await t.as()).cases.take({ caseId: t.world.ids.case });
    expect(result).toMatchObject({ queued: true, action: "TAKE_CASE", supervisorId: t.world.ids.adriana });
    expect(t.ports.queued).toEqual([expect.objectContaining({ type: "SUPERVISOR_ACTION", action: "TAKE_CASE", installerId: t.world.ids.rogelio, actor: "USER:usr-adriana" })]);
    expect(InstallerQueueEvent.parse(t.ports.queued[0])).toEqual(t.ports.queued[0]);
    expect((await t.memory.connector.cases.getCase(t.world.ids.case))?.status).toBe("OPEN");
  });

  it("[FL-065] \"Cerrar\" a taken case as a guest in its own world; OPS → 403 and nothing queued", async () => {
    const t = await consoleTestWorld(GUEST_07);
    await withCase(t, "TAKEN");
    await (await t.as()).cases.close({ caseId: t.world.ids.case });
    expect(t.ports.queued).toMatchObject([{ action: "CLOSE_CASE", supervisorId: t.world.ids.hector, actor: "USER:usr-guest-07" }]);
    const demo = await consoleTestWorld(DEMO);
    await withCase(demo, "OPEN");
    expect(await codeOf((await demo.as("OPS", "usr-ops")).cases.take({ caseId: demo.world.ids.case }))).toBe("FORBIDDEN");
    expect(demo.ports.queued).toEqual([]);
  });

  it("[FL-065] a case that moved answers CONFLICT; the QaDriver's supervisor acts in its own world", async () => {
    const t = await consoleTestWorld(DEMO);
    await withCase(t, "TAKEN");
    expect(await codeOf((await t.as()).cases.take({ caseId: t.world.ids.case }))).toBe("CONFLICT");
    const qa = await consoleTestWorld(QA);
    await withCase(qa, "OPEN");
    await qa.qa("SUPERVISOR").cases.take({ caseId: qa.world.ids.case });
    expect(qa.ports.queued).toMatchObject([{ action: "TAKE_CASE", actor: "QA" }]);
  });
});
