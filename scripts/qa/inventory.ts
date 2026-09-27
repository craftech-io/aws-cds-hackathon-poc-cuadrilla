// What the deployed verification needs to know about the stage (docs/test-plan.md §6.1), from THIS
// app's own SST state (`sst state export`, as scripts/smoke/interim.ts does), never from an account-wide
// listing: the account is shared with another project. The checkpoint is parsed in memory and never
// printed nor written; only the names below leave this module.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { edgeInventory, stateInventory } from "../smoke/interim";

export interface StageInventory {
  /** The Bff's Function URL (the only one with AuthType NONE). */
  readonly bffUrl: string;
  readonly tables: readonly string[];
  readonly functions: readonly string[];
  readonly userPoolId: string;
  /** App clients of the pool by their name (`ConsoleWeb`, `GuestSignup`, `QaProbe`); public ids. */
  readonly clients: Readonly<Record<string, string>>;
}

type StateResource = { type?: unknown; outputs?: Record<string, unknown> };

export function inventoryOf(state: unknown): StageInventory {
  const resources = ((state as { latest?: { resources?: unknown } } | null)?.latest?.resources ?? []) as StateResource[];
  const edge = edgeInventory(state);
  const [bffUrl] = edge.publicFunctionUrls;
  if (edge.publicFunctionUrls.length !== 1 || bffUrl === undefined) throw new Error(`expected exactly one public Function URL, found ${edge.publicFunctionUrls.length}`);
  const pools = resources.filter((resource) => resource.type === "aws:cognito/userPool:UserPool").map((resource) => String(resource.outputs?.id ?? ""));
  const [userPoolId] = pools;
  if (pools.length !== 1 || userPoolId === undefined || userPoolId === "") throw new Error(`expected exactly one user pool, found ${pools.length}`);
  const clients: Record<string, string> = {};
  for (const resource of resources.filter((entry) => entry.type === "aws:cognito/userPoolClient:UserPoolClient")) {
    clients[String(resource.outputs?.name ?? "")] = String(resource.outputs?.id ?? "");
  }
  const { tables, functions } = stateInventory(state);
  return { bffUrl: bffUrl.replace(/\/$/, ""), tables, functions, userPoolId, clients };
}

/** The physical name of a table by its logical SST name (`Leads` → `…-LeadsTable-…`). */
export function tableOf(inventory: StageInventory, logical: string): string {
  const found = inventory.tables.filter((name) => name.includes(`-${logical}Table-`));
  if (found.length !== 1 || found[0] === undefined) throw new Error(`expected one ${logical} table, found ${found.length}`);
  return found[0];
}

export async function loadInventory(): Promise<StageInventory> {
  const { stdout } = await promisify(execFile)("npx", ["sst", "state", "export", "--stage", "poc"], { maxBuffer: 256 * 1024 * 1024, timeout: 5 * 60_000 });
  return inventoryOf(JSON.parse(stdout));
}
