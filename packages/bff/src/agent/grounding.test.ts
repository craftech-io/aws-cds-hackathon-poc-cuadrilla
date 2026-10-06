import { describe, expect, it } from "vitest";
import { readDoc } from "@cuadrilla/shared/testing";
import { STATUS_QUESTION, asksSomething, g2RefusalRecord, groundingQuery } from "./grounding";

describe("[FL-025] the query G2 measures a reply against (ADR-0028 §4)", () => {
  it("uses the fixed status question for a message that asks nothing, in es and en", () => {
    for (const text of ["hola", "ok", "gracias", "buenos días", "  Hola!  ", "ok gracias jefe", ""]) {
      expect(groundingQuery(text, "es"), text).toBe("¿Cómo va mi orden y qué me falta?");
      expect(groundingQuery(text, "en"), text).toBe("How is my work order going and what is missing?");
    }
  });

  it("uses the installer's text when it asks something: a question mark, or four words or more", () => {
    expect(groundingQuery("¿cuánto cable sin costo?", "es")).toBe("¿cuánto cable sin costo?");
    expect(groundingQuery("cable?", "es")).toBe("cable?");
    expect(groundingQuery("  ya llegué al domicilio  ", "es")).toBe("ya llegué al domicilio");
    expect(asksSomething("¿roseta")).toBe(true);
    expect(asksSomething("buenos días a todos")).toBe(true);
    expect(asksSomething("buenos días")).toBe(false);
  });

  it("is the question ADR-0028 and CONTEXT.md fix, and rejects a language it does not know", () => {
    expect(readDoc("docs/adr/0028-lecciones-del-producto-hermano.md")).toContain(`("${STATUS_QUESTION.es}"; en inglés, "${STATUS_QUESTION.en}")`);
    expect(readDoc("CONTEXT.md")).toContain(`"${STATUS_QUESTION.es}"`);
    expect(() => groundingQuery("hola", "pt" as "es")).toThrow();
  });
});

describe("[FL-025] the record of a G2 refusal (ADR-0028 §4)", () => {
  const evaluation = {
    reason: "RELEVANCE" as const,
    groundingScore: 0.91,
    relevanceScore: 0.42,
    groundingThreshold: 0.75,
    relevanceThreshold: 0.5,
    text: "Tu orden 24817 va bien: falta la foto de la roseta.",
    query: "hola",
    groundingSource: '{"tool":"get_work_order"}',
  };

  it("carries the reason, both scores and both thresholds, and never the text, the query or the source", () => {
    const record = g2RefusalRecord(evaluation);
    expect(record).toEqual({ reason: "RELEVANCE", groundingScore: 0.91, relevanceScore: 0.42, groundingThreshold: 0.75, relevanceThreshold: 0.5 });
    const serialized = JSON.stringify(record);
    for (const leaked of [evaluation.text, "24817", "roseta", evaluation.query, "get_work_order"]) expect(serialized).not.toContain(leaked);
  });

  it("leaves out a score G2 did not return, and refuses a malformed evaluation", () => {
    expect(g2RefusalRecord({ reason: "TOO_LONG", groundingThreshold: 0.75, relevanceThreshold: 0.5 })).toEqual({ reason: "TOO_LONG", groundingThreshold: 0.75, relevanceThreshold: 0.5 });
    expect(() => g2RefusalRecord({ ...evaluation, reason: "MAYBE" as "RELEVANCE" })).toThrow();
    expect(() => g2RefusalRecord({ ...evaluation, groundingScore: 1.4 })).toThrow();
  });
});
