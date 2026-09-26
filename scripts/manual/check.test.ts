// `npm run manual:check` on the committed manual and on copies with one fault each (docs/architecture.md
// §18): a section without id, title or version, a repeated id, a sidecar of another section, a section
// over budget, a cited section that does not exist, §SEG-01 differing from copy/es-MX.ts, and a text
// naming the default operator.
import { describe, expect, it } from "vitest";
import { DEFAULT_OPERATOR_NAME } from "../../packages/bff/src/copy/brand";
import { esMX } from "../../packages/bff/src/copy/es-MX";
import { DATA_DIR, DATA_LAYOUT, fromRoot, manualFile, manualSidecarFile } from "../seed/lib/paths";
import { readDataDir } from "../seed/validate/bundle";
import { SAFETY_SECTION, checkManual } from "./check";

const committed = readDataDir(fromRoot(DATA_DIR));

function withFile(path: string, change: (text: string) => string | undefined): Map<string, string> {
  const files = new Map(committed);
  const next = change(files.get(path) ?? "");
  if (next === undefined) files.delete(path);
  else files.set(path, next);
  return files;
}

describe("manual:check", () => {
  it("passes on the committed manual: 32 sections, §SEG-01 identical to safetyInstruction", () => {
    const report = checkManual(committed);
    expect(report.errors).toEqual([]);
    expect(report.sections.size).toBe(32);
    expect(report.sections.get(SAFETY_SECTION)?.body).toContain(esMX.safetyInstruction);
  });

  it("fails on a section without heading or without version line", () => {
    expect(checkManual(withFile(manualFile("COM-04"), (text) => text.replace(/^# COM-04 · /, "")))).toMatchObject({ errors: expect.arrayContaining([expect.stringMatching(/COM-04\.md: the first line is not/)]) });
    expect(checkManual(withFile(manualFile("COM-04"), (text) => text.replace(/^_Manual v1.*$/m, "")))).toMatchObject({ errors: [expect.stringMatching(/COM-04\.md: no version line/)] });
  });

  it("fails on a repeated id and on a sidecar of another section", () => {
    const repeated = withFile(manualFile("COM-05"), (text) => text.replace("# COM-05 ·", "# COM-04 ·"));
    expect(checkManual(repeated).errors).toEqual(expect.arrayContaining([expect.stringMatching(/the heading says COM-04/), expect.stringMatching(/section COM-04 repeated/)]));
    const sidecar = withFile(manualSidecarFile("DIAG-02"), (text) => text.replace('"sectionId": "DIAG-02"', '"sectionId": "DIAG-03"'));
    expect(checkManual(sidecar).errors).toEqual([expect.stringMatching(/DIAG-02\.md: the sidecar names another section/)]);
    const missing = withFile(manualSidecarFile("DIAG-02"), () => undefined);
    expect(checkManual(missing).errors).toEqual([expect.stringMatching(/DIAG-02\.md: missing or invalid sidecar/)]);
  });

  it("fails on a section over its token budget", () => {
    const long = withFile(manualFile("GEN-02"), (text) => `${text}\n${"La fibra se instala con cuidado y siguiendo el manual. ".repeat(60)}`);
    expect(checkManual(long).errors).toEqual([expect.stringMatching(/GEN-02\.md: about \d+ tokens, over 800/)]);
  });

  it("fails when §SEG-01 differs from safetyInstruction of copy/es-MX.ts", () => {
    const edited = withFile(manualFile(SAFETY_SECTION), (text) => text.replace("al menos 10 metros", "al menos 5 metros"));
    expect(checkManual(edited).errors).toEqual([`§${SAFETY_SECTION} does not carry the text of safetyInstruction of copy/es-MX.ts verbatim`]);
  });

  it("fails when the evaluation set cites a section that does not exist, or a section is missing", () => {
    const cites = withFile(DATA_LAYOUT.questions, (text) => text.replace('"CITED_ANSWER(COM-06)"', '"CITED_ANSWER(COM-09)"'));
    expect(checkManual(cites).errors).toEqual(["the evaluation set cites §COM-09, which does not exist"]);
    const removed = new Map(committed);
    removed.delete(manualFile("CAL-01"));
    removed.delete(manualSidecarFile("CAL-01"));
    expect(checkManual(removed).errors).toEqual(expect.arrayContaining(["the manual has 31 sections, not 32", "the evaluation set cites §CAL-01, which does not exist"]));
  });

  it("fails when a section names the default operator instead of saying \"la operadora\"", () => {
    const named = withFile(manualFile("INS-07"), (text) => text.replace("app de autogestión de la operadora", `app de autogestión de ${DEFAULT_OPERATOR_NAME}`));
    expect(checkManual(named).errors).toEqual([expect.stringMatching(/INS-07\.md: names the default operator/)]);
  });
});
