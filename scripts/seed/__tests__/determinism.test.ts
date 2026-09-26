// Determinism of the seed (docs/seed-spec.md §1, "Determinismo"): two runs of `seed:generate` in
// separate processes write byte-for-byte the same files, the committed data directory is exactly
// that output (a change of copy/, the manual or the catalog that was not regenerated fails here), and
// the generator never formats with `Intl` or `toLocale*`.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { findIntlUsages } from "../../lint/no-intl";
import { buildSeed } from "../generate/build";
import { DATA_DIR, fromRoot } from "../lib/paths";
import { readDataDir } from "../validate/bundle";

const scratch = mkdtempSync(join(tmpdir(), "cuadrilla-seed-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Environment of the child runs: no CI flag and no forbidden-terms list, which only decide invariant 11. */
function childEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "CI" && key !== "FORBIDDEN_TERMS"));
}

function generateInto(name: string): Map<string, string> {
  const out = join(scratch, name);
  execFileSync(process.execPath, ["--import", "tsx", fromRoot("scripts/seed/generate.ts"), "--out", out, "--quiet"], { cwd: fromRoot(), env: childEnv(), stdio: "pipe" });
  return readDataDir(out);
}

describe("seed:generate is deterministic", () => {
  const first = generateInto("first");
  const second = generateInto("second");

  it("two runs in separate processes write the same files, byte for byte", () => {
    expect([...second.keys()].sort()).toEqual([...first.keys()].sort());
    for (const [path, text] of first) expect({ path, same: second.get(path) === text }).toEqual({ path, same: true });
    expect(first.size).toBeGreaterThan(70);
  });

  it("the committed data directory is that output", () => {
    const committed = readDataDir(fromRoot(DATA_DIR));
    expect([...committed.keys()].sort()).toEqual([...first.keys()].sort());
    for (const [path, text] of first) expect({ path, same: committed.get(path) === text }).toEqual({ path, same: true });
  });

  it("two builds in one process are equal too, so no state leaks between runs", () => {
    const a = buildSeed().files;
    const b = buildSeed().files;
    expect([...a.entries()]).toEqual([...b.entries()]);
    for (const [path, text] of a) expect(first.get(path)).toBe(text);
  });

  it("the generator formats without Intl or toLocale*", () => {
    const dir = fromRoot("scripts/seed/generate");
    const files: string[] = [];
    const walk = (path: string): void => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const full = join(path, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts")) files.push(full);
      }
    };
    walk(dir);
    expect(files.length).toBeGreaterThan(10);
    expect(files.flatMap((file) => findIntlUsages(file, readFileSync(file, "utf8")))).toEqual([]);
  });
});
