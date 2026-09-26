// The real list lives outside the repository, so these tests use made-up terms.
import { describe, expect, it } from "vitest";
import { findTerms, listFromEnv, parseTerms, stripAccents } from "./forbidden-terms";

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
