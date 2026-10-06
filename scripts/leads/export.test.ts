import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONSENTS_VERSION } from "@cuadrilla/shared/legal/consents";
import { contactWithdrawal } from "../../packages/bff/src/leads/consent";
import type { LeadStore } from "../../packages/bff/src/leads/store";
import { T0, confirmedLead, hashOf, leadHarness, signupUserId, startLead } from "../../packages/bff/src/leads/testing";
import { EXPORT_COLUMNS, REPO_ROOT, assertOutsideRepo, csvCell, parseExportArgs, runExport } from "./export";
import { assertOperatorMachine } from "./operator-only";

const OUTSIDE = "/var/tmp/leads-export-test.csv";

describe("leads:export [FL-117]", () => {
  let store: LeadStore;
  let written: { path: string; content: string } | undefined;
  const deps = () => ({
    store,
    write: async (path: string, content: string) => {
      written = { path, content };
    },
    now: () => T0,
  });
  const rows = () => (written?.content ?? "").trim().split("\r\n");

  beforeEach(async () => {
    store = leadHarness().store;
    written = undefined;
    await confirmedLead(store, { email: "contactable@example.com", user: 1, sub: "sub-1", userId: signupUserId(1), contact: true, name: "Ana", company: "=HYPERLINK(\"x\")" });
    await confirmedLead(store, { email: "no-contacto@example.com", user: 2, sub: "sub-2", userId: signupUserId(2), contact: false });
    await confirmedLead(store, { email: "success+qa-run-1@simulator.amazonses.com", user: 3, sub: "sub-3", userId: signupUserId(3), contact: true });
    await startLead(store, { email: "pendiente@example.com", user: 4, contact: true });
  });

  it("[FL-117] writes the columns of ADR-0026 in order, and by default only the contactable leads (CONFIRMED, WEB, CONTACT accepted)", async () => {
    expect(await runExport(parseExportArgs(["--out", OUTSIDE]), deps())).toBe(1);
    expect(written?.path).toBe(OUTSIDE);
    expect(rows()[0]).toBe(EXPORT_COLUMNS.join(","));
    expect(EXPORT_COLUMNS).toEqual([
      "leadId", "email", "name", "company", "jobTitle", "locale", "contactConsent", "contactConsentVersion", "termsVersion", "originPoc",
      "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "referrerOrigin", "signupAt", "confirmedAt", "lastLoginAt",
    ]);
    expect(rows()).toHaveLength(2);
    expect(rows()[1]).toContain("contactable@example.com");
    expect(rows()[1]).toContain(`,yes,${CONSENTS_VERSION},${CONSENTS_VERSION},cuadrilla,linkedin,,fibra-2026,,,https://example.org,`);
  });

  it("[FL-117] --all adds the confirmed leads that may not be contacted, with contactConsent = no; never pending leads", async () => {
    expect(await runExport(parseExportArgs(["--out", OUTSIDE, "--all"]), deps())).toBe(2);
    const noContact = rows().find((row) => row.includes("no-contacto@example.com"));
    expect(noContact).toContain(`,no,${CONSENTS_VERSION},`);
    expect(written?.content).not.toContain("pendiente@example.com");
    expect(written?.content).not.toContain("simulator.amazonses.com");
  });

  it("[FL-117] --origin QA exports only the QA seam's leads", async () => {
    expect(await runExport(parseExportArgs(["--out", OUTSIDE, "--origin", "QA", "--all"]), deps())).toBe(1);
    expect(rows()[1]).toContain("success+qa-run-1@simulator.amazonses.com");
  });

  it("[FL-117] escapes every cell that starts with =, +, - or @ against formula injection", async () => {
    await runExport(parseExportArgs(["--out", OUTSIDE]), deps());
    expect(rows()[1]).toContain(`"'=HYPERLINK(""x"")"`);
    for (const value of ["=1+1", "+cmd", "-2", "@SUM(A1)", "\tx"]) expect(csvCell(value).replace(/^"/, "").startsWith("'"), value).toBe(true);
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('di "hola"')).toBe('"di ""hola"""');
    expect(csvCell(undefined)).toBe("");
  });

  it("[FL-117] records EXPORTED on each exported lead, without the email", async () => {
    await runExport(parseExportArgs(["--out", OUTSIDE]), deps());
    const events = await store.listEvents(hashOf("contactable@example.com"));
    expect(events.map((event) => [event.kind, event.actor])).toContainEqual(["EXPORTED", "OPERATOR"]);
    expect(JSON.stringify(events)).not.toContain("@");
    expect((await store.listEvents(hashOf("no-contacto@example.com"))).map((event) => event.kind)).not.toContain("EXPORTED");
  });

  it("[FL-117] a lead whose contact was withdrawn leaves the default export", async () => {
    await store.withdrawContact(hashOf("contactable@example.com"), contactWithdrawal("es-MX", T0), T0);
    expect(await runExport(parseExportArgs(["--out", OUTSIDE]), deps())).toBe(0);
  });

  it("[FL-117] refuses a path inside the repository and needs --out", async () => {
    await expect(runExport(parseExportArgs(["--out", "leads.csv"]), { ...deps(), cwd: REPO_ROOT })).rejects.toThrow("outside the repository");
    await expect(runExport(parseExportArgs(["--out", join(REPO_ROOT, "docs", "leads.csv")]), deps())).rejects.toThrow("outside the repository");
    expect(() => assertOutsideRepo(REPO_ROOT)).toThrow("outside the repository");
    expect(assertOutsideRepo(OUTSIDE)).toBe(OUTSIDE);
    expect(written).toBeUndefined();
    expect(() => parseExportArgs([])).toThrow("--out is required");
    expect(() => parseExportArgs(["--out", OUTSIDE, "--all", "--contactable"])).toThrow();
    expect(() => parseExportArgs(["--out", OUTSIDE, "--origin", "EVERYONE"])).toThrow();
  });

  describe("a symlink that points into the repository", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "leads-export-"));
      symlinkSync(REPO_ROOT, join(dir, "repo"));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("[FL-117] is refused as well", () => {
      expect(() => assertOutsideRepo(join(dir, "repo", "leads.csv"))).toThrow("outside the repository");
    });
  });
});

describe("the lead scripts outside the operator's machine [FL-117]", () => {
  it("[FL-117] refuse to run in CI", () => {
    expect(() => assertOperatorMachine({ CI: "true" })).toThrow("never in CI");
    expect(() => assertOperatorMachine({ CI: "1" })).toThrow("never in CI");
    expect(() => assertOperatorMachine({})).not.toThrow();
    expect(() => assertOperatorMachine({ CI: "false" })).not.toThrow();
  });
});
