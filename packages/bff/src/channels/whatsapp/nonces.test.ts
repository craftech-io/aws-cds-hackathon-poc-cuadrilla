import { describe, expect, it } from "vitest";
import { esMX } from "../../copy/es-MX";
import { testConnector } from "../../connector/testing";
import { processInboundEvent } from "./inbound";
import { INSTALLER_BUTTONS, SUPERVISOR_BUTTONS } from "./keywords";
import { type NonceDeps, isIssuedNonce, issueNonce, resolveNonce } from "./nonces";
import { DEMO, JUDGE, NONCE_KEY, PEOPLE, REAL_NOW, hashOf, inboundHarness, liveEvent, nonceFor, seedWorlds, waReply } from "./testing";

const SEVEN_DAYS_MS = 7 * 24 * 3600 * 1000;
const ROGELIO = PEOPLE.rogelio;

async function setup() {
  const w = testConnector(REAL_NOW);
  await seedWorlds(w);
  const deps: NonceDeps = { runtime: w.connector.runtime, nonceKey: NONCE_KEY, realClock: { now: async () => w.now() } };
  const nonce = await issueNonce({ clockId: DEMO, personId: ROGELIO.personId, phoneHash: hashOf(ROGELIO.phone), action: "CLOSE_INSTALLATION", object: { kind: "WORK_ORDER", id: "wo-24817" } }, deps);
  return { w, deps, nonce };
}

const asRogelio = (payload: string) => ({ payload, clockId: DEMO, phoneHash: hashOf(ROGELIO.phone), allowedActions: INSTALLER_BUTTONS });

describe("button nonces", () => {
  it("[FL-094] a nonce is bound to the phone, the world, the object and the action, and counts its taps", async () => {
    const { w, deps, nonce } = await setup();
    expect(nonce).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}_[A-Za-z0-9_-]{16}$/);
    expect(isIssuedNonce(nonce, NONCE_KEY)).toBe(true);
    const resolved = await resolveNonce(asRogelio(nonce), deps);
    expect(resolved).toMatchObject({ ok: true, nonce: { action: "CLOSE_INSTALLATION", object: { kind: "WORK_ORDER", id: "wo-24817" }, useCount: 1 } });
    expect((await w.connector.runtime.getNonce(nonce))?.phoneHash).toBe(hashOf(ROGELIO.phone));
  });

  it("[FL-094] another person's button, or the same phone in another world, is foreign", async () => {
    const { deps, nonce } = await setup();
    expect(await resolveNonce({ ...asRogelio(nonce), phoneHash: hashOf(PEOPLE.julian.phone) }, deps)).toEqual({ ok: false, reason: "NONCE_FOREIGN" });
    expect(await resolveNonce({ ...asRogelio(nonce), clockId: JUDGE }, deps)).toEqual({ ok: false, reason: "NONCE_FOREIGN" });
  });

  it("[FL-094] a button of another role is refused: an installer cannot tap a supervisor's action", async () => {
    const { deps } = await setup();
    const take = await issueNonce({ clockId: DEMO, personId: ROGELIO.personId, phoneHash: hashOf(ROGELIO.phone), action: "TAKE_CASE", object: { kind: "CASE", id: "case-01J9ZQX0000000000000000000" } }, deps);
    expect(await resolveNonce(asRogelio(take), deps)).toEqual({ ok: false, reason: "NONCE_ACTION" });
    expect(SUPERVISOR_BUTTONS).toContain("TAKE_CASE");
  });

  it("[FL-094] a payload we never issued is forged; after 7 days, or expired by the QaDriver, it is expired", async () => {
    const { w, deps, nonce } = await setup();
    expect(await resolveNonce(asRogelio("01J9ZQX0000000000000000000_AAAAAAAAAAAAAAAA"), deps)).toEqual({ ok: false, reason: "NONCE_FORGED" });
    expect(await resolveNonce(asRogelio("TAKE_CASE"), deps)).toEqual({ ok: false, reason: "NONCE_FORGED" });
    const other = await issueNonce({ clockId: DEMO, personId: ROGELIO.personId, phoneHash: hashOf(ROGELIO.phone), action: "CUSTOMER_OK", object: { kind: "WORK_ORDER", id: "wo-24817" } }, deps);
    await w.connector.runtime.expireNonce(other);
    expect(await resolveNonce(asRogelio(other), deps)).toEqual({ ok: false, reason: "NONCE_EXPIRED" });
    w.advance(SEVEN_DAYS_MS + 1000);
    expect(await resolveNonce(asRogelio(nonce), deps)).toEqual({ ok: false, reason: "NONCE_EXPIRED" });
  });

  it("[FL-094] a refused tap gets the fixed reply, DENY NONCE_* in the audit log and no effect", async () => {
    const h = await inboundHarness();
    const julians = await nonceFor(h, "julian", "CLOSE_INSTALLATION", { kind: "WORK_ORDER", id: "wo-24817" });
    const result = await processInboundEvent(liveEvent({ messages: [waReply(ROGELIO.phone, "wamid.N1", julians, "Cerrar instalación")] }), h.deps);
    expect(result.records[0]?.messages).toEqual(["BUTTON_REFUSED"]);
    expect(h.rec.notices).toMatchObject([{ notice: "buttonExpired", text: esMX.buttonExpired }]);
    expect(h.rec.actions).toEqual([]);
    expect(h.rec.queued).toEqual([]);
    expect(await h.world.connector.audit.listByDecision("isp-demo", "DENY")).toMatchObject([{ action: "BUTTON_TAP", reason: "NONCE_FOREIGN", messageId: "wamid.N1" }]);
  });
});
