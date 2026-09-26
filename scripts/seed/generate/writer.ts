// Writes the seed to its data directory: every file of the build, byte for byte, and nothing else. A
// file of a previous generation that the build no longer produces (a section removed from the
// manual, a renamed template) is deleted, so the directory is always exactly one generation.
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

function existingFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (path: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(path);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(path, entry);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(dir, full).split("\\").join("/"));
    }
  };
  walk(dir);
  return out;
}

export interface WriteSummary {
  readonly written: number;
  readonly removed: readonly string[];
}

export function writeSeed(dir: string, files: ReadonlyMap<string, string>): WriteSummary {
  const removed = existingFiles(dir).filter((path) => !files.has(path) && /\.(?:json|md)$/.test(path));
  for (const path of removed) rmSync(join(dir, path));
  for (const [path, text] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  return { written: files.size, removed };
}
