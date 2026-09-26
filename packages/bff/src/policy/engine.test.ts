import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { ContactRule } from "@cuadrilla/shared";
import { RULE_ORDER, evaluate } from "./engine";
import { REASON_RULE } from "./reasons";
import { errorCodeOf, toDecisionInput, toMessagePolicy, toPolicyResult } from "./result";
import { UNKNOWN_SENDER_DAILY_CAP } from "./rules-audience";
import { at, dayStart, decide, entryOf, facts, input, installer, mx, reply, summary, supervisor, system } from "./testing";

const unknownNumber = (overrides: Record<string, unknown> = {}) => ({ kind: "UNKNOWN_NUMBER" as const, route: "SIMULATED" as const, repliesToday: 0, ...overrides });
const unknownNotice = system("SYSTEM_NOTICE", { notice: "unknownNumber", inResponseToInbound: true });
const at0730 = facts({ now: at("2026-10-13 07:30") });

describe("the contact policy engine", () => {
  it("evaluates the fifteen rules in the order of docs/design-brief.md §5.7", () => {
    const order = [
      "CP-KIND-CHANNEL",
      "CP-ALLOWLIST",
      "CP-OPTIN",
      "CP-OPTOUT",
      "CP-BRIDGE",
      "CP-ROSTER",
      "CP-QUIET-HOURS",
      "CP-ONE-DAYSTART",
      "CP-WA-24H",
      "CP-TEMPLATE-APPROVED",
      "CP-RECIPIENT-FENCE",
      "CP-CERT-EVIDENCE",
      "CP-NO-SENSITIVE-ASK",
      "CP-NO-FOREIGN-LINKS",
      "CP-CITATION",
    ];
    expect(RULE_ORDER).toEqual(order);
    expect(decide().evaluated.map((entry) => entry.ruleId)).toEqual(order);
  });

  it("allows an agent reply to its installer inside the window and names the rules that applied", () => {
    const decision = decide();
    expect(decision).toMatchObject({ outcome: "ALLOW", allowed: true, at: at("2026-10-13 09:21") });
    expect(decision.ruleIds).toEqual(["CP-KIND-CHANNEL", "CP-ALLOWLIST", "CP-OPTIN", "CP-OPTOUT", "CP-BRIDGE", "CP-WA-24H", "CP-NO-SENSITIVE-ASK", "CP-NO-FOREIGN-LINKS"]);
    expect(decision.evaluated.find((entry) => entry.ruleId === "CP-ROSTER")).toEqual({ ruleId: "CP-ROSTER", result: "NOT_APPLICABLE" });
    expect(decision.nextAllowedAt).toBeUndefined();
  });

  it("stops at the first rule that denies: the rules after it are SKIP", () => {
    const decision = decide({ recipient: installer({ consent: "NONE", lastInboundAtSim: undefined }) });
    expect(summary(decision)).toBe("DENY CP-OPTIN NO_OPT_IN");
    expect(decision.ruleIds).toEqual(["CP-OPTIN"]);
    const after = decision.evaluated.slice(RULE_ORDER.indexOf("CP-OPTIN") + 1);
    expect(after.every((entry) => entry.result === "SKIP")).toBe(true);
    expect(after).toHaveLength(12);
  });

  it("refuses a malformed input instead of deciding (zod at the edge)", () => {
    expect(() => evaluate({ ...input(), extra: true } as never)).toThrow(ZodError);
    expect(() => evaluate(input({ message: reply({ citations: ["§COM-04"] }) }))).toThrow(ZodError);
  });

  it("gives every reason to exactly one rule", () => {
    for (const rule of Object.values(REASON_RULE)) expect(ContactRule.options).toContain(rule);
    for (const rule of ContactRule.options.filter((rule) => rule !== "CP-KIND-CHANNEL")) {
      expect(Object.values(REASON_RULE)).toContain(rule);
    }
  });

  it("converts a decision into the tool's PolicyResult, the AuditLog row and the message policy", () => {
    const denied = decide({ recipient: installer({ lastInboundAtSim: undefined }) });
    expect(toPolicyResult(denied)).toEqual({ allowed: false, ruleIds: ["CP-WA-24H"], reason: "WINDOW_CLOSED" });
    expect(errorCodeOf(denied)).toBe("TEMPLATE_REQUIRED");
    const row = toDecisionInput(denied, { ispId: "isp-demo", clockId: "GLOBAL#isp-demo", action: "SEND_WHATSAPP", actor: "AGENT", messageId: "msg-1" });
    expect(row).toMatchObject({ decision: "DENY", ruleIds: ["CP-WA-24H"], reason: "WINDOW_CLOSED", atSim: at("2026-10-13 09:21").sim, messageId: "msg-1" });
    expect(row.evaluated).toHaveLength(15);
    const allowed = decide();
    expect(toMessagePolicy(allowed, "dec-1")).toEqual({ decision: "ALLOW", ruleIds: allowed.ruleIds, decisionId: "dec-1" });
    expect(errorCodeOf(allowed)).toBeUndefined();
    expect(errorCodeOf(decide({ facts: facts({ bridgeActive: true }) }))).toBe("BRIDGE_ACTIVE");
  });
});

describe("CP-KIND-CHANNEL: the kind × channel matrix of §3", () => {
  it("never lets the agent write to a supervisor, nor send what only code sends", () => {
    expect(summary(decide({ recipient: supervisor() }))).toBe("DENY CP-KIND-CHANNEL KIND_WRONG_RECIPIENT");
    const agentCaseRequest = reply({ kind: "CASE_REQUEST", form: "TEMPLATE", templateName: "caso_escalado" });
    expect(summary(decide({ message: agentCaseRequest, recipient: supervisor() }))).toBe("DENY CP-KIND-CHANNEL KIND_WRONG_AUTHOR");
    expect(summary(decide({ message: system("REPLY") }))).toBe("DENY CP-KIND-CHANNEL KIND_WRONG_AUTHOR");
  });

  it("keeps each kind on its channel, form and templates", () => {
    const email = { kind: "EMAIL" as const, role: "CUSTOMER" as const, fence: { allowed: true } };
    expect(summary(decide({ message: system("CERTIFICATE_EMAIL", { channel: "WHATSAPP", form: "EMAIL" }) }))).toBe("DENY CP-KIND-CHANNEL KIND_WRONG_CHANNEL");
    expect(summary(decide({ message: reply(), recipient: email }))).toBe("DENY CP-KIND-CHANNEL KIND_WRONG_CHANNEL");
    expect(summary(decide({ message: dayStart({ templateName: "caso_escalado" }), facts: at0730 }))).toBe("DENY CP-KIND-CHANNEL KIND_WRONG_TEMPLATE");
    expect(summary(decide({ message: dayStart({ form: "TEXT", templateName: undefined }), facts: at0730 }))).toBe("DENY CP-KIND-CHANNEL KIND_WRONG_FORM");
    expect(summary(decide({ message: reply({ templateName: "ordenes_del_dia" }) }))).toBe("DENY CP-KIND-CHANNEL KIND_WRONG_TEMPLATE");
    expect(summary(decide({ message: system("SYSTEM_NOTICE", { inResponseToInbound: true }) }))).toBe("DENY CP-KIND-CHANNEL KIND_NOTICE_MISSING");
  });

  it("lets the bridge carry a person's text and never the system's, and never reaches a zone chief on WhatsApp", () => {
    expect(summary(decide({ message: system("RELAY", { author: "PERSON", caseId: "case-01J9ZQX0000000000000000000" }) }))).toBe("ALLOW");
    expect(summary(decide({ message: system("RELAY") }))).toBe("DENY CP-KIND-CHANNEL KIND_WRONG_AUTHOR");
    const zoneChief = installer({ personId: "zc-marisol", role: "ZONE_CHIEF" });
    expect(summary(decide({ message: system("CASE_NOTICE", { inResponseToInbound: true }), recipient: zoneChief }))).toBe("DENY CP-KIND-CHANNEL KIND_WRONG_RECIPIENT");
  });
});

describe("[FL-004] CP-ALLOWLIST: a number outside the allow list", () => {
  it("gets one fixed notice per day in a simulated world and nothing else", () => {
    expect(summary(decide({ message: unknownNotice, recipient: unknownNumber() }))).toBe("ALLOW");
    expect(summary(decide({ message: unknownNotice, recipient: unknownNumber({ repliesToday: 1 }) }))).toBe("DENY CP-ALLOWLIST UNKNOWN_SENDER");
    const otherNotice = system("SYSTEM_NOTICE", { notice: "optInRequired", inResponseToInbound: true });
    expect(summary(decide({ message: otherNotice, recipient: unknownNumber() }))).toBe("DENY CP-ALLOWLIST UNKNOWN_SENDER");
    expect(summary(decide({ message: reply(), recipient: unknownNumber() }))).toBe("DENY CP-KIND-CHANNEL KIND_WRONG_RECIPIENT");
  });

  it("gets no reply in the live world beyond the global daily cap", () => {
    const live = (globalRepliesToday: number) => unknownNumber({ route: "LIVE_WORLD", globalRepliesToday });
    expect(summary(decide({ message: unknownNotice, recipient: live(UNKNOWN_SENDER_DAILY_CAP - 1) }))).toBe("ALLOW");
    expect(summary(decide({ message: unknownNotice, recipient: live(UNKNOWN_SENDER_DAILY_CAP) }))).toBe("DENY CP-ALLOWLIST UNKNOWN_SENDER_CAP");
    expect(UNKNOWN_SENDER_DAILY_CAP).toBe(20);
    // An "ALTA <código>" from a real phone that bound nothing gets its fixed answer (FL-101), within the same caps.
    const invalidCode = system("SYSTEM_NOTICE", { notice: "joinCodeInvalid", inResponseToInbound: true });
    expect(summary(decide({ message: invalidCode, recipient: live(3) }))).toBe("ALLOW");
    expect(summary(decide({ message: invalidCode, recipient: live(UNKNOWN_SENDER_DAILY_CAP) }))).toBe("DENY CP-ALLOWLIST UNKNOWN_SENDER_CAP");
  });

  it("denies a deactivated person or one without a registered phone", () => {
    expect(summary(decide({ recipient: installer({ active: false }) }))).toBe("DENY CP-ALLOWLIST NOT_ALLOWLISTED");
    expect(summary(decide({ recipient: installer({ hasPhone: false }) }))).toBe("DENY CP-ALLOWLIST NO_PHONE");
  });
});

describe("[FL-005] CP-OPTOUT: after BAJA", () => {
  const optedOut = installer({ consent: "REVOKED" });

  it("sends nothing but the confirmation of BAJA", () => {
    const confirmation = system("SYSTEM_NOTICE", { notice: "optOutConfirmed", inResponseToInbound: true });
    expect(summary(decide({ message: confirmation, recipient: optedOut }))).toBe("ALLOW");
    expect(summary(decide({ message: dayStart(), recipient: optedOut, facts: at0730 }))).toBe("DENY CP-OPTOUT OPTED_OUT");
    expect(summary(decide({ message: reply(), recipient: optedOut }))).toBe("DENY CP-OPTOUT OPTED_OUT");
    const invitation = system("SYSTEM_NOTICE", { notice: "optInRequired", inResponseToInbound: true });
    expect(summary(decide({ message: invitation, recipient: optedOut }))).toBe("DENY CP-OPTOUT OPTED_OUT");
  });

  it("leaves CP-OPTIN to a person who never opted in", () => {
    expect(entryOf({ recipient: optedOut }, "CP-OPTIN")).toMatchObject({ result: "NOT_APPLICABLE" });
  });
});

describe("[FL-011] the day's template denied for consent", () => {
  it("is DENY CP-OPTIN without opt-in and DENY CP-OPTOUT after BAJA, before rendering", () => {
    expect(summary(decide({ message: dayStart(), recipient: installer({ personId: "inst-julian", consent: "NONE" }), facts: at0730 }))).toBe("DENY CP-OPTIN NO_OPT_IN");
    expect(summary(decide({ message: dayStart(), recipient: installer({ personId: "inst-ernesto", consent: "REVOKED" }), facts: at0730 }))).toBe("DENY CP-OPTOUT OPTED_OUT");
    expect(summary(decide({ message: dayStart(), facts: at0730 }))).toBe("ALLOW");
  });

  it("still lets a person without opt-in receive the invitation to send ALTA and its welcome", () => {
    const newcomer = installer({ personId: "inst-julian", consent: "NONE" });
    for (const notice of ["optInRequired", "welcome"]) {
      expect(summary(decide({ message: system("SYSTEM_NOTICE", { notice, inResponseToInbound: true }), recipient: newcomer }))).toBe("ALLOW");
    }
    expect(summary(decide({ message: system("SYSTEM_NOTICE", { notice: "voiceUnclear", inResponseToInbound: true }), recipient: newcomer }))).toBe("DENY CP-OPTIN NO_OPT_IN");
  });
});

describe("[FL-012] one DAY_START per installer and simulated day", () => {
  it("denies a second one the same simulated day and allows it the next day", () => {
    const sent = [mx("2026-10-13 07:30")];
    expect(summary(decide({ message: dayStart(), facts: facts({ now: at("2026-10-13 07:35"), dayStartsSentAtSim: sent }) }))).toBe("DENY CP-ONE-DAYSTART DAY_START_ALREADY_SENT");
    expect(summary(decide({ message: dayStart(), facts: facts({ now: at("2026-10-14 07:30"), dayStartsSentAtSim: sent }) }))).toBe("ALLOW");
  });

  it("counts the operator's local day, not the UTC one", () => {
    // 12/10 23:30 in Mexico City is already 13/10 in UTC; 13/10 07:30 local is another local day.
    const lateYesterday = [mx("2026-10-12 23:30")];
    expect(lateYesterday[0]?.slice(0, 10)).toBe("2026-10-13");
    const decision = decide({ message: dayStart(), facts: facts({ now: at("2026-10-13 07:30"), dayStartsSentAtSim: lateYesterday }) });
    expect(summary(decision)).toBe("ALLOW");
    expect(decision.evaluated.find((entry) => entry.ruleId === "CP-ONE-DAYSTART")).toEqual({ ruleId: "CP-ONE-DAYSTART", result: "PASS", clock: "WORLD", detail: "2026-10-13" });
  });
});

describe("CP-BRIDGE: a case TAKEN on the order", () => {
  it("silences the agent to the installer, not the system nor the bridge", () => {
    const bridged = facts({ bridgeActive: true });
    expect(summary(decide({ facts: bridged }))).toBe("DENY CP-BRIDGE BRIDGE_ACTIVE");
    expect(summary(decide({ message: system("CASE_NOTICE", { inResponseToInbound: true }), facts: bridged }))).toBe("ALLOW");
    expect(summary(decide({ message: system("RELAY", { author: "PERSON" }), facts: bridged }))).toBe("ALLOW");
  });
});
