import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ruleTone } from "./RuleChip";
import { RuleChips } from "./RuleChips";

describe("RuleChip(s)", () => {
  it("colours a rule by its family and keeps an id it does not know, drawn neutral", () => {
    expect(ruleTone("CP-WA-24H")).toContain("text-info");
    expect(ruleTone("SAFE-LEXICON")).toContain("text-danger");
    expect(ruleTone("G2")).toContain("text-warning");
    expect(ruleTone("not a rule")).toContain("text-slate");
  });

  it("lists each rule once, in the recorded order, with its meaning for screen readers", () => {
    const html = renderToStaticMarkup(
      createElement(RuleChips, {
        ruleIds: ["CP-OPTIN", "CP-WA-24H", "CP-OPTIN"],
        label: "Reglas de la decisión",
        describe: (ruleId: string) => (ruleId === "CP-WA-24H" ? "Ventana de 24 h" : undefined),
      }),
    );
    expect(html).toContain('aria-label="Reglas de la decisión"');
    expect(html.match(/<li>/g)).toHaveLength(2);
    expect(html.indexOf("CP-OPTIN")).toBeLessThan(html.indexOf("CP-WA-24H"));
    expect(html).toContain('title="Ventana de 24 h"');
    expect(html).toContain('<span class="sr-only">: Ventana de 24 h</span>');
  });

  it("says so when a decision has no rules", () => {
    expect(renderToStaticMarkup(createElement(RuleChips, { ruleIds: [], label: "Reglas", emptyText: "Sin reglas registradas" }))).toContain("Sin reglas registradas");
    expect(renderToStaticMarkup(createElement(RuleChips, { ruleIds: [], label: "Reglas" }))).toBe("");
  });
});
