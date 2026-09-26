import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  AuditDecision,
  BrandMode,
  CaseKind,
  CaseReason,
  CaseStatus,
  ChecklistItem,
  ChecklistItemStatus,
  ClockMode,
  ConsoleRole,
  ErrorCode,
  GuestOrigin,
  GuestWorldStatus,
  HazardCategory,
  IspKind,
  KillScope,
  ManualCategory,
  MessageKind,
  OnuOperState,
  OpticalClass,
  PersonRole,
  PhotoItem,
  RejectReason,
  Rung,
  RungOutcome,
  StepOutcome,
  Symptom,
  TemplateName,
  TemplateStatus,
  TimerFiredBy,
  TimerKind,
  TimerStatus,
  TurnTrigger,
  Verdict,
  WaButtonAction,
  WhatsAppMode,
  WorkOrderStatus,
} from "./enums";
import { ContactRule, Guardrail, PolicyResult, RuleId, ruleFamilyOf } from "./rules";
import { backticked, between, jsonBlockAfter, readDoc, tableRows } from "./testing";

const TOOL_CATALOG = readDoc("docs/tool-catalog.md");
const ARCHITECTURE = readDoc("docs/architecture.md");
const SHARED_TYPES = jsonBlockAfter(TOOL_CATALOG, "Tipos compartidos") as Record<string, unknown>;

const ENUMS_OF_THE_CATALOG: Record<string, z.ZodEnum> = {
  WorkOrderStatus,
  ChecklistItem,
  ChecklistItemStatus,
  OnuOperState,
  OpticalClass,
  Verdict,
  RejectReason,
  Symptom,
  StepOutcome,
  CaseKind,
  CaseReason,
  CaseStatus,
  Rung,
  RungOutcome,
  HazardCategory,
  MessageKind,
  WhatsAppMode,
  KillScope,
  BrandMode,
  WaButtonAction,
  TurnTrigger,
  TimerKind,
  ClockMode,
};

/** `A \| B \| C`, `A|B|C` or `A/B/C` captured by the first group of `pattern` in `markdown`. */
function listIn(markdown: string, pattern: RegExp): string[] {
  const found = pattern.exec(markdown)?.[1];
  if (found === undefined) throw new Error(`list not found: ${pattern}`);
  return found.split(/\s*\\?[|/]\s*/).map((value) => value.replaceAll("`", "").trim());
}

describe("docs/tool-catalog.md, Tipos compartidos", () => {
  it("every enum of the catalog exists, with the same values in the same order", () => {
    const listed = Object.entries(SHARED_TYPES).filter(([, value]) => Array.isArray(value));
    expect(listed.map(([name]) => name)).toEqual(Object.keys(ENUMS_OF_THE_CATALOG));
    for (const [name, values] of listed) {
      const options = ENUMS_OF_THE_CATALOG[name]?.options;
      // The catalog lists the scopes of ADR-0019; `SIGNUP` (ADR-0025 §4) comes from docs/architecture.md §5, below.
      if (name === "KillScope") expect(options?.slice(0, (values as unknown[]).length), name).toEqual(values);
      else expect(options, name).toEqual(values);
    }
  });

  it("PolicyResult and Guardrail have the catalog's fields", () => {
    expect(Object.keys(PolicyResult.shape)).toEqual(Object.keys(SHARED_TYPES.PolicyResult as object));
    expect(Object.keys(Guardrail.shape)).toEqual(Object.keys(SHARED_TYPES.Guardrail as object));
    expect((SHARED_TYPES.Guardrail as { action: string }).action.split(" | ")).toEqual(Guardrail.shape.action.options);
  });

  it("error codes are the ones of the Convenciones table", () => {
    const row = tableRows(TOOL_CATALOG, "| Convención | Regla").find((cells) => cells[0] === "Errores");
    expect(backticked(row?.[1] ?? "").filter((code) => /^[A-Z_]+$/.test(code))).toEqual(ErrorCode.options);
  });

  it("photo items and manual categories match the tool inputs", () => {
    expect(listIn(TOOL_CATALOG, /"uno de: (POWER_READING_PHOTO[^"]*)"/)).toEqual(PhotoItem.options);
    expect(listIn(TOOL_CATALOG, /"opcional; uno de: (GEN[^"]*)"/)).toEqual(ManualCategory.options);
    expect(PhotoItem.options.every((item) => ChecklistItem.options.includes(item))).toBe(true);
  });
});

describe("docs/architecture.md closed sets", () => {
  it("operator kinds, people roles and audit decisions", () => {
    expect(listIn(ARCHITECTURE, /Isp \(`kind` (`[^;]*`);/)).toEqual(IspKind.options);
    expect(listIn(ARCHITECTURE, /ISP#<ispId>#<([A-Z_\\|]+)>/)).toEqual(PersonRole.options);
    expect(listIn(ARCHITECTURE, /Decision \(`decision` ([A-Z/]+)/)).toEqual(AuditDecision.options);
  });

  it("kill switch scopes, guest origins and the states of a guest's world (ADR-0019, ADR-0024, ADR-0025)", () => {
    expect(listIn(ARCHITECTURE, /`KILL#<([A-Z\\|]+)>`/)).toEqual(KillScope.options);
    expect(listIn(ARCHITECTURE, /status (PROVISIONING[^,]+),/).sort()).toEqual([...GuestWorldStatus.options].sort());
    expect(listIn(readDoc("CONTEXT.md"), /`GuestOrigin` (`[^)]+`)\)/).sort()).toEqual([...GuestOrigin.options].sort());
  });

  it("template status and timer states", () => {
    expect(listIn(ARCHITECTURE, /templateStatus\{<nombre>: ([^}]+)\}/)).toEqual(TemplateStatus.options);
    expect(listIn(ARCHITECTURE, /status (SCHEDULED[A-Z|]+),/)).toEqual(TimerStatus.options);
    expect(listIn(ARCHITECTURE, /firedBy ([A-Z|]+),/)).toEqual(TimerFiredBy.options);
  });

  it("the six WhatsApp templates of docs/architecture-integrations.md §4.5", () => {
    const rows = tableRows(readDoc("docs/architecture-integrations.md"), "| Nombre | Para | Cuerpo");
    expect(rows.map((cells) => backticked(cells[0] ?? "")[0])).toEqual(TemplateName.options);
  });

  it("console roles of CONTEXT.md", () => {
    const roles = listIn(readDoc("CONTEXT.md"), /\(`ConsoleUser`, rol ([^)]+)\)/);
    expect([...roles].sort()).toEqual([...ConsoleRole.options].sort());
  });

  it("every section of the manual belongs to a category (docs/seed-spec.md §8)", () => {
    const sections = tableRows(readDoc("docs/seed-spec.md"), "| Id | Título | Contenido clave").map((cells) => backticked(cells[0] ?? "")[0] ?? "");
    expect(sections.length).toBe(32);
    expect(new Set(sections.map((id) => id.split("-")[0]))).toEqual(new Set(ManualCategory.options));
  });
});

describe("rules", () => {
  it("contact policy rules in the evaluation order of docs/design-brief.md §5.7", () => {
    const section = between(readDoc("docs/design-brief.md"), "### 5.7", "### 5.8");
    const ordered = section
      .split("\n")
      .filter((line) => /^\| \d+ \| `CP-/.test(line))
      .map((line) => backticked(line)[0]);
    expect(ordered).toEqual(ContactRule.options);
  });

  it("every rule id the documents cite follows the grammar", () => {
    const docs = ["docs/design-brief.md", "docs/flows-catalog.md", "docs/test-plan.md", "docs/tool-catalog.md", "docs/architecture.md", "CONTEXT.md"];
    const cited = new Set<string>();
    for (const doc of docs) {
      for (const match of readDoc(doc).matchAll(/`((?:CP|CED|LAM|SAFE|VAL|LAD)-[^`]*|G[1-3])`/g)) {
        const token = match[1] ?? "";
        if (!/[<*…]/.test(token)) cited.add(token);
      }
    }
    expect(cited.size).toBeGreaterThan(40);
    expect([...cited].filter((token) => !RuleId.safeParse(token).success)).toEqual([]);
    expect(ContactRule.options.every((rule) => RuleId.safeParse(rule).success)).toBe(true);
  });

  it("rule families", () => {
    expect(ruleFamilyOf("CP-WA-24H")).toBe("CP");
    expect(ruleFamilyOf("CED-NO-OVERRIDE")).toBe("CED");
    expect(ruleFamilyOf("G2")).toBe("G");
    expect(ruleFamilyOf("VAL-CROSSCHECK")).toBe("VAL");
    expect(RuleId.safeParse("G4").success).toBe(false);
    expect(RuleId.safeParse("cp-optin").success).toBe(false);
    expect(RuleId.safeParse("CP-").success).toBe(false);
  });

  it("PolicyResult: a denial by time carries nextAllowedAt, an allowed message never does", () => {
    expect(PolicyResult.safeParse({ allowed: true, ruleIds: ["CP-OPTIN", "CP-WA-24H"] }).success).toBe(true);
    expect(
      PolicyResult.safeParse({ allowed: false, ruleIds: ["CP-QUIET-HOURS"], reason: "QUIET_HOURS", nextAllowedAt: "2026-10-14T07:00:00-06:00" }).success,
    ).toBe(true);
    expect(PolicyResult.safeParse({ allowed: true, ruleIds: [], nextAllowedAt: "2026-10-14T07:00:00-06:00" }).success).toBe(false);
    expect(PolicyResult.safeParse({ allowed: false, ruleIds: ["not a rule"] }).success).toBe(false);
    expect(PolicyResult.safeParse({ allowed: true, ruleIds: [], extra: 1 }).success).toBe(false);
  });

  it("Guardrail", () => {
    expect(Guardrail.safeParse({ action: "NONE", groundingScore: 0.82 }).success).toBe(true);
    expect(Guardrail.safeParse({ action: "BLOCKED" }).success).toBe(true);
    expect(Guardrail.safeParse({ action: "MASKED" }).success).toBe(false);
    expect(Guardrail.safeParse({ action: "NONE", groundingScore: 1.2 }).success).toBe(false);
  });
});
