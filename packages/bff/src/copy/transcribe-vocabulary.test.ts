// Guards the vocabulary file before it reaches CreateVocabulary: one invalid row leaves the vocabulary
// FAILED and breaks the deploy (docs/architecture.md §18). The rules are written here on their own,
// from the Transcribe guide for table files and the es-MX character set, not imported from the module.
import { describe, expect, it } from "vitest";
import { VOCABULARY_CONTENT_TYPE, VOCABULARY_HEADER, VOCABULARY_NAME, VOCABULARY_OBJECT_KEY, VOCABULARY_ROWS, vocabularyFile } from "./transcribe-vocabulary";

const FILE = vocabularyFile();
const LINES = FILE.split("\n");
const ROWS = LINES.slice(1).map((line) => line.split("\t"));

// es-MX character set of Transcribe custom vocabularies: a-z, A-Z, apostrophe, hyphen, and
// Á á É é Í í Ó ó Ú ú Ñ ñ ü. No period: CreateVocabulary rejects "O.N.U." in es-MX.
const ES_CHARSET = /^[a-zA-Z'\-ÁáÉéÍíÓóÚúÑñü]+$/u;
const WORD = /^[a-zA-ZÁáÉéÍíÓóÚúÑñü']+$/u;

/** Problems of one Phrase against the guide's rules; empty when valid. */
function phraseProblems(phrase: string): string[] {
  const problems: string[] = [];
  if (!ES_CHARSET.test(phrase)) problems.push("character outside the es set, a space or a digit");
  if (/^['-]/.test(phrase)) problems.push("starts with an apostrophe or hyphen");
  if (/['-]$/.test(phrase)) problems.push("ends with an apostrophe or hyphen");
  if (/--|''/.test(phrase)) problems.push("repeated hyphen or apostrophe");
  for (const segment of phrase.split("-")) {
    if (!WORD.test(segment)) problems.push(`segment "${segment}" is not a word`);
  }
  if ([...phrase].length > 256) problems.push("longer than 256 characters");
  return problems;
}

describe("Transcribe vocabulary cuadrilla-poc-ftth-es-mx (table format)", () => {
  it("is published as a plain text .txt file under Seed/transcribe/", () => {
    expect(VOCABULARY_NAME).toBe("cuadrilla-poc-ftth-es-mx");
    expect(VOCABULARY_OBJECT_KEY).toBe("transcribe/vocabulary-v002.txt");
    expect(VOCABULARY_OBJECT_KEY.endsWith(".txt")).toBe(true);
    expect(VOCABULARY_CONTENT_TYPE).toBe("text/plain; charset=utf-8");
  });

  it("starts with the exact header and has exactly 3 TABs on every row, header included", () => {
    expect(LINES[0]).toBe("Phrase\tSoundsLike\tIPA\tDisplayAs");
    expect(VOCABULARY_HEADER).toEqual(["Phrase", "SoundsLike", "IPA", "DisplayAs"]);
    for (const line of LINES) expect(line.split("\t").length - 1, line).toBe(3);
    expect(LINES).toHaveLength(VOCABULARY_ROWS.length + 1);
    expect(FILE.endsWith("\n")).toBe(false);
    expect(FILE).not.toMatch(/\r/);
  });

  it("weighs at most 50 KB in UTF-8", () => {
    expect(new TextEncoder().encode(FILE).byteLength).toBeLessThanOrEqual(50 * 1024);
  });

  it("leaves SoundsLike and IPA empty on every row", () => {
    for (const [, soundsLike, ipa] of ROWS) {
      expect(soundsLike).toBe("");
      expect(ipa).toBe("");
    }
  });

  it("every Phrase follows the es-MX charset and the hyphen rules", () => {
    for (const [phrase = ""] of ROWS) expect(phraseProblems(phrase), phrase).toEqual([]);
    const phrases = ROWS.map(([phrase]) => phrase);
    expect(new Set(phrases).size).toBe(phrases.length);
  });

  it("the rule checker rejects the rows that break CreateVocabulary", () => {
    for (const bad of ["patch cord", "O.N.U.", "O.N.U", "luz-P.O.N.", "-roseta", "roseta-", "luz--roja", "1490", "S.C./A.P.C.", "Ü", "fibra óptica", "patch\tcord"]) {
      expect(phraseProblems(bad), bad).not.toEqual([]);
    }
  });

  it("DisplayAs is set for every hyphenated phrase (acronyms included), without TABs or line breaks", () => {
    for (const [phrase = "", , , displayAs = ""] of ROWS) {
      expect(displayAs).not.toMatch(/[\t\r\n]/);
      if (phrase.includes("-")) expect(displayAs.trim(), phrase).not.toBe("");
    }
  });

  it("carries the FTTH terms of docs/architecture-integrations.md §5", () => {
    const shown = new Map(ROWS.map(([phrase = "", , , displayAs = ""]) => [displayAs === "" ? phrase : displayAs, phrase]));
    for (const term of ["ONU", "OLT", "PON", "LOS", "SC/APC", "dBm", "medidor de potencia", "caja terminal", "patch cord", "luz roja"]) expect(shown.has(term), term).toBe(true);
    for (const word of ["roseta", "drop", "acometida", "conector", "fusión", "empalme", "parpadea", "cordón", "pigtail", "splitter"]) expect(shown.has(word), word).toBe(true);
    expect(shown.get("SC/APC")).toBe("ese-ce-a-pe-ce");
    expect(shown.get("ONU")).toBe("o-ene-u");
  });
});
