import { describe, expect, it } from "vitest";
import { HazardCategory } from "@cuadrilla/shared";
import { SAFETY_LEXICON, SAFETY_LEXICON_EXAMPLES, SAFETY_LEXICON_VERSION, matchSafetyLexicon } from "./safety-lexicon";

const positives = SAFETY_LEXICON_EXAMPLES.filter((example) => example.expect !== null);
const negatives = SAFETY_LEXICON_EXAMPLES.filter((example) => example.expect === null);

describe("safety lexicon SAFETY_LEXICON#v001 (ADR-0016, docs/design-brief.md §5.9)", () => {
  it("is versioned, with unique ids, and every entry has a positive example", () => {
    expect(SAFETY_LEXICON_VERSION).toBe("v001");
    const ids = SAFETY_LEXICON.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    const matchedIds = new Set(positives.map((example) => matchSafetyLexicon(example.text)?.entryId));
    for (const id of ids) expect(matchedIds.has(id), `${id} has no positive example`).toBe(true);
  });

  it("covers every hazard category", () => {
    const categories = new Set(SAFETY_LEXICON.map((entry) => entry.category));
    for (const category of HazardCategory.options) expect(categories.has(category), category).toBe(true);
  });

  it.each(positives)("[FL-067] detects a present hazard: $text", ({ text, expect: category }) => {
    expect(matchSafetyLexicon(text)?.category).toBe(category);
  });

  it.each(negatives)("negative, left to the manual or the agent: $text", ({ text }) => {
    expect(matchSafetyLexicon(text)).toBeNull();
  });

  it("[FL-067] the story's message matches before G1 and the agent", () => {
    expect(matchSafetyLexicon("Hay un cable pelado en el poste, está chispeando")).toEqual({ entryId: "elec-cable-damaged", category: "ELECTRICAL" });
  });

  it("[FL-070] the voice note vn-05 matches once transcribed", () => {
    expect(matchSafetyLexicon("Hay un cable de luz caído en la banqueta y está echando chispas.")?.category).toBe("ELECTRICAL");
  });

  it("[FL-071] is conservative: an ambiguous or negated hazard still matches", () => {
    expect(matchSafetyLexicon("el cable está pelado")?.category).toBe("ELECTRICAL");
    expect(matchSafetyLexicon("creo que no hay cables pelados, pero huele a quemado")?.category).toBe("ELECTRICAL");
    expect(matchSafetyLexicon("EL CABLE ESTÁ PELADO!!!")?.category).toBe("ELECTRICAL");
  });

  it("[FL-069] the wasps of vn-12 are outside the lexicon, so the agent's report_safety_hazard is exercised", () => {
    expect(matchSafetyLexicon("Hay un panal de avispas dentro de la caja terminal y ya me picaron.")).toBeNull();
  });

  it("procedure questions about ladders and poles are negatives (EV-01 q-A-28, q-A-29)", () => {
    for (const text of ["¿Cómo coloco la escalera?", "¿Me puedo subir al poste de la luz para pasar el drop?", "¿A qué distancia del poste pongo la escalera?", "¿Cuántos peldaños tiene que sobresalir la escalera?"]) {
      expect(matchSafetyLexicon(text), text).toBeNull();
    }
  });

  it("patterns are plain regexes without flags, so the seed can store their source", () => {
    for (const entry of SAFETY_LEXICON) {
      expect(entry.pattern.flags).toBe("");
      expect(new RegExp(entry.pattern.source).source).toBe(entry.pattern.source);
    }
  });
});
