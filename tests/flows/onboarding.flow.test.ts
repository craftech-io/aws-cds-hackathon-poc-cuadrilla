// Area A · Sign-up and registration (docs/flows-catalog.md FL-002 to FL-005 and FL-101), in process: the
// simulator's signed envelope (or a live SNS event) into `InboundWhatsApp`, the keyword handlers, the
// installer queue and the worker, over the seed's demo world and the rehearsal guest world.
import { describe, expect, it } from "vitest";
import { esMX } from "../../packages/bff/src/copy/es-MX";
import { issueJoinCode } from "../../packages/bff/src/channels/whatsapp/lease";
import { resetWorld } from "../../packages/bff/src/worlds/rebuild";
import { GUEST_TEST_CLOCK, createFlowWorld } from "./support/world";

const UNKNOWN = "+525501990001";
/** A real phone, as a guest's own phone would be (never one of the synthetic blocks). */
const REAL_PHONE = "+5215587654321";

describe("onboarding flows", () => {
  it("[FL-002] ALTA from an allow-listed number without opt-in records the consent and welcomes, with no agent turn", async () => {
    const world = await createFlowWorld();
    await world.at("08:00");
    await world.text("inst-julian", "ALTA");
    const consent = await world.data.people.getConsent("inst-julian");
    expect(consent).toMatchObject({ status: "GRANTED", medium: "WHATSAPP_KEYWORD", textVersion: "v001" });
    expect(consent?.history.at(-1)).toMatchObject({ to: "GRANTED" });
    const notices = await world.outbound("inst-julian", "SYSTEM_NOTICE");
    expect(notices).toHaveLength(1);
    expect(notices[0]?.text).toBe(esMX.welcome("Julián", "INSTALLER"));
    expect(world.harness.turns).toHaveLength(0);
  });

  it("[FL-003] a message before ALTA gets the fixed opt-in notice, DENY CP-OPTIN and no turn", async () => {
    const world = await createFlowWorld();
    await world.at("08:00");
    await world.text("inst-julian", "Hola, ¿qué órdenes tengo?");
    const thread = (await world.thread("inst-julian")).filter((message) => message.sentAtSim >= "2026-10-13T14:00:00.000Z");
    expect(thread.map((message) => [message.direction, message.kind ?? null])).toEqual([
      ["IN", null],
      ["OUT", "SYSTEM_NOTICE"],
    ]);
    expect(thread[1]?.text).toBe(esMX.optInRequired);
    const denied = (await world.decisions()).filter((decision) => decision.action === "AGENT_TURN" && decision.decision === "DENY");
    expect(denied.map((decision) => decision.ruleIds)).toEqual([["CP-OPTIN"]]);
    expect(world.harness.turns).toHaveLength(0);
    expect(await world.data.runtime.getIdempotency("TURN_RAN", thread[0]?.messageId ?? "")).toBeUndefined();
  });

  it("[FL-004] an unknown number gets one fixed notice per simulated day, its body is never stored and nothing reaches the agent", async () => {
    const world = await createFlowWorld();
    await world.at("08:00");
    const body = "Hola, quiero contratar internet en mi casa";
    const first = await world.sendFrom(UNKNOWN, { type: "text", body });
    const second = await world.sendFrom(UNKNOWN, { type: "text", body });
    expect(first.result.records[0]?.messages).toEqual(["UNKNOWN_SENDER"]);
    expect(second.result.records[0]?.messages).toEqual(["UNKNOWN_SENDER"]);
    const unknown = (await world.decisions()).filter((decision) => decision.action === "UNKNOWN_SENDER");
    expect(unknown.map((decision) => [decision.decision, decision.ruleIds, decision.detail?.replied])).toEqual([
      ["DENY", ["CP-ALLOWLIST"], true],
      ["DENY", ["CP-ALLOWLIST"], false],
    ]);
    const stored = JSON.stringify(world.memory.client.dump("Conversations"));
    expect(stored).not.toContain("contratar internet");
    expect(world.harness.turns).toHaveLength(0);
    expect(world.queue.sent.filter((event) => event.type === "INBOUND_MESSAGE")).toEqual([]);
    // A new simulated day: one more notice.
    await world.advance({ to: "2026-10-14T14:00:00.000Z" });
    await world.sendFrom(UNKNOWN, { type: "text", body });
    expect((await world.decisions()).filter((decision) => decision.action === "UNKNOWN_SENDER").map((decision) => decision.detail?.replied)).toEqual([true, false, true]);
  });

  it("[FL-005] BAJA revokes the consent with its history, confirms once, and the next day start is denied by CP-OPTOUT", async () => {
    const world = await createFlowWorld();
    await world.at("07:10");
    await world.text("inst-karina", "BAJA");
    const consent = await world.data.people.getConsent("inst-karina");
    expect(consent?.status).toBe("REVOKED");
    expect(consent?.history.map((entry) => entry.to)).toEqual(["GRANTED", "REVOKED"]);
    expect((await world.delivered("inst-karina", "SYSTEM_NOTICE")).map((message) => message.text)).toEqual([esMX.optOutConfirmed]);
    await world.at("07:30");
    expect(await world.delivered("inst-karina", "DAY_START")).toEqual([]);
    const denied = await world.outbound("inst-karina", "DAY_START");
    expect(denied.map((message) => [message.status, message.policy?.ruleIds])).toEqual([["DENIED", ["CP-OPTOUT"]]]);
    expect(await world.delivered("inst-rogelio", "DAY_START")).toHaveLength(1);
  });

  describe("[FL-101] sign-up of a real phone by code in a guest world", () => {
    async function bound() {
      const world = await createFlowWorld({ live: true });
      const data = world.data;
      const code = await issueJoinCode({ clockId: GUEST_TEST_CLOCK, personId: "inst-rogelio-gtest", userId: "usr-guest-test" }, { worlds: data.worlds, people: data.people, audit: data.audit });
      const sent = await world.sendLive(REAL_PHONE, `ALTA ${code.code}`);
      return { world, code: code.code, sent, hash: world.stage.hashPhone(REAL_PHONE) };
    }

    it("[FL-101] binds the phone to the person with a 48 h lease and audits it", async () => {
      const { world, sent, hash } = await bound();
      expect(sent.result.records[0]?.messages).toEqual(["LEASE_BOUND"]);
      const lease = await world.data.worlds.getPhoneLease(hash);
      expect(lease).toMatchObject({ clockId: GUEST_TEST_CLOCK, personId: "inst-rogelio-gtest" });
      expect(Number(lease?.expiresAt) * 1_000 - Date.parse(lease?.boundAtReal ?? "")).toBe(48 * 3_600_000);
      expect((await world.decisions("isp-guest-test")).some((decision) => decision.action === "PHONE_LEASE_CREATED")).toBe(true);
    });

    it("[FL-101] the bound phone's messages enter the guest world as the person, and the lease keeps the real time of the last one", async () => {
      const { world, hash } = await bound();
      const before = (await world.data.worlds.getPhoneLease(hash))?.lastInboundAtReal;
      world.advanceReal(60_000);
      await world.sendLive(REAL_PHONE, "Hola");
      const lease = await world.data.worlds.getPhoneLease(hash);
      expect(Date.parse(lease?.lastInboundAtReal ?? "")).toBeGreaterThan(Date.parse(before ?? "1970-01-01T00:00:00Z"));
      const inbound = (await world.thread("inst-rogelio-gtest")).filter((message) => message.direction === "IN" && message.transport === "live");
      expect(inbound.map((message) => message.text)).toEqual(["Hola"]);
    });

    it("[FL-101] what the person of a bound phone receives goes out on the live transport, with CP-QUIET-HOURS NOT_APPLICABLE_LEASE", async () => {
      const { world } = await bound();
      expect(JSON.stringify(world.social.sent)).toContain("ligado a la demo como Rogelio");
      await world.sendLive(REAL_PHONE, "Hola");
      const answer = (await world.decisions("isp-guest-test")).filter((decision) => decision.action === "SEND_WHATSAPP" && decision.decision === "ALLOW").at(-1);
      expect(answer?.evaluated.find((rule) => rule.ruleId === "CP-QUIET-HOURS")?.result).toBe("NOT_APPLICABLE_LEASE");
      expect((await world.thread("inst-rogelio-gtest")).filter((message) => message.direction === "OUT" && message.transport === "simulated" && message.sentAtSim > "2026-10-13")).toEqual([]);
    });

    it("[FL-101] a used code and a phone already bound are refused; resetting the demo removes the lease", async () => {
      const { world, code, hash } = await bound();
      const reused = await world.sendLive("+5215511112222", `ALTA ${code}`);
      expect(reused.result.records[0]?.messages).toEqual(["LEASE_REFUSED"]);
      expect(await world.data.worlds.getPhoneLease(world.stage.hashPhone("+5215511112222"))).toBeUndefined();
      const data = world.data;
      const other = await issueJoinCode({ clockId: GUEST_TEST_CLOCK, personId: "inst-karina-gtest", userId: "usr-guest-test" }, { worlds: data.worlds, people: data.people, audit: data.audit });
      const again = await world.sendLive(REAL_PHONE, `ALTA ${other.code}`);
      expect(again.result.records[0]?.messages).toEqual(["LEASE_REFUSED"]);
      expect((await world.data.worlds.getPhoneLease(hash))?.personId).toBe("inst-rogelio-gtest");
      await resetWorld(world.worlds, { clockId: GUEST_TEST_CLOCK, caller: "CONSOLE", actor: "USER:usr-guest-test" });
      expect(await world.data.worlds.getPhoneLease(hash)).toBeUndefined();
    });
  });
});
