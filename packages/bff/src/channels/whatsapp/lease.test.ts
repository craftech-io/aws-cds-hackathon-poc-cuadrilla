import { describe, expect, it } from "vitest";
import { esMX } from "../../copy/es-MX";
import { testConnector } from "../../connector/testing";
import { processInboundEvent } from "./inbound";
import { JOIN_CODE_ALPHABET, type LeaseDeps, bindPhoneLease, issueJoinCode, joinCodePrefix, releaseWorldLeases } from "./lease";
import { DEMO, GUEST, PEOPLE, REAL_NOW, hashOf, inboundHarness, liveEvent, seedWorlds, waText } from "./testing";

const GUEST_PHONE = "+12025550120";
const MINUTE = 60_000;

async function setup() {
  const w = testConnector(REAL_NOW);
  await seedWorlds(w);
  const deps: LeaseDeps = { worlds: w.connector.worlds, people: w.connector.people, audit: w.connector.audit };
  const issue = () => issueJoinCode({ clockId: GUEST, personId: PEOPLE.rogelioG07.personId, userId: "usr-guest-07" }, deps);
  return { w, deps, issue };
}

describe("join codes", () => {
  it("[FL-101] the code carries the world's prefix and 4 unambiguous characters, only for guest and QA worlds and people of the world", async () => {
    const { deps, issue } = await setup();
    const { code } = await issue();
    expect(code).toMatch(new RegExp(`^G07-[${JOIN_CODE_ALPHABET}]{4}$`));
    expect(JOIN_CODE_ALPHABET).not.toMatch(/[01ILO]/);
    expect(joinCodePrefix("GUEST#isp-guest-test")).toBe("GTST");
    expect(joinCodePrefix("qa-812-1-sc-17")).toBe("QA");
    await expect(issueJoinCode({ clockId: DEMO, personId: PEOPLE.rogelio.personId, userId: "usr-ops" }, deps)).rejects.toThrow();
    await expect(issueJoinCode({ clockId: GUEST, personId: PEOPLE.rogelio.personId, userId: "usr-guest-07" }, deps)).rejects.toThrow();
  });

  it("[FL-101] a code is used once and lives 30 minutes; the lease lives 48 hours", async () => {
    const { w, deps, issue } = await setup();
    const { code } = await issue();
    const bound = await bindPhoneLease({ code, phoneHash: hashOf(GUEST_PHONE) }, deps);
    expect(bound).toMatchObject({ ok: true, lease: { clockId: GUEST, personId: PEOPLE.rogelioG07.personId }, person: { firstName: "Rogelio" } });
    expect(await bindPhoneLease({ code, phoneHash: hashOf("+12025550121") }, deps)).toEqual({ ok: false, reason: "CODE_INVALID" });
    const late = await issue();
    w.advance(31 * MINUTE);
    expect(await bindPhoneLease({ code: late.code, phoneHash: hashOf("+12025550122") }, deps)).toEqual({ ok: false, reason: "CODE_INVALID" });
    expect(await w.connector.worlds.getPhoneLease(hashOf(GUEST_PHONE))).toBeDefined();
    w.advance(48 * 60 * MINUTE);
    expect(await w.connector.worlds.getPhoneLease(hashOf(GUEST_PHONE))).toBeUndefined();
    expect(await w.connector.audit.listByDecision("isp-guest-07", "ACTION")).toMatchObject([{ action: "PHONE_LEASE_CREATED", refs: { personId: PEOPLE.rogelioG07.personId } }]);
  });

  it("[FL-101] one lease per phone: a phone already bound gets LEASE_CONFLICT", async () => {
    const { w, deps, issue } = await setup();
    await bindPhoneLease({ code: (await issue()).code, phoneHash: hashOf(GUEST_PHONE) }, deps);
    expect(await bindPhoneLease({ code: (await issue()).code, phoneHash: hashOf(GUEST_PHONE) }, deps)).toEqual({ ok: false, reason: "LEASE_CONFLICT" });
    expect(await w.connector.audit.listByDecision("isp-guest-07", "DENY")).toMatchObject([{ action: "PHONE_LEASE", reason: "LEASE_CONFLICT", detail: { conflict: "PHONE_ALREADY_BOUND" } }]);
  });

  it("[FL-101] a phone registered in the live world cannot be bound to a guest's world", async () => {
    const { deps, issue } = await setup();
    expect(await bindPhoneLease({ code: (await issue()).code, phoneHash: hashOf(PEOPLE.rogelio.phone) }, deps)).toEqual({ ok: false, reason: "LEASE_CONFLICT" });
  });

  it("[FL-101] resetting the world releases its leases", async () => {
    const { w, deps, issue } = await setup();
    await bindPhoneLease({ code: (await issue()).code, phoneHash: hashOf(GUEST_PHONE) }, deps);
    expect(await releaseWorldLeases(GUEST, deps)).toBe(1);
    expect(await w.connector.worlds.getPhoneLease(hashOf(GUEST_PHONE))).toBeUndefined();
    expect(await w.connector.worlds.listPhoneLeases(GUEST)).toEqual([]);
    const actions = await w.connector.audit.listByDecision("isp-guest-07", "ACTION");
    expect(actions.map((decision) => [decision.action, decision.reason])).toEqual([
      ["PHONE_LEASE_CREATED", undefined],
      ["PHONE_LEASE_EXPIRED", "WORLD_RESET"],
    ]);
  });
});

describe("ALTA <código> from a real phone", () => {
  it("[FL-101] binds the phone, answers on the live transport and routes its next messages to the guest's world", async () => {
    const h = await inboundHarness();
    const { code } = await issueJoinCode({ clockId: GUEST, personId: PEOPLE.rogelioG07.personId, userId: "usr-guest-07" }, { worlds: h.world.connector.worlds, people: h.world.connector.people, audit: h.world.connector.audit });
    const bind = await processInboundEvent(liveEvent({ messages: [waText(GUEST_PHONE, "wamid.ALTA1", `alta ${code.toLowerCase()}`)] }), h.deps);
    expect(bind.records[0]?.messages).toEqual(["LEASE_BOUND"]);
    expect(h.rec.notices).toMatchObject([{ notice: "leaseBound", text: esMX.leaseBound("Rogelio", 48), clockId: GUEST, recipient: { personId: PEOPLE.rogelioG07.personId, transport: "live" } }]);
    await processInboundEvent(liveEvent({ messages: [waText(GUEST_PHONE, "wamid.ALTA2", "Ya estoy con la señora Treviño")] }), h.deps);
    expect(h.rec.queued).toMatchObject([{ type: "INBOUND_MESSAGE", clockId: GUEST, installerId: PEOPLE.rogelioG07.personId }]);
  });

  it("[FL-101] an unknown or used code, or a phone in use, gets the fixed reply within the limits of unknown numbers", async () => {
    const h = await inboundHarness();
    const invalid = await processInboundEvent(liveEvent({ messages: [waText(GUEST_PHONE, "wamid.ALTA3", "ALTA G07-9ZZZ")] }), h.deps);
    expect(invalid.records[0]?.messages).toEqual(["LEASE_REFUSED"]);
    const inUse = await processInboundEvent(liveEvent({ messages: [waText(PEOPLE.rogelio.phone, "wamid.ALTA4", "ALTA G07-4F2K")] }), h.deps);
    expect(inUse.records[0]?.messages).toEqual(["LEASE_REFUSED"]);
    expect(h.rec.notices.map((notice) => [notice.notice, notice.recipient.transport])).toEqual([
      ["joinCodeInvalid", "live"],
      ["leaseInUse", "live"],
    ]);
    await processInboundEvent(liveEvent({ messages: [waText(GUEST_PHONE, "wamid.ALTA5", "ALTA G07-9ZZY")] }), h.deps);
    expect(h.rec.notices).toHaveLength(2);
  });
});
