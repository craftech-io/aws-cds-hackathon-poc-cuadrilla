import { describe, expect, it } from "vitest";
import { MessageKind, TemplateName, type TemplateStatus } from "@cuadrilla/shared";
import type { TemplateReviewStatus } from "../domain/reference";
import { TEMPLATES } from "../copy/templates";
import { ruleEntry } from "./engine";
import { KIND_CHANNEL_MATRIX } from "./kinds";
import { CASE_ID, at, dayStart, decide, entryOf, facts, installer, mx, reply, summary, supervisor, system } from "./testing";

type WorldTemplates = Partial<Record<TemplateName, TemplateStatus>>;

const at0730 = (templateStatus: WorldTemplates = {}) => facts({ now: at("2026-10-13 07:30"), world: { clockId: "GLOBAL#isp-demo", quietHours: { start: "21:00", end: "07:00" }, templateStatus } });
const roster = { primaryId: "sup-adriana", secondaryId: "sup-hector" };
const caseFacts = (templateStatus: WorldTemplates) =>
  facts({ now: at("2026-10-13 11:50"), roster, caseState: { caseId: CASE_ID, status: "OPEN" }, world: { clockId: "GLOBAL#isp-demo", quietHours: { start: "21:00", end: "07:00" }, templateStatus } });
const caseTemplate = system("CASE_REQUEST", { form: "TEMPLATE", templateName: "caso_escalado", caseId: CASE_ID, workOrderId: "wo-24818" });
const caseInteractive = system("CASE_REQUEST", { form: "INTERACTIVE", text: "Tienes un caso nuevo de tu equipo: C-0412. ¿Puedes tomarlo ahora?", caseId: CASE_ID, workOrderId: "wo-24818" });

describe("[FL-016] plan B of the installer: \"ÓRDENES\"", () => {
  it("denies the day's template while ordenes_del_dia is REJECTED in the world", () => {
    const denied = decide({ message: dayStart(), facts: at0730({ ordenes_del_dia: "REJECTED" }) });
    expect(summary(denied)).toBe("DENY CP-TEMPLATE-APPROVED TEMPLATE_NOT_APPROVED");
    expect(ruleEntry(denied, "CP-TEMPLATE-APPROVED").detail).toBe("ordenes_del_dia REJECTED in the world");
    expect(summary(decide({ message: dayStart(), facts: at0730({ ordenes_del_dia: "PENDING" }) }))).toBe("DENY CP-TEMPLATE-APPROVED TEMPLATE_NOT_APPROVED");
  });

  it("sends the day's detail as free text once \"ÓRDENES\" opened the window", () => {
    const wroteOrdenes = installer({ lastInboundAtSim: mx("2026-10-13 07:40") });
    const detail = reply({ kind: "ORDERS_DETAIL", text: "Hoy tienes 3 órdenes: 24817, 24818 y 24819." });
    expect(summary(decide({ message: detail, recipient: wroteOrdenes, facts: facts({ now: at("2026-10-13 07:41"), world: { clockId: "GLOBAL#isp-demo", quietHours: { start: "21:00", end: "07:00" }, templateStatus: { ordenes_del_dia: "REJECTED" } } }) }))).toBe("ALLOW");
  });
});

describe("[FL-074] case template not approved: plan B \"TURNO\"", () => {
  it("denies caso_escalado while it is REJECTED or PENDING in the world", () => {
    for (const state of ["REJECTED", "PENDING"] as const) {
      expect(summary(decide({ message: caseTemplate, recipient: supervisor(), facts: caseFacts({ caso_escalado: state }) }))).toBe("DENY CP-TEMPLATE-APPROVED TEMPLATE_NOT_APPROVED");
    }
  });

  it("allows the interactive message with the same buttons inside the supervisor's window opened by TURNO", () => {
    const sentTurno = supervisor("sup-adriana", { lastInboundAtSim: mx("2026-10-13 07:05") });
    const interactive = decide({ message: caseInteractive, recipient: sentTurno, facts: caseFacts({ caso_escalado: "REJECTED" }) });
    expect(summary(interactive)).toBe("ALLOW");
    expect(ruleEntry(interactive, "CP-TEMPLATE-APPROVED")).toEqual({ ruleId: "CP-TEMPLATE-APPROVED", result: "NOT_APPLICABLE" });
  });

  it("denies the interactive to a backup who never sent TURNO (the ladder skips the rung, FL-075)", () => {
    const noTurno = supervisor("sup-hector", { lastInboundAtSim: undefined });
    expect(summary(decide({ message: caseInteractive, recipient: noTurno, facts: caseFacts({ caso_escalado: "REJECTED" }) }))).toBe("DENY CP-WA-24H WINDOW_CLOSED");
  });

  it("treats a template the world does not hold back as APPROVED in the simulated transport", () => {
    expect(summary(decide({ message: caseTemplate, recipient: supervisor(), facts: caseFacts({}) }))).toBe("ALLOW");
    expect(entryOf({ message: caseTemplate, recipient: supervisor(), facts: caseFacts({}) }, "CP-TEMPLATE-APPROVED").detail).toBe("caso_escalado APPROVED in the world");
  });
});

describe("templates on the live transport", () => {
  const livePhone = supervisor("sup-adriana", { route: "LIVE_WORLD" });

  it("read Meta's review state, not the world's simulated one", () => {
    const withMeta = (status: TemplateReviewStatus | undefined) =>
      facts({ ...caseFacts({ caso_escalado: "APPROVED" }), ...(status === undefined ? {} : { metaTemplateStatus: { caso_escalado: status } }) });
    expect(summary(decide({ message: caseTemplate, recipient: livePhone, facts: withMeta("APPROVED") }))).toBe("ALLOW");
    for (const status of ["PENDING", "REJECTED", "LOCAL_ONLY", undefined] as const) {
      expect(summary(decide({ message: caseTemplate, recipient: livePhone, facts: withMeta(status) }))).toBe("DENY CP-TEMPLATE-APPROVED TEMPLATE_NOT_APPROVED");
    }
  });
});

describe("the templates of the kind matrix", () => {
  it("render only kinds of their own audience (copy/templates.ts)", () => {
    for (const kind of MessageKind.options) {
      const rule = KIND_CHANNEL_MATRIX[kind];
      for (const name of rule.templates ?? []) expect(rule.audiences).toContain(TEMPLATES[name].audience);
    }
  });

  it("cover the six templates", () => {
    const used = new Set(MessageKind.options.flatMap((kind) => KIND_CHANNEL_MATRIX[kind].templates ?? []));
    expect([...used].sort()).toEqual([...TemplateName.options].sort());
  });
});
