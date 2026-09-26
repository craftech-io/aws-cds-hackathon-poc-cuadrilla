// The real list lives outside the repository, so these tests use made-up terms.
import { describe, expect, it } from "vitest";
import { findTerms, isBinary, listFromEnv, parseTerms, stripAccents, termPattern } from "./forbidden-terms";

const TWO_WORD_BRAND = "Norte Grande";

describe("parseTerms", () => {
  it("skips blanks and comments and numbers the terms in list order", () => {
    const terms = parseTerms("# comment\n\nAcmeport\n  Norte Grande  \n");
    expect(terms.map((term) => term.index)).toEqual([1, 2]);
  });

  it("matches single words in any case and with or without accents by default", () => {
    const terms = parseTerms("Bogavante");
    expect(findTerms("f", "bogavante y BOGAVANTE y Bógavante", terms)).toHaveLength(1);
    expect(findTerms("f", "x\nBógavante", terms)).toEqual([{ source: "f", line: 2, term: 1 }]);
  });

  it("matches whole words only", () => {
    const terms = parseTerms("acme");
    expect(findTerms("f", "acmeport, acme_ltd, 2acme", terms)).toEqual([]);
    expect(findTerms("f", "(acme) acme-port", terms)).toHaveLength(1);
  });

  it("matches names of several words with their capitals and accents, so ordinary Spanish passes", () => {
    const terms = parseTerms(TWO_WORD_BRAND);
    expect(findTerms("f", "Lo reviso mañana temprano.", terms)).toEqual([]);
    expect(findTerms("f", "Viajamos al norte grande del país.", terms)).toEqual([]);
    expect(findTerms("f", "Viajamos al Norte grande del país.", terms)).toEqual([]);
    expect(findTerms("f", `Bienvenido a ${TWO_WORD_BRAND}`, terms)).toHaveLength(1);
    expect(findTerms("f", `Bienvenido a ${TWO_WORD_BRAND.replace(" ", "\t ")}`, terms)).toHaveLength(1);
  });

  it("honours per-term flags", () => {
    const exact = parseTerms("Norte Grande|ia");
    expect(findTerms("f", "norte grandé", exact)).toHaveLength(1);
    const caseSensitiveWord = parseTerms("Delta|ce");
    expect(findTerms("f", "delta", caseSensitiveWord)).toEqual([]);
    expect(findTerms("f", "Delta", caseSensitiveWord)).toHaveLength(1);
  });

  it("escapes regular-expression characters of a term", () => {
    expect(findTerms("f", "a.b", parseTerms("a+b"))).toEqual([]);
    expect(findTerms("f", "x a+b y", parseTerms("a+b"))).toHaveLength(1);
  });

  it("strips accents with Unicode normalization", () => {
    expect(stripAccents("Árbol pingüino canción")).toBe("Arbol pinguino cancion");
  });
});

describe("termPattern (shared with the neutral-surfaces guard)", () => {
  it("matches a whole word, with the case and accent options it is given", () => {
    const folded = termPattern("Canción", { ignoreCase: true, ignoreAccents: true });
    expect(folded.test(stripAccents("una CANCION nueva"))).toBe(true);
    expect(folded.test(stripAccents("canciones"))).toBe(false);
    const exact = termPattern("Canción", { ignoreCase: false, ignoreAccents: false });
    expect(exact.test("una Canción")).toBe(true);
    expect(exact.test("una canción")).toBe(false);
    expect(exact.test("una Cancion")).toBe(false);
  });

  it("joins the words of a name by any run of whitespace and lets a hyphen separate words", () => {
    const name = termPattern("norte grande", { ignoreCase: true, ignoreAccents: true });
    expect(name.test("el Norte \t Grande")).toBe(true);
    expect(name.test("el norte-grande")).toBe(false);
    expect(termPattern("acme", { ignoreCase: true, ignoreAccents: true }).test("acme-port")).toBe(true);
  });

  it("is the pattern parseTerms builds", () => {
    expect(parseTerms("Bogavante")[0]?.pattern.source).toBe(termPattern("Bogavante", { ignoreCase: true, ignoreAccents: true }).source);
  });
});

describe("isBinary", () => {
  it("treats a buffer with a NUL byte in its head as binary", () => {
    expect(isBinary(Buffer.from("texto plano"))).toBe(false);
    expect(isBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a]))).toBe(true);
  });
});

describe("listFromEnv", () => {
  it("fails closed in CI when the list is absent or empty", () => {
    expect(listFromEnv({ CI: "true" })).toMatchObject({ ok: false, fatal: true });
    expect(listFromEnv({ CI: "true", FORBIDDEN_TERMS: "  \n# only a comment\n" })).toMatchObject({ ok: false, fatal: true });
  });

  it("only warns on a local run without a list", () => {
    expect(listFromEnv({})).toMatchObject({ ok: false, fatal: false });
  });

  it("never puts a term in its messages", () => {
    const status = listFromEnv({ CI: "true", FORBIDDEN_TERMS: "" });
    expect(status.ok ? "" : status.message).not.toMatch(/Acme/);
    expect(listFromEnv({ FORBIDDEN_TERMS: "Acmeport" })).toMatchObject({ ok: true });
  });
});
