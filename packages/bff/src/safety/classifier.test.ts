import { describe, expect, it } from "vitest";
import { SAFETY_LEXICON, SAFETY_LEXICON_EXAMPLES, SAFETY_LEXICON_VERSION } from "../copy/safety-lexicon";
import { CLASSIFIER_MAX_CHARS, classifySafety } from "./classifier";

function categoryOf(text: string): string | null {
  const result = classifySafety(text);
  return result.hazard ? result.category : null;
}

describe("[FL-067] an electrical hazard is caught by the lexicon, before G1 and the agent", () => {
  it("classifies the sparking stripped cable as ELECTRICAL and names the entry, never the text", () => {
    const result = classifySafety("Hay un cable pelado en el poste, está chispeando");
    expect(result).toEqual({ hazard: true, category: "ELECTRICAL", entryId: "elec-cable-damaged", lexiconVersion: SAFETY_LEXICON_VERSION });
    expect(SAFETY_LEXICON.map((entry) => entry.id)).toContain(result.hazard ? result.entryId : "");
  });

  it("ignores case, accents and punctuation", () => {
    expect(categoryOf("¡HAY CHISPAS EN EL MEDIDOR!")).toBe("ELECTRICAL");
    expect(categoryOf("el poste esta ladeado")).toBe("POLE");
  });
});

describe("[FL-070] a hazard reported by voice note", () => {
  it("classifies the transcript of vn-05 like any text", () => {
    expect(categoryOf("Hay un cable de luz caído en la banqueta y está echando chispas.")).toBe("ELECTRICAL");
  });
});

describe("[FL-071] conservative: in doubt, it is a hazard", () => {
  it("treats an ambiguous stripped cable as a hazard", () => {
    expect(categoryOf("el cable está pelado")).toBe("ELECTRICAL");
  });

  it("detects every positive example of the lexicon with its category and none of its negatives", () => {
    for (const example of SAFETY_LEXICON_EXAMPLES) expect(categoryOf(example.text), `${example.source}: ${example.text}`).toBe(example.expect);
  });

  it("reads at most the first characters of a long message and never throws", () => {
    expect(classifySafety(undefined)).toEqual({ hazard: false, lexiconVersion: SAFETY_LEXICON_VERSION });
    expect(classifySafety("   ").hazard).toBe(false);
    expect(categoryOf(`${"a ".repeat(CLASSIFIER_MAX_CHARS)} hay chispas`)).toBeNull();
    expect(categoryOf(`hay chispas ${"a ".repeat(CLASSIFIER_MAX_CHARS)}`)).toBe("ELECTRICAL");
  });
});

describe("[FL-069] what the lexicon leaves to the agent", () => {
  it("does not match the wasps of vn-12: the agent's report_safety_hazard covers it", () => {
    expect(categoryOf("Hay un panal de avispas dentro de la caja terminal y ya me picaron.")).toBeNull();
  });

  it("does not match procedure questions about ladders and poles", () => {
    for (const question of ["¿Cómo coloco la escalera?", "¿Me puedo subir al poste de la luz para pasar el drop?", "¿Puedo recargar la escalera en el poste?", "¿Qué inclinación le doy a la escalera?"]) {
      expect(categoryOf(question), question).toBeNull();
    }
  });
});
