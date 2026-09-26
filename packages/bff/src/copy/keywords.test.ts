import { describe, expect, it } from "vitest";
import { KEYWORD_WORDS, parseKeyword } from "./keywords";

describe("parseKeyword (docs/architecture-integrations.md §4.6)", () => {
  it("[FL-002] ALTA in any case, with or without accents, spaces or punctuation around", () => {
    for (const text of ["ALTA", "alta", " Alta ", "Álta", "ALTA.", "¡Alta!"]) expect(parseKeyword(text)).toEqual({ kind: "ALTA" });
  });

  it("[FL-005] BAJA, and only as the whole message", () => {
    expect(parseKeyword("baja")).toEqual({ kind: "BAJA" });
    expect(parseKeyword("BAJA.")).toEqual({ kind: "BAJA" });
    expect(parseKeyword("dar de baja el módem")).toBeNull();
    expect(parseKeyword("la potencia está baja")).toBeNull();
  });

  it("[FL-016] ÓRDENES with or without the accent, and TURNO for supervisors (FL-074)", () => {
    for (const text of ["ÓRDENES", "ORDENES", "órdenes", "Ordenes?"]) expect(parseKeyword(text)).toEqual({ kind: "ORDENES" });
    expect(parseKeyword("Turno")).toEqual({ kind: "TURNO" });
    expect(parseKeyword("¿qué órdenes tengo hoy?")).toBeNull();
    expect(parseKeyword("mi turno empieza a las 7")).toBeNull();
  });

  it("[FL-101] ALTA with a join code, written with a hyphen, a space or together", () => {
    for (const text of ["ALTA G07-4F2K", "alta g07-4f2k", "Alta G07 4F2K", "ALTA G074F2K", "  alta   G07-4F2K  "]) {
      expect(parseKeyword(text)).toEqual({ kind: "ALTA_CODE", code: "G07-4F2K" });
    }
    expect(parseKeyword("ALTA JT-ABCD")).toEqual({ kind: "ALTA_CODE", code: "JT-ABCD" });
  });

  it("ordinary messages that start with a keyword are not keywords", () => {
    for (const text of ["alta por favor", "alta porfavor", "ALTA de la ONU", "alta", "hola"]) {
      const parsed = parseKeyword(text);
      expect(parsed === null || parsed.kind === "ALTA").toBe(true);
    }
    expect(parseKeyword("alta porfavor")).toBeNull();
    expect(parseKeyword("alta por favor")).toBeNull();
    expect(parseKeyword("")).toBeNull();
  });

  it("the words the staff sees keep their accents", () => {
    expect(KEYWORD_WORDS.ORDENES).toBe("ÓRDENES");
    for (const word of Object.values(KEYWORD_WORDS)) expect(parseKeyword(word)).not.toBeNull();
  });
});
