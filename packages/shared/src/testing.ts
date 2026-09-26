// Readers of docs/ for the contract tests of this package (never imported by runtime code): the
// enums, ids and flows here must say exactly what the design documents say, so a change on either
// side fails a test instead of drifting.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export function readDoc(path: string): string {
  return readFileSync(`${ROOT}${path}`, "utf8");
}

/** Backticked tokens of `text`, in order: "`A`, `B` (x)" → ["A", "B"]. */
export function backticked(text: string): string[] {
  return [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "");
}

/** Cells of the body rows of the markdown table whose header line starts with `header`. */
export function tableRows(markdown: string, header: string): string[][] {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.startsWith(header));
  if (start === -1) throw new Error(`table not found: ${header}`);
  const rows: string[][] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith("|")) break;
    rows.push(line.slice(1, line.endsWith("|") ? -1 : undefined).split(" | ").map((cell) => cell.trim()));
  }
  return rows;
}

/** The body of the first fenced ```json block after `marker`. */
export function jsonBlockAfter(markdown: string, marker: string): unknown {
  const from = markdown.indexOf(marker);
  const open = markdown.indexOf("```json", from);
  const close = markdown.indexOf("```", open + 7);
  if (from === -1 || open === -1 || close === -1) throw new Error(`json block not found after ${marker}`);
  return JSON.parse(markdown.slice(open + 7, close));
}

/** The text between the first `start` marker and the next `end` after it. */
export function between(markdown: string, start: string, end: string): string {
  const from = markdown.indexOf(start);
  if (from === -1) throw new Error(`marker not found: ${start}`);
  const to = markdown.indexOf(end, from + start.length);
  if (to === -1) throw new Error(`end marker not found after ${start}: ${end}`);
  return markdown.slice(from + start.length, to);
}
