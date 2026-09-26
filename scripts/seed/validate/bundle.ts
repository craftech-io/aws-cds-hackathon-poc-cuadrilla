// The seed as the invariants read it (docs/seed-spec.md §14): every file of a data directory, parsed
// with its schema, plus the committed media of WP-18. The same bundle comes from the files the
// generator is about to write (before writing them) or from a directory on disk (`seed:validate`).
import { readdirSync, readFileSync, statSync } from "node:fs";
import type { z } from "zod";
import { join, relative } from "node:path";
import { readMedia, type Media } from "../generate/media";
import { DATA_LAYOUT, tableFile, worldFile } from "../lib/paths";
import { QuestionsFile } from "../lib/questions";
import { SEED_TABLES, TableFile, WORLD_TABLES, emptyTables, type SeedItem, type SeedTable, type WorldTable } from "../lib/tables";
import { EvalTemplate, ModelsTemplate, QaMinTemplate, WorldTablesTemplate } from "../lib/worlds";

/** One world of the seed item by item: the demo world of the table files, or the guest template. */
export interface SeedWorld {
  readonly name: "demo" | "guest";
  readonly tables: Readonly<Record<WorldTable, readonly SeedItem[]>>;
}

export interface SeedBundle {
  readonly files: ReadonlyMap<string, string>;
  readonly tables: Readonly<Record<SeedTable, readonly SeedItem[]>>;
  readonly demo?: WorldTablesTemplate;
  readonly guest?: WorldTablesTemplate;
  readonly models?: ModelsTemplate;
  readonly qaMin?: QaMinTemplate;
  readonly evalTemplate?: EvalTemplate;
  readonly questions?: QuestionsFile;
  readonly media: Media;
  /** Files that are missing or do not parse with their schema. */
  readonly problems: readonly string[];
}

/** Every file under `dir`, by its path relative to it (`/` separators). */
export function readDataDir(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (path: string): void => {
    for (const entry of readdirSync(path)) {
      const full = join(path, entry);
      if (statSync(full).isDirectory()) walk(full);
      else files.set(relative(dir, full).split("\\").join("/"), readFileSync(full, "utf8"));
    }
  };
  walk(dir);
  return files;
}

function parse<S extends z.ZodType>(files: ReadonlyMap<string, string>, path: string, schema: S, problems: string[]): z.output<S> | undefined {
  const text = files.get(path);
  if (text === undefined) {
    problems.push(`${path}: missing`);
    return undefined;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    problems.push(`${path}: not valid JSON`);
    return undefined;
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    problems.push(...parsed.error.issues.slice(0, 5).map((issue) => `${path}: ${issue.path.map(String).join(".")} ${issue.message}`));
    return undefined;
  }
  return parsed.data;
}

export function bundleOf(files: ReadonlyMap<string, string>, media: Media = readMedia()): SeedBundle {
  const problems: string[] = [];
  const tables = emptyTables();
  for (const table of SEED_TABLES) {
    const file = parse(files, tableFile(table), TableFile, problems);
    if (file === undefined) continue;
    if (file.table !== table) problems.push(`${tableFile(table)}: declares table ${file.table}`);
    tables[table] = file.items;
  }
  const demo = parse(files, worldFile("demo"), WorldTablesTemplate, problems);
  const guest = parse(files, worldFile("guest"), WorldTablesTemplate, problems);
  const models = parse(files, worldFile("models"), ModelsTemplate, problems);
  const qaMin = parse(files, worldFile("qa-min"), QaMinTemplate, problems);
  const evalTemplate = parse(files, worldFile("eval"), EvalTemplate, problems);
  const questions = parse(files, DATA_LAYOUT.questions, QuestionsFile, problems);
  return {
    files,
    tables,
    media,
    problems,
    ...(demo === undefined ? {} : { demo }),
    ...(guest === undefined ? {} : { guest }),
    ...(models === undefined ? {} : { models }),
    ...(qaMin === undefined ? {} : { qaMin }),
    ...(evalTemplate === undefined ? {} : { evalTemplate }),
    ...(questions === undefined ? {} : { questions }),
  };
}

/** The worlds whose items the invariants check: the demo world of the table files and the guest template. */
export function worldsOf(bundle: SeedBundle): SeedWorld[] {
  const demoTables = Object.fromEntries(WORLD_TABLES.map((table) => [table, bundle.tables[table]])) as Record<WorldTable, readonly SeedItem[]>;
  return [{ name: "demo", tables: demoTables }, ...(bundle.guest === undefined ? [] : [{ name: "guest" as const, tables: bundle.guest.tables }])];
}

/** Items of one entity in a world. */
export function entities(world: SeedWorld, table: WorldTable, entity: string): SeedItem[] {
  return world.tables[table].filter((item) => item.entity === entity);
}

export function str(item: SeedItem, field: string): string {
  const value = item[field];
  return typeof value === "string" ? value : "";
}
