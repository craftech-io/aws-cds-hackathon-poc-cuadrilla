// [W5 review B1] The QA seam's writes, as the QaDriver makes them: `guest.capsOverride` writes only the
// limits of its own run's room (the one key of the sign-up its IAM fence opens, infra/qa-driver-fence.ts);
// `signup.start` and `guest.forceExpire` hand their writes to the Lambda that owns them (the Bff's QA seam,
// GuestWorlds' `QA_FORCE_EXPIRE`), which re-check the QA address or the QA room on their side.
import { describe, expect, it } from "vitest";
import { createAccountOp, getGuestAccount } from "../guest/account";
import { qaSlotScope } from "../guest/slots";
import type { QaResponse } from "./contract";
import { memoryDriver, memoryQaPorts } from "./testing";

const USER = "gst-01K80000000000000000000001";
const USER_ID = "usr-g01K80000000000000000000001";
const QA_EMAIL = "success+qa-812-1-1@simulator.amazonses.com";
const refused = (response: QaResponse) => (response.ok ? undefined : response.error);

function seam() {
  const memory = memoryQaPorts({ start: "2026-10-13T15:00:00.000Z" });
  memory.cognito.users.set(USER, { username: USER, status: "CONFIRMED", email: QA_EMAIL, emailVerified: true });
  return { memory, driver: memoryDriver(memory) };
}

async function account(memory: ReturnType<typeof memoryQaPorts>, slotScope: "PUBLIC" | ReturnType<typeof qaSlotScope>): Promise<void> {
  const op = createAccountOp({ userId: USER_ID, guestOrigin: "SIGNUP", ispId: "isp-guest-s261013abcde", clockId: "GUEST#isp-guest-s261013abcde", generation: 1, status: "READY", slotScope }, memory.harness.now());
  await memory.harness.client.transact([op], memory.harness.now().toISOString());
}

describe("the QA seam's writes go through their owners [FL-104] [FL-111] [FL-112]", () => {
  it("[FL-104] [FL-113] signup.start is the Bff's: the run (and its sub-scope) and the form, never a write of the driver", async () => {
    const { memory, driver } = seam();
    const started = await driver({ action: "signup.start", idempotencyKey: "812-1/sc-20/1/m1", input: { email: QA_EMAIL, contactAccepted: true } });
    expect(started).toMatchObject({ ok: true, result: { username: expect.stringMatching(/^gst-/), ticket: "ticket-1" } });
    await driver({ action: "signup.start", idempotencyKey: "812-1/sc-20/8/m1", input: { email: "success+qa-812-1-ip0@simulator.amazonses.com", scope: "s8" } });
    expect(memory.starts.map((request) => [request.runId, request.form.email])).toEqual([
      ["812-1", QA_EMAIL],
      ["812-1-s8", "success+qa-812-1-ip0@simulator.amazonses.com"],
    ]);
    expect(memory.starts[0]?.form).toMatchObject({ consents: { TERMS_PRIVACY: { accepted: true }, CONTACT: { accepted: true } } });
    // Only the driver's own idempotency marks: no counter of the sign-up written by the driver.
    expect(memory.harness.client.dump("Runtime").filter((row) => String(row.PK).startsWith("SIGNUP"))).toEqual([]);
  });

  it("[FL-111] guest.forceExpire ends the generation of an account of a QA run's room, through GuestWorlds' QA_FORCE_EXPIRE", async () => {
    const { memory, driver } = seam();
    await account(memory, qaSlotScope("812-1"));
    const expired = await driver({ action: "guest.forceExpire", idempotencyKey: "812-1/sc-20/6/m1", input: { username: USER } });
    expect(expired).toMatchObject({ ok: true, result: { userId: USER_ID, clockId: "GUEST#isp-guest-s261013abcde" } });
    const row = await getGuestAccount(memory.harness.client, USER_ID);
    expect(Date.parse(row?.expiresAtReal ?? "")).toBeLessThan(memory.harness.now().getTime());
    expect(row).toMatchObject({ status: "READY", slotScope: "QA#qa-812-1", generation: 1 });
  });

  it("[FL-111] guest.forceExpire refuses an account of the public room even when Cognito holds a QA address, and a missing one", async () => {
    const { memory, driver } = seam();
    expect(refused(await driver({ action: "guest.forceExpire", idempotencyKey: "812-1/sc-20/6/m1", input: { username: USER } }))).toMatchObject({ code: "NOT_FOUND", reason: "NO_ACCOUNT" });
    await account(memory, "PUBLIC");
    const before = await getGuestAccount(memory.harness.client, USER_ID);
    expect(refused(await driver({ action: "guest.forceExpire", idempotencyKey: "812-1/sc-20/6/m2", input: { username: USER } }))).toMatchObject({ code: "FORBIDDEN", reason: "NOT_A_QA_ADDRESS" });
    expect(await getGuestAccount(memory.harness.client, USER_ID)).toEqual(before);
  });

  it("[FL-112] guest.capsOverride writes the limits of its own run's room only", async () => {
    const { memory, driver } = seam();
    expect(await driver({ action: "guest.capsOverride", idempotencyKey: "812-1/sc-20/7/m1", input: { activeWorlds: 0 } })).toMatchObject({ ok: true, result: { activeWorlds: 0, confirmedPerDay: 150 } });
    const rows = memory.harness.client.dump("Runtime").filter((row) => String(row.PK).startsWith("GUESTWORLDS#"));
    expect(rows).toEqual([expect.objectContaining({ PK: "GUESTWORLDS#QA#qa-812-1#LIMITS", SK: "META", activeWorlds: 0 })]);
  });
});
