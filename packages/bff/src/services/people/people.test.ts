import { describe, expect, it } from "vitest";
import { ToolError } from "@cuadrilla/shared";
import { setPersonActive, upsertPerson } from "./people";
import { DEMO, GUEST_07, QA, SIGNUP, SIGNUP_2, type ServiceWorld, hashPhone, phoneOf, serviceWorld } from "./testing";

const deps = (world: ServiceWorld, extra: Record<string, unknown> = {}) => ({ ...world.deps, hashPhone, newIdBody: () => "01J9ZQX0000000000000000099", ...extra });

const newInstaller = (phone: string, overrides: Record<string, unknown> = {}) => ({ role: "INSTALLER", firstName: "Nadia", lastName: "Ficticia", crewId: "crew-n3", phone, ...overrides });

async function refusal(promise: Promise<unknown>): Promise<ToolError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ToolError);
  return error as ToolError;
}

describe("upsert_person: registry of a world's staff [FL-001]", () => {
  it("[FL-001] creates an active person without opt-in, claims the phone in the world and audits PERSON_CREATED", async () => {
    const world = await serviceWorld(DEMO);
    const phone = phoneOf("0101", 8);
    const result = await upsertPerson(deps(world), world.console(), newInstaller(phone));
    expect(result).toMatchObject({ created: true, person: { personId: "inst-01J9ZQX0000000000000000099", role: "INSTALLER", active: true, crewId: "crew-n3", zoneId: "zone-norte", phoneMasked: "+52******0008" } });
    const stored = await world.deps.connector.people.getPerson(result.person.personId);
    expect(stored).toMatchObject({ clockId: "GLOBAL#isp-demo", phone, phoneHash: hashPhone(phone), active: true });
    expect(await world.deps.connector.people.getConsent(result.person.personId)).toBeUndefined();
    expect(await world.deps.connector.people.getAddressClaim(world.clockId, hashPhone(phone))).toMatchObject({ personId: result.person.personId });
    const [created] = (await world.decisions()).filter((row) => row.action === "PERSON_CREATED");
    expect(created).toMatchObject({ decision: "ACTION", actor: "USER:usr-adriana", refs: { personId: result.person.personId } });
    expect(JSON.stringify(created)).not.toContain(phone);
  });

  it("[FL-001] a phone already held in the same world is CONFLICT, audited, and the existing person is untouched", async () => {
    const world = await serviceWorld(DEMO);
    const taken = phoneOf("0101", 1);
    const error = await refusal(upsertPerson(deps(world), world.console(), newInstaller(taken)));
    expect(error).toMatchObject({ code: "CONFLICT", reason: "CONFLICT" });
    expect(error.message).not.toContain(world.ids.rogelio);
    expect(error.message).not.toContain(taken);
    expect(await world.deps.connector.people.getPerson("inst-01J9ZQX0000000000000000099")).toBeUndefined();
    expect((await world.decisions()).filter((row) => row.decision === "DENY")).toMatchObject([{ action: "PERSON_UPSERT", reason: "CONFLICT" }]);
  });

  it("[FL-001] the same phone in another world is no conflict and reveals nothing", async () => {
    // Every generation of the own sign-up shares the block +52 55 0300 0xxx: identity is unique per world.
    const first = await serviceWorld(SIGNUP);
    const second = await serviceWorld(SIGNUP_2, first);
    const phone = phoneOf("0300", 50);
    expect(await upsertPerson(deps(first), first.console(), newInstaller(phone))).toMatchObject({ created: true });
    const other = await upsertPerson({ ...deps(second), newIdBody: () => "01J9ZQX0000000000000000098" }, second.console(), newInstaller(phone));
    expect(other.created).toBe(true);
    expect(await first.deps.connector.people.getAddressClaim(first.clockId, hashPhone(phone))).toMatchObject({ personId: "inst-01J9ZQX0000000000000000099" });
    expect(await second.deps.connector.people.getAddressClaim(second.clockId, hashPhone(phone))).toMatchObject({ personId: "inst-01J9ZQX0000000000000000098" });
    expect((await second.decisions()).some((row) => row.decision === "DENY")).toBe(false);
    // Within the second world the phone is now taken.
    expect(await refusal(upsertPerson(deps(second), second.console(), newInstaller(phone)))).toMatchObject({ code: "CONFLICT" });
  });

  it("[FL-001] a guest world only takes phones of its own block: DENY PHONE_NOT_SYNTHETIC otherwise", async () => {
    const world = await serviceWorld(GUEST_07);
    const caller = world.console();
    for (const phone of [phoneOf("0208", 9), phoneOf("0101", 9), "+525512345678", "+14155550101", phoneOf("0207", 1999)]) {
      const error = await refusal(upsertPerson(deps(world), caller, newInstaller(phone)));
      expect(error).toMatchObject({ code: "RECIPIENT_NOT_ALLOWED", reason: "PHONE_NOT_SYNTHETIC" });
    }
    const denies = (await world.decisions()).filter((row) => row.decision === "DENY");
    expect(denies).toHaveLength(5);
    expect(denies.every((row) => row.action === "PERSON_UPSERT" && row.reason === "PHONE_NOT_SYNTHETIC")).toBe(true);
    expect(await upsertPerson(deps(world), caller, newInstaller(phoneOf("0207", 9)))).toMatchObject({ created: true });
  });

  it("[FL-001] an email outside the world's fence is RECIPIENT_NOT_ALLOWED and audited with CP-RECIPIENT-FENCE", async () => {
    const world = await serviceWorld(GUEST_07);
    const chief = { role: "ZONE_CHIEF", firstName: "Lucía", lastName: "Ficticia", zoneId: "zone-sur" };
    for (const email of ["lucia@gmail.com", "zc@cuadrilla.demo.craftech.io", "jefa@example.com"]) {
      const error = await refusal(upsertPerson(deps(world), world.console(), { ...chief, email }));
      expect(error.code).toBe("RECIPIENT_NOT_ALLOWED");
    }
    const denies = (await world.decisions()).filter((row) => row.decision === "DENY");
    expect(denies.every((row) => row.ruleIds.includes("CP-RECIPIENT-FENCE") && row.reason === "RECIPIENT_NOT_ALLOWED")).toBe(true);
    expect(await refusal(upsertPerson(deps(world), world.console(), { ...chief, email: "no es un email" }))).toMatchObject({ code: "INVALID", reason: "EMAIL_INVALID" });
    expect(denies).toHaveLength(3);
    const ok = await upsertPerson(deps(world), world.console(), { ...chief, email: "success+zc-lucia-g07@simulator.amazonses.com" });
    expect(ok.person).toMatchObject({ role: "ZONE_CHIEF", zoneId: "zone-sur", emailMasked: "s***@simulator.amazonses.com" });
    expect(ok.person.crewId).toBeUndefined();
  });

  it("[FL-001] the demo recipients of the operator count only in the demo world", async () => {
    const demo = await serviceWorld(DEMO);
    const guest = await serviceWorld(GUEST_07);
    const chief = { role: "ZONE_CHIEF", firstName: "Lucía", lastName: "Ficticia", zoneId: "zone-sur", email: "alertas@buzon.example.org" };
    const addresses = { demoRecipients: ["alertas@buzon-demo.mx"] };
    const real = { ...chief, email: "alertas@buzon-demo.mx" };
    expect(await upsertPerson(deps(demo, { addresses }), demo.console(), real)).toMatchObject({ created: true });
    expect(await refusal(upsertPerson(deps(guest, { addresses }), guest.console(), real))).toMatchObject({ code: "RECIPIENT_NOT_ALLOWED" });
    expect(await refusal(upsertPerson(deps(demo, { addresses }), demo.console(), chief))).toMatchObject({ code: "RECIPIENT_NOT_ALLOWED" });
  });

  it("[FL-001] QA worlds take the leased block, sign-up generations the shared one", async () => {
    const qa = await serviceWorld(QA);
    expect(await upsertPerson(deps(qa), qa.qa(), newInstaller(phoneOf("0901", 9)))).toMatchObject({ created: true });
    expect(await refusal(upsertPerson(deps(qa), qa.qa(), newInstaller(phoneOf("0207", 9))))).toMatchObject({ reason: "PHONE_NOT_SYNTHETIC" });
    const signup = await serviceWorld(SIGNUP);
    expect(await upsertPerson(deps(signup), signup.console(), newInstaller(phoneOf("0300", 42)))).toMatchObject({ created: true });
    expect(await refusal(upsertPerson(deps(signup), signup.console(), newInstaller(phoneOf("0301", 42))))).toMatchObject({ reason: "PHONE_NOT_SYNTHETIC" });
  });

  it("the demo world takes synthetic phones and only the real phones registered for the live world", async () => {
    const world = await serviceWorld(DEMO);
    const real = "+525512345678";
    expect(await refusal(upsertPerson(deps(world), world.console(), newInstaller(real)))).toMatchObject({ reason: "PHONE_NOT_SYNTHETIC" });
    const registered = deps(world, { addresses: { registeredRealPhones: new Set([real]) } });
    expect(await upsertPerson(registered, world.console(), newInstaller("+52 55 1234 5678"))).toMatchObject({ created: true });
  });

  it("edits keep what is left out, never change the role and move the phone's claim", async () => {
    const world = await serviceWorld(DEMO);
    const { rogelio } = world.ids;
    const renamed = await upsertPerson(deps(world), world.console(), { personId: rogelio, firstName: "Rogelio", lastName: "Méndez" });
    expect(renamed).toMatchObject({ created: false, person: { personId: rogelio, lastName: "Méndez", crewId: "crew-n3", phoneMasked: "+52******0001" } });
    expect(await refusal(upsertPerson(deps(world), world.console(), { personId: rogelio, role: "SUPERVISOR", firstName: "R", lastName: "M" }))).toMatchObject({ code: "INVALID", reason: "ROLE_IMMUTABLE" });
    const moved = phoneOf("0101", 21);
    await upsertPerson(deps(world), world.console(), { personId: rogelio, firstName: "Rogelio", lastName: "Méndez", phone: moved });
    expect(await world.deps.connector.people.getAddressClaim(world.clockId, hashPhone(moved))).toMatchObject({ personId: rogelio });
    expect(await world.deps.connector.people.getAddressClaim(world.clockId, hashPhone(phoneOf("0101", 1)))).toBeUndefined();
    const updates = (await world.decisions()).filter((row) => row.action === "PERSON_UPDATED");
    expect(updates.map((row) => row.detail?.fields)).toEqual([["lastName"], ["phone"]]);
    expect(await refusal(upsertPerson(deps(world), world.console(), { personId: rogelio, firstName: "Rogelio", lastName: "Méndez", phone: null }))).toMatchObject({ reason: "PHONE_REQUIRED" });
  });

  it("checks crews and zones of the operator and the needs of each role", async () => {
    const world = await serviceWorld(DEMO);
    const caller = world.console();
    expect(await refusal(upsertPerson(deps(world), caller, newInstaller(phoneOf("0101", 30), { crewId: "crew-x9" })))).toMatchObject({ reason: "CREW_UNKNOWN" });
    expect(await refusal(upsertPerson(deps(world), caller, newInstaller(phoneOf("0101", 30), { zoneId: "zone-sur" })))).toMatchObject({ reason: "ZONE_MISMATCH" });
    expect(await refusal(upsertPerson(deps(world), caller, newInstaller(phoneOf("0101", 30), { crewId: undefined })))).toMatchObject({ reason: "CREW_REQUIRED" });
    expect(await refusal(upsertPerson(deps(world), caller, { role: "INSTALLER", firstName: "N", lastName: "F", crewId: "crew-n3" }))).toMatchObject({ reason: "PHONE_REQUIRED" });
    expect(await refusal(upsertPerson(deps(world), caller, { role: "ZONE_CHIEF", firstName: "N", lastName: "F", zoneId: "zone-sur" }))).toMatchObject({ reason: "EMAIL_REQUIRED" });
    expect(await refusal(upsertPerson(deps(world), caller, { firstName: "N", lastName: "F", phone: phoneOf("0101", 30) }))).toMatchObject({ reason: "ROLE_REQUIRED" });
    expect(await refusal(upsertPerson(deps(world), caller, { ...newInstaller(phoneOf("0101", 30)), extra: true }))).toMatchObject({ code: "INVALID", reason: "VALIDATION" });
  });

  it("[FL-001] OPS sees and never edits; a person of another world reads as missing", async () => {
    const demo = await serviceWorld(DEMO);
    const guest = await serviceWorld(GUEST_07, demo);
    expect(await refusal(upsertPerson(deps(demo), demo.console("OPS", "usr-ops"), newInstaller(phoneOf("0101", 40))))).toMatchObject({ code: "FORBIDDEN", reason: "ROLE_NOT_ALLOWED" });
    expect(await refusal(upsertPerson(deps(guest), guest.console(), { personId: demo.ids.rogelio, firstName: "X", lastName: "Y" }))).toMatchObject({ code: "NOT_FOUND" });
    expect(await refusal(upsertPerson(deps(demo), demo.channel(), newInstaller(phoneOf("0101", 40))))).toMatchObject({ code: "FORBIDDEN", reason: "CALLER_NOT_ALLOWED" });
    expect(await refusal(upsertPerson(deps(demo), { kind: "QA", ispId: demo.ispId, clockId: demo.clockId }, newInstaller(phoneOf("0101", 40))))).toMatchObject({ code: "INVALID", reason: "CALLER_INVALID" });
  });
});

describe("deactivate_person: the allow list switch [FL-008]", () => {
  it("[FL-008] deactivates with a dated history, lists the open orders for reassignment and audits PERSON_DEACTIVATED", async () => {
    const world = await serviceWorld(DEMO);
    const result = await setPersonActive(world.deps, world.console(), { personId: world.ids.rogelio, active: false, reason: "baja de la cuadrilla" });
    expect(result).toMatchObject({ changed: true, person: { active: false }, needsReassignment: [world.ids.order] });
    const stored = await world.deps.connector.people.getPerson(world.ids.rogelio);
    expect(stored?.history.at(-1)).toMatchObject({ field: "active", from: "true", to: "false", actor: "USER:usr-adriana", reason: "baja de la cuadrilla" });
    expect(stored?.history.at(-1)?.atSim).toBeDefined();
    expect((await world.decisions()).filter((row) => row.action === "PERSON_DEACTIVATED")).toMatchObject([{ refs: { personId: world.ids.rogelio }, detail: { openWorkOrders: 1 } }]);
    expect(await setPersonActive(world.deps, world.console(), { personId: world.ids.rogelio, active: false })).toMatchObject({ changed: false });
    expect(await setPersonActive(world.deps, world.console(), { personId: world.ids.rogelio, active: true })).toMatchObject({ changed: true, person: { active: true }, needsReassignment: [] });
  });

  it("[FL-008] OPS cannot deactivate anyone", async () => {
    const world = await serviceWorld(DEMO);
    expect(await refusal(setPersonActive(world.deps, world.console("OPS", "usr-ops"), { personId: world.ids.rogelio, active: false }))).toMatchObject({ code: "FORBIDDEN" });
  });
});
