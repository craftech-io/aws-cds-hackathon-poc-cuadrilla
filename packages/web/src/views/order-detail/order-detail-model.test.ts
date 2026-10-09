import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import type { RouterOutputs } from "../../lib/trpc-router";
import { OnuStatus, OrderDetail, Timeline, type TimelineEntry, canValidate, entryKey, isReviewable, manualHref, matchesTimeline, sectionLabel, speakerOf, visibleEntries } from "./order-detail-model";

const AT = "2026-10-13T09:20:00-06:00";

const message = (overrides: Record<string, unknown> = {}) => ({
  type: "MESSAGE",
  atSim: AT,
  messageId: "msg-1",
  personId: "inst-rogelio",
  direction: "IN",
  content: "VOICE",
  kind: null,
  author: "PERSON:inst-rogelio",
  text: null,
  templateName: null,
  buttonAction: null,
  transcript: { text: "Ya estoy con la señora Treviño, la ONU no prende la luz PON.", confidence: 0.93 },
  hasMedia: true,
  mediaKind: "AUDIO",
  status: "RECEIVED",
  citations: [],
  ruleIds: [],
  decision: null,
  simulated: true,
  ...overrides,
});

describe("orders.timeline at the edge [FL-080]", () => {
  it("[FL-080] reads every kind of entry: voice note with transcript, reply with citations, photo verdict, step, decision, note, email", () => {
    const parsed = Timeline.parse({
      workOrderId: "wo-24817",
      entries: [
        message(),
        message({ messageId: "msg-2", direction: "OUT", content: "TEXT", kind: "REPLY", author: "AGENT", text: "Revisa el cordón (Manual v1, §DIAG-02).", transcript: null, hasMedia: false, mediaKind: null, status: "DELIVERED", citations: ["DIAG-02"], ruleIds: ["CP-CITATION"], decision: "ALLOW" }),
        { type: "VALIDATION", atSim: AT, validationId: "val-1", item: "ONU_LABEL_PHOTO", verdict: "REJECT", reasonCode: "GLARE", checks: [], evidenceId: "ev-1" },
        { type: "STEP", atSim: AT, seq: 1, symptom: "NO_PON_LIGHT", stepRef: "DIAG-02", outcome: "FIXED" },
        { type: "DECISION", atSim: AT, decisionId: "d-1", decision: "DEFER", action: "SEND_WHATSAPP", ruleIds: ["CP-QUIET-HOURS"], trigger: null, actor: "AGENT", reason: null },
        { type: "TURN_NOTE", atSim: AT, turnId: "turn-1", trigger: "INSTALLER_MESSAGE", note: "Guie con DIAG-02.", stopReason: null, agentMode: "REAL" },
        { type: "EMAIL", atSim: AT, mailId: "mail-1", kind: "CERTIFICATE_EMAIL", toRole: "CUSTOMER", subject: "Acta de instalación · Orden 24817", status: "DELIVERED", events: [], hasAttachment: true },
      ],
      pending: [{ kind: "DAY_START", dueAtSim: "2026-10-13T07:30:00-06:00", reason: "Inicio del día" }],
    });
    expect(parsed.entries.map((entry) => entry.type)).toEqual(["MESSAGE", "MESSAGE", "VALIDATION", "STEP", "DECISION", "TURN_NOTE", "EMAIL"]);
    expect(new Set(parsed.entries.map(entryKey)).size).toBe(7);
    expect(Timeline.safeParse({ workOrderId: "wo-24817", entries: [{ type: "SOMETHING", atSim: AT }], pending: [] }).success).toBe(false);
  });

  it("[FL-080] the contracts match the router's answer types", () => {
    expectTypeOf<RouterOutputs["orders"]["get"]>().toExtend<z.input<typeof OrderDetail>>();
    expectTypeOf<RouterOutputs["orders"]["timeline"]>().toExtend<z.input<typeof Timeline>>();
    expectTypeOf<RouterOutputs["orders"]["onuStatus"]>().toExtend<z.input<typeof OnuStatus>>();
  });

  it("[FL-080] the ONU live: a reading, or the reason the network did not answer", () => {
    expect(OnuStatus.parse({ available: true, operState: "LOS", rxPowerDbm: null, txPowerDbm: null, inRange: false, acceptanceRange: { minDbm: -25, maxDbm: -8 }, observedAt: AT })).toMatchObject({ available: true, operState: "LOS" });
    expect(OnuStatus.parse({ available: false, reason: "TIMEOUT" })).toEqual({ available: false, reason: "TIMEOUT" });
  });
});

describe("timeline as a person reads it [FL-080]", () => {
  it("[FL-080] read receipts stay out; the filters split messages, evidence and decisions", () => {
    const entries = [
      message(),
      message({ messageId: "ack", direction: "OUT", content: "READ_ACK", kind: "READ_ACK", author: "SYSTEM", transcript: null, hasMedia: false, mediaKind: null }),
      { type: "STEP", atSim: AT, seq: 1, symptom: "NO_PON_LIGHT", stepRef: "DIAG-02", outcome: "PENDING" },
      { type: "DECISION", atSim: AT, decisionId: "d-1", decision: "ALLOW", action: "SEND_WHATSAPP", ruleIds: [], trigger: null },
    ].map((entry) => Timeline.shape.entries.element.parse(entry)) as TimelineEntry[];
    const visible = visibleEntries(entries);
    expect(visible).toHaveLength(3);
    expect(visible.filter((entry) => matchesTimeline(entry, "MESSAGES"))).toHaveLength(1);
    expect(visible.filter((entry) => matchesTimeline(entry, "EVIDENCE"))).toHaveLength(1);
    expect(visible.filter((entry) => matchesTimeline(entry, "DECISIONS"))).toHaveLength(1);
    expect(visible.filter((entry) => matchesTimeline(entry, "ALL"))).toHaveLength(3);
  });

  it("[FL-080] a citation links to its manual section; anything else has no link", () => {
    expect(manualHref("DIAG-02")).toBe("/app/manual/DIAG-02");
    expect(manualHref("SEG-01")).toBe("/app/manual/SEG-01");
    expect(manualHref("DIAG-02-a")).toBeUndefined();
    expect(manualHref("../people")).toBeUndefined();
    expect(sectionLabel("COM-04")).toBe("§COM-04");
  });

  it("[FL-080] who speaks: the installer, the assistant, the system or a supervisor", () => {
    expect(speakerOf({ direction: "IN", author: "PERSON:inst-rogelio" }, "inst-rogelio")).toBe("INSTALLER");
    expect(speakerOf({ direction: "OUT", author: "AGENT" }, "inst-rogelio")).toBe("AGENT");
    expect(speakerOf({ direction: "OUT", author: "SYSTEM" }, "inst-rogelio")).toBe("SYSTEM");
    expect(speakerOf({ direction: "OUT", author: "PERSON:sup-hector" }, "inst-rogelio")).toBe("PERSON");
  });
});

describe("manual validation from the detail [FL-044]", () => {
  it("[FL-044] supervisors and guests validate by hand; operations staff never do", () => {
    expect(canValidate("SUPERVISOR")).toBe(true);
    expect(canValidate("GUEST")).toBe(true);
    expect(canValidate("OPS")).toBe(false);
    expect(canValidate(undefined)).toBe(false);
  });

  it("[FL-044] only a rejected or unsure photo item of an open order is offered", () => {
    expect(isReviewable({ item: "ONU_LABEL_PHOTO", status: "REJECTED" }, "IN_PROGRESS")).toBe(true);
    expect(isReviewable({ item: "POWER_READING_PHOTO", status: "IN_REVIEW" }, "SCHEDULED")).toBe(true);
    expect(isReviewable({ item: "ONU_LABEL_PHOTO", status: "PASSED" }, "IN_PROGRESS")).toBe(false);
    expect(isReviewable({ item: "ONU_ONLINE", status: "REJECTED" }, "IN_PROGRESS")).toBe(false);
    expect(isReviewable({ item: "CUSTOMER_OK", status: "IN_REVIEW" }, "IN_PROGRESS")).toBe(false);
    expect(isReviewable({ item: "ROSETTE_PHOTO", status: "REJECTED" }, "CLOSED")).toBe(false);
  });
});
