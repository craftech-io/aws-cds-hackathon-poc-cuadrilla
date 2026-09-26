import { describe, expect, it } from "vitest";
import { ruleEntry } from "./engine";
import { SERVICE_WINDOW_MS, quietClockOf, serviceWindowOf, windowClockOf } from "./windows";
import { CASE_ID, at, decide, entryOf, facts, installer, mx, reply, summary, supervisor, system } from "./testing";

const HOUR = 3_600_000;
/** An instant `hours` after `iso`. */
const plus = (iso: string, hours: number): string => new Date(Date.parse(iso) + hours * HOUR).toISOString();

const relay = system("RELAY", { author: "PERSON", text: "Héctor (supervisor): Cambia el conector de la roseta.", caseId: CASE_ID, workOrderId: "wo-24818" });
const replyTemplate = system("SUPERVISOR_REPLY_TEMPLATE", { form: "TEMPLATE", templateName: "respuesta_supervisor", caseId: CASE_ID, workOrderId: "wo-24818" });
const caseNotice = system("CASE_NOTICE", { text: "Escalé tu caso a Adriana.", caseId: CASE_ID, workOrderId: "wo-24818" });
const openCase = { caseId: CASE_ID, status: "TAKEN" as const };

describe("[FL-072] the installer's 24 h window, synthetic identity (world clock)", () => {
  const lastInbound = mx("2026-10-13 09:20");

  it("(a) lets free text go inside the window, measured with the world clock", () => {
    const decision = decide({ facts: facts({ now: { sim: plus(lastInbound, 23.99), real: "2026-11-30T00:00:00.000Z" } }) });
    expect(summary(decision)).toBe("ALLOW");
    expect(ruleEntry(decision, "CP-WA-24H")).toEqual({ ruleId: "CP-WA-24H", result: "PASS", clock: "WORLD", detail: `lastInboundAtSim ${lastInbound}` });
  });

  it("(b) holds a proactive free text 25 h after the last inbound and lets a template go", () => {
    const later = facts({ now: { sim: plus(lastInbound, 25), real: "2026-10-01T00:00:00.000Z" }, caseState: { caseId: CASE_ID, status: "OPEN" } });
    const denied = decide({ message: caseNotice, facts: later });
    expect(summary(denied)).toBe("DENY CP-WA-24H WINDOW_CLOSED");
    expect(ruleEntry(denied, "CP-WA-24H")).toMatchObject({ clock: "WORLD", result: "FAIL" });
    expect(summary(decide({ message: system("DAY_START", { form: "TEMPLATE", templateName: "ordenes_del_dia" }), facts: facts({ now: at("2026-10-14 07:30") }) }))).toBe("ALLOW");
  });

  it("closes exactly 24 h after the last inbound and stays closed for someone who never wrote", () => {
    expect(summary(decide({ facts: facts({ now: { sim: plus(lastInbound, 24), real: "2026-11-02T18:00:00.000Z" } }) }))).toBe("DENY CP-WA-24H WINDOW_CLOSED");
    expect(entryOf({ recipient: installer({ lastInboundAtSim: undefined }) }, "CP-WA-24H")).toMatchObject({ result: "FAIL", detail: "no lastInboundAtSim" });
  });
});

describe("[FL-057] a supervisor's answer with the installer's window closed", () => {
  const lastInbound = mx("2026-10-13 11:50");
  const later = facts({ now: { sim: plus(lastInbound, 25), real: "2026-11-02T18:00:00.000Z" }, caseState: openCase });
  const inside = facts({ now: { sim: plus(lastInbound, 1), real: "2026-11-02T18:00:00.000Z" }, caseState: openCase });
  const installerWrote = installer({ lastInboundAtSim: lastInbound });

  it("relays the text inside the window", () => {
    expect(summary(decide({ message: relay, recipient: installerWrote, facts: inside }))).toBe("ALLOW");
  });

  it("denies the relay with CP-WA-24H and lets the respuesta_supervisor template go instead", () => {
    expect(summary(decide({ message: relay, recipient: installerWrote, facts: later }))).toBe("DENY CP-WA-24H WINDOW_CLOSED");
    const template = decide({ message: replyTemplate, recipient: installerWrote, facts: later });
    expect(summary(template)).toBe("ALLOW");
    expect(template.ruleIds).toContain("CP-TEMPLATE-APPROVED");
    expect(ruleEntry(template, "CP-WA-24H")).toMatchObject({ result: "NOT_APPLICABLE" });
  });

  it("delivers the pending relays once 'Ver respuesta' reopens the window", () => {
    const tapped = installer({ lastInboundAtSim: plus(lastInbound, 25) });
    expect(summary(decide({ message: { ...relay, inResponseToInbound: true }, recipient: tapped, facts: later }))).toBe("ALLOW");
  });
});

describe("[FL-072] (c) a real phone in a simulated world: real clock and lastInboundAtReal", () => {
  // A guest world paused on 13/10 09:21 for weeks; the guest's own phone is bound by code.
  const realNow = "2026-11-02T18:00:00.000Z";
  const leased = (lastInboundAtReal: string) => supervisor("sup-hector", { route: "PHONE_LEASE", lastInboundAtSim: mx("2026-10-13 09:20"), lastInboundAtReal });
  const paused = facts({ now: { sim: mx("2026-10-13 09:21"), real: realNow }, caseState: openCase });
  const text = system("CASE_TAKEN_NOTICE", { text: "Ya lo tomó Héctor.", caseId: CASE_ID });

  it("denies free text 25 real hours after the phone's last inbound, although the world clock says open", () => {
    const decision = decide({ message: text, recipient: leased(plus(realNow, -25)), facts: paused });
    expect(summary(decision)).toBe("DENY CP-WA-24H WINDOW_CLOSED");
    expect(ruleEntry(decision, "CP-WA-24H")).toEqual({ ruleId: "CP-WA-24H", result: "FAIL", clock: "REAL", detail: `lastInboundAtReal ${plus(realNow, -25)}` });
  });

  it("lets the template go instead, and free text 2 real hours after the last inbound", () => {
    const request = system("CASE_REQUEST", { form: "TEMPLATE", templateName: "caso_reasignado", caseId: CASE_ID });
    const withRoster = facts({ ...paused, roster: { primaryId: "sup-adriana", secondaryId: "sup-hector" }, metaTemplateStatus: { caso_reasignado: "APPROVED" } });
    expect(summary(decide({ message: request, recipient: leased(plus(realNow, -25)), facts: withRoster }))).toBe("ALLOW");
    expect(summary(decide({ message: text, recipient: leased(plus(realNow, -2)), facts: paused }))).toBe("ALLOW");
  });

  it("keeps measuring a synthetic identity of the same world with the world clock", () => {
    const synthetic = supervisor("sup-adriana", { lastInboundAtSim: mx("2026-10-13 09:20") });
    const decision = decide({ message: text, recipient: synthetic, facts: paused });
    expect(summary(decision)).toBe("ALLOW");
    expect(ruleEntry(decision, "CP-WA-24H").clock).toBe("WORLD");
  });

  it("records NOT_APPLICABLE_LEASE for quiet hours on the leased phone and real time for a live-world phone", () => {
    const nightReal = "2026-11-03T05:00:00.000Z"; // 23:00 in Mexico City
    const atNight = facts({ now: { sim: mx("2026-10-13 09:21"), real: nightReal }, caseState: { caseId: CASE_ID, status: "CLOSED" } });
    const proactive = system("CASE_TAKEN_NOTICE", { text: "Ya lo tomó Héctor.", caseId: CASE_ID });
    const onLease = decide({ message: proactive, recipient: leased(plus(nightReal, -1)), facts: atNight });
    expect(ruleEntry(onLease, "CP-QUIET-HOURS")).toEqual({ ruleId: "CP-QUIET-HOURS", result: "NOT_APPLICABLE_LEASE", detail: "phone bound by code to a guest world" });
    expect(summary(onLease)).toBe("ALLOW");
    const livePhone = supervisor("sup-hector", { route: "LIVE_WORLD", lastInboundAtReal: plus(nightReal, -1) });
    const onLive = decide({ message: proactive, recipient: livePhone, facts: atNight });
    expect(summary(onLive)).toBe("DEFER CP-QUIET-HOURS QUIET_HOURS");
    expect(onLive).toMatchObject({ nextAllowedAt: "2026-11-03T13:00:00.000Z", nextAllowedClock: "REAL" });
    expect(ruleEntry(onLive, "CP-QUIET-HOURS").clock).toBe("REAL");
  });
});

describe("the clocks of each route", () => {
  it("measure the window with the world clock only for synthetic identities", () => {
    expect(windowClockOf("SIMULATED")).toBe("WORLD");
    expect(windowClockOf("LIVE_WORLD")).toBe("REAL");
    expect(windowClockOf("PHONE_LEASE")).toBe("REAL");
    expect(quietClockOf("SIMULATED")).toBe("WORLD");
    expect(quietClockOf("LIVE_WORLD")).toBe("REAL");
    expect(quietClockOf("PHONE_LEASE")).toBe("NOT_APPLICABLE_LEASE");
  });

  it("give the window's last inbound and closing instant", () => {
    const lastInboundAtSim = mx("2026-10-13 09:20");
    const window = serviceWindowOf({ route: "SIMULATED", lastInboundAtSim }, at("2026-10-13 10:00"));
    expect(window).toEqual({ clock: "WORLD", open: true, lastInboundAt: lastInboundAtSim, closesAt: new Date(Date.parse(lastInboundAtSim) + SERVICE_WINDOW_MS).toISOString() });
    expect(serviceWindowOf({ route: "PHONE_LEASE", lastInboundAtSim }, at("2026-10-13 10:00"))).toEqual({ clock: "REAL", open: false });
  });

  it("let an unknown number receive its reply only as an answer to its inbound", () => {
    const unknown = { kind: "UNKNOWN_NUMBER" as const, route: "SIMULATED" as const, repliesToday: 0 };
    expect(entryOf({ message: system("SYSTEM_NOTICE", { notice: "unknownNumber", inResponseToInbound: true }), recipient: unknown }, "CP-WA-24H")).toMatchObject({ result: "PASS" });
    expect(summary(decide({ message: system("SYSTEM_NOTICE", { notice: "unknownNumber" }), recipient: unknown }))).toBe("DENY CP-WA-24H WINDOW_CLOSED");
  });

  it("apply the window to free content only (text, interactive, document, reaction), never to a template", () => {
    const closed = installer({ lastInboundAtSim: undefined });
    const closedOrder = facts({ certificate: { workOrderStatus: "CLOSED", sha256: "c".repeat(64) } });
    const certificate = (form: "DOCUMENT" | "TEMPLATE") =>
      system("CERTIFICATE", { form, workOrderId: "wo-24817", attachmentSha256: "c".repeat(64), ...(form === "TEMPLATE" ? { templateName: "acta_instalacion" as const } : {}) });
    expect(summary(decide({ message: reply(), recipient: closed }))).toBe("DENY CP-WA-24H WINDOW_CLOSED");
    expect(summary(decide({ message: reply({ form: "INTERACTIVE" }), recipient: closed }))).toBe("DENY CP-WA-24H WINDOW_CLOSED");
    expect(summary(decide({ message: system("VERDICT_REACTION", { form: "REACTION" }), recipient: closed }))).toBe("DENY CP-WA-24H WINDOW_CLOSED");
    expect(summary(decide({ message: certificate("DOCUMENT"), recipient: closed, facts: closedOrder }))).toBe("DENY CP-WA-24H WINDOW_CLOSED");
    expect(summary(decide({ message: certificate("TEMPLATE"), recipient: closed, facts: closedOrder }))).toBe("ALLOW");
  });
});
