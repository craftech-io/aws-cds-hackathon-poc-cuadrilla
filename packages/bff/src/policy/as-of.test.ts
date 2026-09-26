import { describe, expect, it } from "vitest";
import { CLOCK, ISP, openCase } from "../connector/testing";
import type { HistoryEntry, NewEntity } from "../domain/common";
import type { Message } from "../domain/conversations";
import type { Consent } from "../domain/people";
import { POLICY_REFS_KEY, evaluateSentAsOf, policyRefs } from "./as-of";
import { policyInputAt } from "./context";
import { consentAt, valueAt } from "./history";
import { loadPolicyRecords } from "./records";
import { CASE_ID, REAL_NOW, at, facts, input, installer, mx, policyWorld, reply, summary, system } from "./testing";

const entry = (overrides: Partial<HistoryEntry>): HistoryEntry => ({ field: "consent", to: "GRANTED", atReal: "2026-11-01T00:00:00.000Z", actor: "SYSTEM", ...overrides });

function outbound(overrides: Partial<NewEntity<typeof Message>>): NewEntity<typeof Message> {
  return {
    messageId: "msg-out-1",
    personId: "inst-rogelio",
    ispId: ISP,
    clockId: CLOCK,
    direction: "OUT",
    channel: "WHATSAPP",
    content: "TEXT",
    status: "SENT",
    author: "SYSTEM",
    simulated: true,
    transport: "simulated",
    sentAtSim: mx("2026-10-13 07:30"),
    ...overrides,
  };
}

const dayStartMessage = (messageId: string, local: string) => outbound({ messageId, kind: "DAY_START", content: "TEMPLATE", templateName: "ordenes_del_dia", sentAtSim: mx(local) });

async function reevaluate(world: Awaited<ReturnType<typeof policyWorld>>, stored: Message, extra: { workOrderId?: string } = {}) {
  const records = await loadPolicyRecords(world.connector, { ispId: ISP, personId: stored.personId, route: "SIMULATED", ...extra, at: { sim: stored.sentAtSim, real: stored.sentAtReal ?? stored.sentAtSim } });
  return summary(evaluateSentAsOf(stored, records));
}

describe("the value of a record at a past instant", () => {
  const history = [entry({ to: "GRANTED", atSim: mx("2026-10-01 08:00") }), entry({ from: "GRANTED", to: "REVOKED", atSim: mx("2026-10-13 12:00") })];

  it("undoes the transitions after the instant", () => {
    expect(valueAt(history, "consent", "REVOKED", at("2026-09-30 00:00"))).toBeUndefined();
    expect(valueAt(history, "consent", "REVOKED", at("2026-10-13 07:30"))).toBe("GRANTED");
    expect(valueAt(history, "consent", "REVOKED", at("2026-10-13 12:00"))).toBe("REVOKED");
    expect(valueAt(history, "active", "true", at("2026-10-13 07:30"))).toBe("true");
  });

  it("compares a transition without a simulated instant on real time", () => {
    const console = [entry({ field: "active", from: "true", to: "false", atReal: "2026-11-02T12:00:00.000Z" })];
    expect(valueAt(console, "active", "false", at("2026-10-13 09:00", "2026-11-02T11:59:59.000Z"))).toBe("true");
    expect(valueAt(console, "active", "false", at("2026-10-13 09:00", "2026-11-02T12:00:00.000Z"))).toBe("false");
  });

  it("dates a seeded consent without history by its own instants", () => {
    const seeded = { status: "REVOKED", grantedAtSim: mx("2026-10-01 08:00"), revokedAtSim: mx("2026-10-12 18:00"), history: [] } as unknown as Consent;
    expect(consentAt(seeded, at("2026-09-30 00:00"))).toBe("NONE");
    expect(consentAt(seeded, at("2026-10-12 09:00"))).toBe("GRANTED");
    expect(consentAt(seeded, at("2026-10-13 07:30"))).toBe("REVOKED");
    expect(consentAt(undefined, at("2026-10-13 07:30"))).toBe("NONE");
  });
});

describe("re-evaluating a sent message with the records of its instant (PolicyAudit)", () => {
  it("does not count a BAJA after the send, and denies what was sent before the ALTA", async () => {
    const world = await policyWorld();
    const { people, conversations } = world.connector;
    const sent = await conversations.appendMessage(dayStartMessage("msg-ds-13", "2026-10-13 07:30"));
    await people.revokeConsent("inst-rogelio", { actor: "PERSON:inst-rogelio", atSim: mx("2026-10-13 12:00") });
    expect(await reevaluate(world, sent)).toBe("ALLOW");
    const early = await conversations.appendMessage(dayStartMessage("msg-ds-09-30", "2026-09-30 07:30"));
    expect(await reevaluate(world, early)).toBe("DENY CP-OPTIN NO_OPT_IN");
  });

  it("never counts the audited message as the day's DAY_START, but finds a second one", async () => {
    const world = await policyWorld();
    const first = await world.connector.conversations.appendMessage(dayStartMessage("msg-ds-a", "2026-10-13 07:30"));
    const second = await world.connector.conversations.appendMessage(dayStartMessage("msg-ds-b", "2026-10-13 09:00"));
    expect(await reevaluate(world, first)).toBe("ALLOW");
    expect(await reevaluate(world, second)).toBe("DENY CP-ONE-DAYSTART DAY_START_ALREADY_SENT");
  });

  it("measures the window from the inbound messages before the send, not after", async () => {
    const world = await policyWorld();
    const { conversations, people } = world.connector;
    const inbound = (messageId: string, local: string) => conversations.appendMessage(outbound({ messageId, direction: "IN", author: "PERSON:inst-rogelio", sentAtSim: mx(local), status: "RECEIVED" }));
    await inbound("wamid.SIM.1", "2026-10-12 09:00");
    await inbound("wamid.SIM.2", "2026-10-13 10:00");
    await people.recordInbound("inst-rogelio", { atSim: mx("2026-10-13 10:00") });
    const late = await conversations.appendMessage(outbound({ messageId: "msg-reply-late", kind: "REPLY", author: "AGENT", text: "¿Ya quedó?", workOrderId: "wo-24817", sentAtSim: mx("2026-10-13 09:30") }));
    expect(await reevaluate(world, late, { workOrderId: "wo-24817" })).toBe("DENY CP-WA-24H WINDOW_CLOSED");
    const inside = await conversations.appendMessage(outbound({ messageId: "msg-reply-ok", kind: "REPLY", author: "AGENT", text: "¿Ya quedó?", workOrderId: "wo-24817", sentAtSim: mx("2026-10-13 10:05") }));
    expect(await reevaluate(world, inside, { workOrderId: "wo-24817" })).toBe("ALLOW");
  });

  it("reads the template state and the bridge as they were at the send", async () => {
    const world = await policyWorld();
    const { cases, conversations, isps } = world.connector;
    const sent = await conversations.appendMessage(dayStartMessage("msg-ds-plan-b", "2026-10-13 07:30"));
    await isps.setTemplateStatus(ISP, "ordenes_del_dia", "REJECTED", { actor: "USER:usr-judge-test", atSim: mx("2026-10-13 09:00") });
    expect(await reevaluate(world, sent)).toBe("ALLOW");

    await cases.createCase(openCase({ caseId: CASE_ID, workOrderId: "wo-24817", createdAtSim: mx("2026-10-13 11:50") }));
    await cases.takeCase(CASE_ID, "sup-hector", { actor: "PERSON:sup-hector", atSim: mx("2026-10-13 12:05") });
    const agentReply = (messageId: string, local: string) =>
      conversations.appendMessage(outbound({ messageId, kind: "REPLY", author: "AGENT", text: "Voy a revisar tu orden.", workOrderId: "wo-24817", sentAtSim: mx(local), refs: { [POLICY_REFS_KEY]: { form: "TEXT", author: "AGENT", inResponseToInbound: true } } }));
    await world.connector.people.recordInbound("inst-rogelio", { atSim: mx("2026-10-13 11:54") });
    expect(await reevaluate(world, await agentReply("msg-before-take", "2026-10-13 11:55"), { workOrderId: "wo-24817" })).toBe("ALLOW");
    expect(await reevaluate(world, await agentReply("msg-after-take", "2026-10-13 12:10"), { workOrderId: "wo-24817" })).toBe("DENY CP-BRIDGE BRIDGE_ACTIVE");
  });

  it("uses what the pipeline stored in refs.policy, and is stricter without it", async () => {
    const world = await policyWorld();
    const { conversations, people } = world.connector;
    await people.recordInbound("inst-rogelio", { atSim: mx("2026-10-13 21:40") });
    const night = { kind: "REPLY" as const, author: "AGENT" as const, text: "Mañana a primera hora.", workOrderId: "wo-24817", sentAtSim: mx("2026-10-13 21:45") };
    const refs = policyRefs(input({ message: reply({ text: night.text }), facts: facts({ now: at("2026-10-13 21:45") }) }));
    expect(refs).toEqual({ form: "TEXT", author: "AGENT", route: "SIMULATED", inResponseToInbound: true });
    const withRefs = await conversations.appendMessage(outbound({ messageId: "msg-night-refs", ...night, refs: { [POLICY_REFS_KEY]: refs } }));
    expect(await reevaluate(world, withRefs, { workOrderId: "wo-24817" })).toBe("ALLOW");
    const bare = await conversations.appendMessage(outbound({ messageId: "msg-night-bare", ...night }));
    expect(await reevaluate(world, bare, { workOrderId: "wo-24817" })).toBe("DEFER CP-QUIET-HOURS QUIET_HOURS");
  });

  it("checks the citations of a reply against the sections the pipeline kept, after the turn's results expired", async () => {
    const world = await policyWorld();
    await world.connector.people.recordInbound("inst-rogelio", { atSim: mx("2026-10-13 10:10") });
    const cited = { kind: "REPLY" as const, author: "AGENT" as const, text: "Hasta 15 m no tiene costo (Manual v1, §COM-04).", workOrderId: "wo-24817", sentAtSim: mx("2026-10-13 10:11"), turnId: "turn-expired" };
    const stored = (messageId: string, turnSections?: string[]) =>
      world.connector.conversations.appendMessage(
        outbound({ messageId, ...cited, refs: { [POLICY_REFS_KEY]: { form: "TEXT", author: "AGENT", claimsPolicy: true, inResponseToInbound: true, ...(turnSections ? { turnSections } : {}) } } }),
      );
    const load = async (message: Message) => evaluateSentAsOf(message, await loadPolicyRecords(world.connector, { ispId: ISP, personId: "inst-rogelio", route: "SIMULATED", workOrderId: "wo-24817", turnId: "turn-expired", at: { sim: message.sentAtSim, real: REAL_NOW } }));
    expect(summary(await load(await stored("msg-cited-kept", ["COM-04", "COM-02"])))).toBe("ALLOW");
    expect(summary(await load(await stored("msg-cited-other", ["DIAG-02"])))).toBe("DENY CP-CITATION CITATION_NOT_IN_TURN");
    expect(summary(await load(await stored("msg-cited-lost")))).toBe("DENY CP-CITATION TURN_SECTIONS_UNKNOWN");
  });

  it("re-evaluates a leased phone on the real clock of its send", async () => {
    const world = await policyWorld();
    const sentAtReal = "2026-11-02T18:00:00.000Z";
    const relay = await world.connector.conversations.appendMessage(
      outbound({ messageId: "msg-relay-live", kind: "RELAY", author: "PERSON:sup-hector", text: "Héctor (supervisor): cambia el conector.", simulated: false, transport: "live", sentAtSim: mx("2026-10-13 12:10"), sentAtReal }),
    );
    const records = await loadPolicyRecords(world.connector, { ispId: ISP, personId: "inst-rogelio", route: "PHONE_LEASE", at: { sim: relay.sentAtSim, real: sentAtReal } });
    const lease = { entity: "PhoneLease", phoneHash: "e".repeat(64), clockId: CLOCK, personId: "inst-rogelio", boundAtReal: "2026-11-01T00:00:00.000Z", createdAt: sentAtReal, updatedAt: sentAtReal, version: 1, synthetic: false } as const;
    const decide = (lastInboundAtReal: string) => summary(evaluateSentAsOf(relay, { ...records, lease: { ...lease, lastInboundAtReal } }));
    expect(decide("2026-11-01T17:00:00.000Z")).toBe("DENY CP-WA-24H WINDOW_CLOSED");
    expect(decide("2026-11-02T16:00:00.000Z")).toBe("ALLOW");
  });
});

describe("the policy input built from the records", () => {
  it("is the one a direct evaluation takes: the same person, clocks and world", async () => {
    const world = await policyWorld();
    await world.connector.people.recordInbound("inst-rogelio", { atSim: mx("2026-10-13 09:20") });
    const when = { sim: mx("2026-10-13 09:21"), real: REAL_NOW };
    const records = await loadPolicyRecords(world.connector, { ispId: ISP, personId: "inst-rogelio", route: "SIMULATED", workOrderId: "wo-24817", at: when });
    const built = policyInputAt(reply(), { kind: "PERSON", route: "SIMULATED" }, records, when);
    expect(built.recipient).toEqual({ ...installer(), lastInboundAtSim: mx("2026-10-13 09:20") });
    expect(built.facts).toMatchObject({ now: when, world: { clockId: CLOCK, timezone: "America/Mexico_City", quietHours: { start: "21:00", end: "07:00" } }, bridgeActive: false, dayStartsSentAtSim: [] });
    expect(() => policyInputAt(system("CASE_NOTICE"), { kind: "PERSON", route: "SIMULATED" }, { settings: records.settings }, when)).toThrow(RangeError);
  });
});
