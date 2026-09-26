import { describe, expect, it } from "vitest";
import { errorCodeOf } from "./result";
import { consoleCaseUrl, sectionsCitedIn } from "./rules-content";
import { CASE_ID, OTHER_CASE_ID, SHA_CERT, decide, entryOf, facts, reply, summary, system } from "./testing";

const customer = (overrides: Record<string, unknown> = {}) => ({ kind: "EMAIL" as const, role: "CUSTOMER" as const, fence: { allowed: true, reason: "SES_SIMULATOR" }, ...overrides });
const zoneChief = { kind: "EMAIL" as const, role: "ZONE_CHIEF" as const, fence: { allowed: true } };
const certificateEmail = (overrides: Record<string, unknown> = {}) =>
  system("CERTIFICATE_EMAIL", { channel: "EMAIL", form: "EMAIL", text: "Tu acta de instalación va adjunta.", workOrderId: "wo-24817", attachmentSha256: SHA_CERT, ...overrides });
const closedOrder = facts({ certificate: { workOrderStatus: "CLOSED", sha256: SHA_CERT } });

describe("CP-RECIPIENT-FENCE: email only inside the world's fence", () => {
  it("follows the verdict of the recipient fence and the world's daily cap", () => {
    expect(summary(decide({ message: certificateEmail(), recipient: customer(), facts: closedOrder }))).toBe("ALLOW");
    expect(summary(decide({ message: certificateEmail(), recipient: customer({ fence: { allowed: false, reason: "OWN_DOMAIN" } }), facts: closedOrder }))).toBe(
      "DENY CP-RECIPIENT-FENCE RECIPIENT_NOT_ALLOWED",
    );
    expect(entryOf({ message: certificateEmail(), recipient: customer({ fence: { allowed: false, reason: "OWN_DOMAIN" } }), facts: closedOrder }, "CP-RECIPIENT-FENCE").detail).toBe("OWN_DOMAIN");
    expect(summary(decide({ message: certificateEmail(), recipient: customer({ emailsLeftToday: 0 }), facts: closedOrder }))).toBe("DENY CP-RECIPIENT-FENCE EMAIL_CAP_REACHED");
  });

  it("does not apply to WhatsApp", () => {
    expect(entryOf({}, "CP-RECIPIENT-FENCE")).toEqual({ ruleId: "CP-RECIPIENT-FENCE", result: "NOT_APPLICABLE" });
  });
});

describe("CP-CERT-EVIDENCE: the certificate of a closed order, byte for byte", () => {
  const document = system("CERTIFICATE", { form: "DOCUMENT", workOrderId: "wo-24817", attachmentSha256: SHA_CERT, inResponseToInbound: true });

  it("allows the stored PDF of a CLOSED order, by email and on WhatsApp", () => {
    expect(summary(decide({ message: document, facts: closedOrder }))).toBe("ALLOW");
    expect(summary(decide({ message: certificateEmail(), recipient: customer(), facts: closedOrder }))).toBe("ALLOW");
  });

  it("denies it without the order, before closing, without a PDF or with other bytes", () => {
    expect(summary(decide({ message: document }))).toBe("DENY CP-CERT-EVIDENCE CERT_MISSING");
    expect(summary(decide({ message: document, facts: facts({ certificate: { workOrderStatus: "FAILED_VISIT", sha256: SHA_CERT } }) }))).toBe("DENY CP-CERT-EVIDENCE CERT_ORDER_NOT_CLOSED");
    expect(summary(decide({ message: document, facts: facts({ certificate: { workOrderStatus: "CLOSED" } }) }))).toBe("DENY CP-CERT-EVIDENCE CERT_MISSING");
    expect(summary(decide({ message: { ...document, attachmentSha256: "d".repeat(64) }, facts: closedOrder }))).toBe("DENY CP-CERT-EVIDENCE CERT_HASH_MISMATCH");
    const { attachmentSha256: _omitted, ...withoutAttachment } = document;
    expect(summary(decide({ message: withoutAttachment, facts: closedOrder }))).toBe("DENY CP-CERT-EVIDENCE CERT_HASH_MISMATCH");
  });
});

describe("CP-NO-SENSITIVE-ASK and CP-NO-FOREIGN-LINKS: what no text may carry", () => {
  it("denies a request for an ID, bank data or a payment written by code or by the agent", () => {
    expect(summary(decide({ message: reply({ text: "Mándame tu INE para registrarte." }) }))).toBe("DENY CP-NO-SENSITIVE-ASK SENSITIVE_ASK");
    expect(entryOf({ message: reply({ text: "Cóbrale el mes en efectivo." }) }, "CP-NO-SENSITIVE-ASK")).toMatchObject({ result: "FAIL", detail: "pattern ask-payment" });
    expect(summary(decide({ message: reply({ text: "Nunca le pidas su INE al cliente." }) }))).toBe("ALLOW");
  });

  it("judges a person's text on the bridge only for links: it is masked, not censored", () => {
    const relay = (text: string) => system("RELAY", { author: "PERSON", text, caseId: CASE_ID });
    expect(entryOf({ message: relay("Pásame tu contraseña del portal") }, "CP-NO-SENSITIVE-ASK")).toMatchObject({ result: "NOT_APPLICABLE" });
    expect(summary(decide({ message: relay("Revisa https://ejemplo-falso.xyz/guia") }))).toBe("DENY CP-NO-FOREIGN-LINKS FOREIGN_LINK");
  });

  it("denies links, domains, emails and phones in any text", () => {
    for (const text of ["Entra a www.algo-raro.com", "Escríbeme a alguien@correo.com", "Llama al 55 1234 5678", "Checa soporte.mx"]) {
      expect(summary(decide({ message: reply({ text }) }))).toBe("DENY CP-NO-FOREIGN-LINKS FOREIGN_LINK");
    }
  });

  it("admits the console link of its own case in a zone chief alert, and no other URL", () => {
    const alert = (text: string, caseId: string = CASE_ID) => system("ZONE_CHIEF_ALERT", { channel: "EMAIL", form: "EMAIL", caseId, text });
    expect(consoleCaseUrl(CASE_ID)).toBe(`https://cuadrilla.demo.craftech.io/app/cases/${CASE_ID}`);
    expect(summary(decide({ message: alert(`Caso sin atender: ${consoleCaseUrl(CASE_ID)}`), recipient: zoneChief }))).toBe("ALLOW");
    expect(summary(decide({ message: alert(`Caso sin atender: ${consoleCaseUrl(OTHER_CASE_ID)}`), recipient: zoneChief }))).toBe("DENY CP-NO-FOREIGN-LINKS FOREIGN_LINK");
    expect(summary(decide({ message: reply({ text: `Mira ${consoleCaseUrl(CASE_ID)}` }) }))).toBe("DENY CP-NO-FOREIGN-LINKS FOREIGN_LINK");
  });
});

describe("CP-CITATION: policy and procedure only from the manual sections of the turn", () => {
  const cited = (overrides: Record<string, unknown> = {}) => reply({ text: "Hasta 15 m no tiene costo (Manual v1, §COM-04).", claimsPolicy: true, ...overrides });
  const inTurn = facts({ turnSections: ["COM-04", "COM-02"] });

  it("allows a reply that cites a section returned in the same turn", () => {
    expect(summary(decide({ message: cited(), facts: inTurn }))).toBe("ALLOW");
    expect(summary(decide({ message: cited({ text: "Hasta 15 m no tiene costo.", citations: ["COM-04"] }), facts: inTurn }))).toBe("ALLOW");
  });

  it("denies a policy statement without a section, or a section the turn did not return", () => {
    expect(summary(decide({ message: cited({ text: "Hasta 15 m no tiene costo." }), facts: inTurn }))).toBe("DENY CP-CITATION CITATION_MISSING");
    expect(summary(decide({ message: cited({ text: "Revisa el cordón (Manual v1, §DIAG-02)." }), facts: inTurn }))).toBe("DENY CP-CITATION CITATION_NOT_IN_TURN");
    expect(summary(decide({ message: cited({ citations: ["DIAG-02"] }), facts: inTurn }))).toBe("DENY CP-CITATION CITATION_NOT_IN_TURN");
    expect(errorCodeOf(decide({ message: cited({ text: "Hasta 15 m no tiene costo." }), facts: inTurn }))).toBe("GROUNDING_FAIL");
  });

  it("fails closed when the turn's sections are unknown, and ignores replies without policy statements", () => {
    expect(summary(decide({ message: cited() }))).toBe("DENY CP-CITATION TURN_SECTIONS_UNKNOWN");
    expect(entryOf({ message: reply() }, "CP-CITATION")).toMatchObject({ result: "NOT_APPLICABLE", detail: "no policy statement" });
    expect(entryOf({ message: system("CASE_NOTICE", { text: "Revisa §COM-04", inResponseToInbound: true }) }, "CP-CITATION")).toMatchObject({ result: "NOT_APPLICABLE" });
  });

  it("reads the sections a text cites in the manual's citation format", () => {
    expect(sectionsCitedIn("Limpia el conector (Manual v1, §DIAG-02) y revisa §MED-01 y §DIAG-02.")).toEqual(["DIAG-02", "MED-01"]);
    expect(sectionsCitedIn("§XYZ-01 no es una sección")).toEqual([]);
  });
});
