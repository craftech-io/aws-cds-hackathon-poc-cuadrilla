import { TRPCError } from "@trpc/server";
import { describe, expect, it } from "vitest";
import { ToolError } from "@cuadrilla/shared";
import { DEMO, GUEST_07, SIGNUP, SIGNUP_2, phoneOf } from "../services/people/testing";
import { consoleTestWorld } from "./console-testing";

async function failure(call: Promise<unknown>): Promise<{ code: string; reason: string | undefined }> {
  const error = await call.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(TRPCError);
  const cause = (error as TRPCError).cause;
  return { code: (error as TRPCError).code, reason: cause instanceof ToolError ? cause.reason : undefined };
}

const NEW_INSTALLER = { role: "INSTALLER" as const, firstName: "Ramiro", lastName: "Ficticio", crewId: "crew-n3", zoneId: "zone-norte" };

describe("people router", () => {
  it("[FL-001] a supervisor registers a person: on the allow list, without opt-in, contacts masked, and the poster says ALTA", async () => {
    const t = await consoleTestWorld(DEMO);
    const console = await t.as();
    const created = await console.people.upsert({ ...NEW_INSTALLER, phone: phoneOf("0101", 50), email: "success+c99999@simulator.amazonses.com" });
    expect(created).toMatchObject({ created: true, person: { role: "INSTALLER", active: true } });
    const listed = (await console.people.list({ role: "INSTALLER" })).find((person) => person.personId === created.person.personId);
    expect(listed).toMatchObject({ active: true, optIn: { status: "NONE" } });
    expect(JSON.stringify(listed)).not.toContain(phoneOf("0101", 50));
    expect(await console.people.joinPoster({ personId: created.person.personId })).toMatchObject({ keyword: "ALTA", channel: "simulated", firstName: "Ramiro" });
    expect((await t.world.decisions()).map((row) => row.action)).toContain("PERSON_CREATED");
    // Rogelio is opted in by the fixture: the list says when and with which text.
    expect((await console.people.list({ role: "INSTALLER" })).find((person) => person.personId === t.world.ids.rogelio)).toMatchObject({ optIn: { status: "GRANTED", textVersion: "v001" } });
  });

  it("[FL-001] in a guest world: a phone outside the world's synthetic block → DENY PHONE_NOT_SYNTHETIC; an email outside the fence → RECIPIENT_NOT_ALLOWED", async () => {
    const t = await consoleTestWorld(GUEST_07);
    const console = await t.as();
    expect(await failure(console.people.upsert({ ...NEW_INSTALLER, phone: phoneOf("0101", 60) }))).toEqual({ code: "FORBIDDEN", reason: "PHONE_NOT_SYNTHETIC" });
    expect(await failure(console.people.upsert({ ...NEW_INSTALLER, phone: phoneOf("0207", 60), email: "alguien@example.com" }))).toMatchObject({ code: "FORBIDDEN" });
    const denials = (await t.world.decisions()).filter((row) => row.decision === "DENY").map((row) => row.reason);
    expect(denials).toContain("PHONE_NOT_SYNTHETIC");
    expect(denials.some((reason) => reason !== "PHONE_NOT_SYNTHETIC")).toBe(true);
    expect(await console.people.upsert({ ...NEW_INSTALLER, phone: phoneOf("0207", 60), email: "success+g07-c99999@simulator.amazonses.com" })).toMatchObject({ created: true });
  });

  it("[FL-001] a phone is unique within its world only: CONFLICT inside it, nothing about another world", async () => {
    const first = await consoleTestWorld(SIGNUP);
    const second = await consoleTestWorld(SIGNUP_2, first);
    // Both sign-up worlds share the block +52 55 0300 0xxx: Rogelio holds 0001 in each.
    expect(await failure((await first.as()).people.upsert({ ...NEW_INSTALLER, phone: phoneOf("0300", 1) }))).toEqual({ code: "CONFLICT", reason: "CONFLICT" });
    expect(await (await second.as()).people.upsert({ ...NEW_INSTALLER, phone: phoneOf("0300", 70) })).toMatchObject({ created: true });
    expect(await (await first.as()).people.upsert({ ...NEW_INSTALLER, phone: phoneOf("0300", 70) })).toMatchObject({ created: true });
  });

  it("[FL-007] the roster of a crew for the day changes with history; OPS cannot change it", async () => {
    const t = await consoleTestWorld(DEMO);
    const console = await t.as();
    await console.people.roster.set({ crewId: "crew-n3", date: "2026-10-13", primaryId: t.world.ids.adriana, secondaryId: t.world.ids.hector });
    await console.people.roster.set({ crewId: "crew-n3", date: "2026-10-13", primaryId: t.world.ids.hector, secondaryId: t.world.ids.adriana });
    const roster = await console.people.roster.get({ crewId: "crew-n3" });
    expect(roster).toMatchObject({ date: "2026-10-13", roster: { primaryName: "Héctor", secondaryName: "Adriana", startsAtSim: "2026-10-13T07:00:00-06:00" } });
    expect(roster.roster?.changes.length).toBeGreaterThan(0);
    expect(await failure((await t.as("OPS", "usr-ops")).people.roster.set({ crewId: "crew-n3", date: "2026-10-13", primaryId: t.world.ids.adriana, secondaryId: t.world.ids.hector }))).toMatchObject({ code: "FORBIDDEN" });
  });

  it("[FL-008] deactivating an installer takes it off the allow list with history and returns its open orders for reassignment", async () => {
    const t = await consoleTestWorld(DEMO);
    const result = await (await t.as()).people.deactivate({ personId: t.world.ids.rogelio, reason: "Baja de la cuadrilla" });
    expect(result).toMatchObject({ changed: true, person: { active: false }, needsReassignment: [t.world.ids.order] });
    expect((await t.memory.connector.people.getPerson(t.world.ids.rogelio))?.active).toBe(false);
    expect((await t.world.decisions()).map((row) => row.action)).toContain("PERSON_DEACTIVATED");
    expect(await (await t.as()).people.deactivate({ personId: t.world.ids.rogelio, active: true })).toMatchObject({ person: { active: true } });
  });
});
