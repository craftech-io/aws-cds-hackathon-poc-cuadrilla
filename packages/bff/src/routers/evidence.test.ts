import { TRPCError } from "@trpc/server";
import { describe, expect, it } from "vitest";
import { AuthError } from "../auth/errors";
import { DEMO } from "../services/people/testing";
import { type ConsoleTestWorld, consoleTestWorld } from "./console-testing";

const VAL_UNSURE = "val-01J9ZQX0000000000000000001";
const VAL_REJECT = "val-01J9ZQX0000000000000000002";

async function seedReview(t: ConsoleTestWorld): Promise<void> {
  const { connector } = t.memory;
  const order = t.world.ids.order;
  const transition = { actor: "AGENT" as const, atSim: "2026-10-13T09:47:00-06:00" };
  await connector.reference.put("Rubric", { rubricVersion: "v001", item: "POWER_READING_PHOTO", mustShow: ["La pantalla del medidor con el valor y la longitud de onda"] });
  await connector.workOrders.createValidation({ validationId: VAL_UNSURE, workOrderId: order, clockId: t.world.clockId, item: "POWER_READING_PHOTO", verdict: "UNSURE", modelVerdict: "PASS", confidence: 0.42, readings: { readingDbm: -21.4 }, checks: ["VAL-CONFIDENCE"], rubricVersion: "v001", source: "SCRIPTED", atSim: "2026-10-13T09:46:30-06:00" });
  await connector.workOrders.updateChecklistItem(order, "POWER_READING_PHOTO", { status: "IN_REVIEW", validationId: VAL_UNSURE }, transition);
  await connector.workOrders.createValidation({ validationId: VAL_REJECT, workOrderId: order, clockId: t.world.clockId, item: "ONU_LABEL_PHOTO", verdict: "REJECT", reasonCode: "GLARE", source: "SCRIPTED", atSim: "2026-10-13T09:47:30-06:00" });
  await connector.workOrders.updateChecklistItem(order, "ONU_LABEL_PHOTO", { status: "REJECTED", addAttempts: 1, lastRejectReason: "GLARE", validationId: VAL_REJECT }, transition);
}

async function failure(call: Promise<unknown>): Promise<{ code: string; reason?: string }> {
  const error = await call.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(TRPCError);
  const cause = (error as TRPCError).cause;
  return { code: (error as TRPCError).code, ...(cause instanceof AuthError ? { reason: cause.reason } : {}) };
}

describe("evidence router", () => {
  it("[FL-043] the review queue lists the unsure photo first with its validator output and rubric, then the rejected one", async () => {
    const t = await consoleTestWorld(DEMO);
    await seedReview(t);
    const queue = await (await t.as("OPS", "usr-ops")).evidence.queue();
    expect(queue.items.map((item) => [item.item, item.status])).toEqual([
      ["POWER_READING_PHOTO", "IN_REVIEW"],
      ["ONU_LABEL_PHOTO", "REJECTED"],
    ]);
    expect(queue.items[0]).toMatchObject({ validation: { verdict: "UNSURE", confidence: 0.42, checks: ["VAL-CONFIDENCE"], readings: { readingDbm: -21.4 } }, rubric: { version: "v001" } });
    expect(queue.items[1]).toMatchObject({ attempts: 1, lastRejectReason: "GLARE", validation: { reasonCode: "GLARE" } });
  });

  it("[FL-044] a manual validation with a reason: OVERRIDDEN by the user, audited, and the agent's turn queued", async () => {
    const t = await consoleTestWorld(DEMO);
    await seedReview(t);
    const result = await (await t.as()).evidence.override({ workOrderId: t.world.ids.order, item: "POWER_READING_PHOTO", reason: "La lectura se ve completa en la foto" });
    expect(result).toMatchObject({ status: "OVERRIDDEN", overriddenBy: "usr-adriana", atSim: "2026-10-13T09:20:00-06:00" });
    const entry = await t.memory.connector.workOrders.getChecklistItem(t.world.ids.order, "POWER_READING_PHOTO");
    expect(entry).toMatchObject({ status: "OVERRIDDEN", override: { userId: "usr-adriana" } });
    expect((await t.world.decisions()).filter((row) => row.action === "EVIDENCE_OVERRIDDEN")).toEqual([expect.objectContaining({ actor: "USER:usr-adriana", detail: { userId: "usr-adriana", from: "IN_REVIEW" } })]);
    expect(t.ports.queued).toEqual([expect.objectContaining({ type: "AGENT_TURN", trigger: "EVIDENCE_OVERRIDDEN", installerId: t.world.ids.rogelio })]);
    expect((await (await t.as()).evidence.queue()).items.map((item) => item.item)).toEqual(["ONU_LABEL_PHOTO"]);
  });

  it("[FL-044] needs a sign-in of at most 15 minutes and a role that acts: OPS never validates", async () => {
    const t = await consoleTestWorld(DEMO);
    await seedReview(t);
    const stale = Math.floor(Date.now() / 1000) - 20 * 60;
    const input = { workOrderId: t.world.ids.order, item: "ONU_LABEL_PHOTO" as const, reason: "Se lee el serial completo" };
    expect(await failure((await t.as("SUPERVISOR", "usr-adriana", { auth_time: stale })).evidence.override(input))).toEqual({ code: "FORBIDDEN", reason: "LOGIN_NOT_RECENT" });
    expect(await failure((await t.as("OPS", "usr-ops")).evidence.override(input))).toEqual({ code: "FORBIDDEN", reason: "ROLE_NOT_ALLOWED" });
    expect(await failure((await t.as()).evidence.override({ ...input, item: "ROSETTE_PHOTO" }))).toMatchObject({ code: "CONFLICT" });
    expect(t.ports.queued).toEqual([]);
  });
});
