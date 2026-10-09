// `/join` (FL-089): the keyword is the BFF's poster keyword, the QR never leaves the site, both
// languages carry the same keys, and nothing visible names the contest nor the operator.
import { describe, expect, it } from "vitest";
import { esMX } from "@cuadrilla/bff/copy/es-MX";
import { enGloss } from "@cuadrilla/bff/copy/en-gloss";
import { JOIN_KEYWORD as POSTER_KEYWORD } from "@cuadrilla/bff/routers/people";
import { findNeutralTerms } from "../../../../../scripts/lint/neutral-terms";
import { joinCopy } from "./copy";
import { JOIN_KEYWORD, SIMULATOR_PATH, simulatorUrl } from "./join-model";

describe("join page [FL-089]", () => {
  it("asks for the keyword of the BFF's poster, which the product's poster text names", () => {
    expect(JOIN_KEYWORD).toBe(POSTER_KEYWORD);
    expect(esMX.optInPoster).toContain(JOIN_KEYWORD);
    expect(enGloss.optInPoster).toContain(JOIN_KEYWORD);
  });

  it("points the QR to the console's simulator on the same site", () => {
    expect(SIMULATOR_PATH).toBe("/app/simulator");
    expect(simulatorUrl("https://cuadrilla.example.com")).toBe("https://cuadrilla.example.com/app/simulator");
    expect(new URL(simulatorUrl("http://127.0.0.1:4173")).origin).toBe("http://127.0.0.1:4173");
  });

  it("has the same keys in both languages, tú in Spanish and no word of the contest", () => {
    expect(Object.keys(joinCopy.en).sort()).toEqual(Object.keys(joinCopy.es).sort());
    const voseo = /\b(?:escaneá|tocá|enviá|abrí|tenés|podés|volvé)\b/i;
    for (const text of Object.values(joinCopy.es)) expect(text).not.toMatch(voseo);
    for (const lang of ["es", "en"] as const) expect(findNeutralTerms(`join.${lang}`, Object.values(joinCopy[lang]).join("\n"))).toEqual([]);
  });
});
