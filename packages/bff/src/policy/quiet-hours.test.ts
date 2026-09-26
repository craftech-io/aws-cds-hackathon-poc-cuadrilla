import { describe, expect, it } from "vitest";
import { ruleEntry } from "./engine";
import { toDecisionInput, toPolicyResult } from "./result";
import { CASE_ID, OTHER_CASE_ID, at, decide, facts, installer, mx, reply, summary, supervisor, system } from "./testing";

// A dispatch change at night produces a proactive notice: an agent turn WORK_ORDER_CHANGED, which
// answers no inbound of the installer.
const dispatchNotice = reply({ text: "Tu orden 24819 cambió al miércoles de 09:00 a 11:00.", inResponseToInbound: false });
/** Rogelio wrote at 21:50, so his window is open when dispatch reschedules at 22:00 (SC-11/3). */
const wroteAt2150 = installer({ lastInboundAtSim: mx("2026-10-13 21:50") });

describe("[FL-073] quiet hours: 21:00-07:00 America/Mexico_City", () => {
  it("defers a proactive message at 22:00 until 07:00 of the next day, without dropping it", () => {
    const decision = decide({ message: dispatchNotice, recipient: wroteAt2150, facts: facts({ now: at("2026-10-13 22:00") }) });
    expect(summary(decision)).toBe("DEFER CP-QUIET-HOURS QUIET_HOURS");
    expect(decision).toMatchObject({ allowed: false, nextAllowedAt: mx("2026-10-14 07:00"), nextAllowedClock: "WORLD" });
    expect(ruleEntry(decision, "CP-QUIET-HOURS")).toEqual({ ruleId: "CP-QUIET-HOURS", result: "FAIL", clock: "WORLD", detail: "quiet 21:00-07:00 America/Mexico_City" });
    expect(toPolicyResult(decision)).toEqual({ allowed: false, ruleIds: ["CP-QUIET-HOURS"], reason: "QUIET_HOURS", nextAllowedAt: mx("2026-10-14 07:00") });
    const row = toDecisionInput(decision, { ispId: "isp-demo", action: "SEND_WHATSAPP", actor: "SYSTEM" });
    expect(row).toMatchObject({ decision: "DEFER", detail: { nextAllowedAt: mx("2026-10-14 07:00"), nextAllowedClock: "WORLD" } });
  });

  it("lets it go when the deferred send is re-evaluated at 07:00", () => {
    const decision = decide({ message: dispatchNotice, recipient: wroteAt2150, facts: facts({ now: at("2026-10-14 07:00") }) });
    expect(summary(decision)).toBe("ALLOW");
    expect(ruleEntry(decision, "CP-QUIET-HOURS")).toEqual({ ruleId: "CP-QUIET-HOURS", result: "PASS", clock: "WORLD" });
  });

  it("starts at 21:00 sharp and ends at 07:00 sharp; before dawn it waits for the same day's 07:00", () => {
    expect(summary(decide({ message: dispatchNotice, recipient: wroteAt2150, facts: facts({ now: at("2026-10-13 20:59") }) }))).toBe("ALLOW");
    expect(summary(decide({ message: dispatchNotice, recipient: wroteAt2150, facts: facts({ now: at("2026-10-13 21:00") }) }))).toBe("DEFER CP-QUIET-HOURS QUIET_HOURS");
    const beforeDawn = decide({ message: dispatchNotice, recipient: installer({ lastInboundAtSim: mx("2026-10-14 05:00") }), facts: facts({ now: at("2026-10-14 06:30") }) });
    expect(beforeDawn.nextAllowedAt).toBe(mx("2026-10-14 07:00"));
  });

  it("reads the world's own window and zone", () => {
    const tijuana = facts({ now: { sim: "2026-10-14T05:30:00.000Z", real: "2026-11-02T18:00:00.000Z" }, world: { clockId: "GLOBAL#isp-demo", timezone: "America/Tijuana", quietHours: { start: "22:00", end: "06:00" } } });
    // 22:30 in Tijuana (UTC−7) → 06:00 of the next local day = 13:00Z.
    const decision = decide({ message: dispatchNotice, recipient: installer({ lastInboundAtSim: "2026-10-14T05:00:00.000Z" }), facts: tijuana });
    expect(decision).toMatchObject({ outcome: "DEFER", nextAllowedAt: "2026-10-14T13:00:00.000Z" });
  });

  it("does not apply to email", () => {
    const alert = system("ZONE_CHIEF_ALERT", { channel: "EMAIL", form: "EMAIL", caseId: CASE_ID, text: "Caso sin atender." });
    const decision = decide({ message: alert, recipient: { kind: "EMAIL", role: "ZONE_CHIEF", fence: { allowed: true } }, facts: facts({ now: at("2026-10-13 23:00") }) });
    expect(summary(decision)).toBe("ALLOW");
    expect(ruleEntry(decision, "CP-QUIET-HOURS")).toEqual({ ruleId: "CP-QUIET-HOURS", result: "NOT_APPLICABLE" });
  });
});

describe("[FL-071] safety and open cases go out at night", () => {
  const night = (overrides: Parameters<typeof facts>[0] = {}) => facts({ now: at("2026-10-13 21:30"), ...overrides });
  const onDutyRoster = { primaryId: "sup-adriana", secondaryId: "sup-hector" };

  it("sends the fixed safety instruction and the safety alert at 21:30 (exempt)", () => {
    const instruction = decide({ message: system("SAFETY_INSTRUCTION", { text: "No toques el cable ni la escalera.", workOrderId: "wo-24819" }), recipient: wroteAt2150, facts: night() });
    expect(summary(instruction)).toBe("ALLOW");
    expect(ruleEntry(instruction, "CP-QUIET-HOURS")).toEqual({ ruleId: "CP-QUIET-HOURS", result: "NOT_APPLICABLE", clock: "WORLD", detail: "exempt: safety" });
    const alert = system("SAFETY_ALERT", { form: "TEMPLATE", templateName: "alerta_seguridad", caseId: CASE_ID, workOrderId: "wo-24819" });
    expect(summary(decide({ message: alert, recipient: supervisor(), facts: night({ roster: onDutyRoster }) }))).toBe("ALLOW");
  });

  it("exempts the messages of an open case, not those of a closed one or of another case", () => {
    const notice = system("CASE_NOTICE", { text: "Escalé tu caso a Adriana.", caseId: CASE_ID, workOrderId: "wo-24818" });
    const recipient = installer({ lastInboundAtSim: mx("2026-10-13 21:00") });
    expect(summary(decide({ message: notice, recipient, facts: night({ caseState: { caseId: CASE_ID, status: "OPEN" } }) }))).toBe("ALLOW");
    expect(summary(decide({ message: notice, recipient, facts: night({ caseState: { caseId: CASE_ID, status: "TAKEN" } }) }))).toBe("ALLOW");
    expect(summary(decide({ message: notice, recipient, facts: night({ caseState: { caseId: CASE_ID, status: "CLOSED" } }) }))).toBe("DEFER CP-QUIET-HOURS QUIET_HOURS");
    expect(summary(decide({ message: notice, recipient, facts: night({ caseState: { caseId: OTHER_CASE_ID, status: "OPEN" } }) }))).toBe("DEFER CP-QUIET-HOURS QUIET_HOURS");
  });

  it("answers an inbound message at night: replies, read receipts and verdict reactions are not proactive", () => {
    const recipient = installer({ lastInboundAtSim: mx("2026-10-13 21:29") });
    const answer = decide({ message: reply(), recipient, facts: night() });
    expect(summary(answer)).toBe("ALLOW");
    expect(ruleEntry(answer, "CP-QUIET-HOURS").detail).toBe("exempt: answers an inbound");
    expect(summary(decide({ message: system("READ_ACK", { form: "READ_ACK" }), recipient, facts: night() }))).toBe("ALLOW");
    expect(summary(decide({ message: system("VERDICT_REACTION", { form: "REACTION" }), recipient, facts: night() }))).toBe("ALLOW");
  });
});
