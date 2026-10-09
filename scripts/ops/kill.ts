// The operator's kill switch (ADR-0019, ADR-0025 §4, docs/architecture.md §17 item 12): turns a
// `Runtime/KILL#<scope>` on or off without a deploy, and audits it (`KILL_SWITCH_SET`, actor OPERATOR).
// It runs with the operator's profile through `sst shell` (the links name `Runtime` and `AuditLog`),
// never in CI and never by a guest. `CostGuard` may only turn a switch on; turning one off is always
// this script.
//
//   ALL        the agent, the simulator, every console write and the sign-up
//   SIMULATOR  the phone simulator
//   AGENT      Harness turns, transcriptions and photo validations (add `--clock <clockId>` for one world)
//   SIGNUP     the own sign-up: `signup.start` and the pre sign-up answer CAP_REACHED and no sign-up
//              code or resend is sent; sign-in, recovery and existing worlds go on
//
//   npm run ops:kill -- --scope SIGNUP --on --reason "bounces of the authentication emails"
//   npm run ops:kill -- --scope SIGNUP --off
//   npm run ops:kill -- --status          (reads the four global switches; writes nothing)
//
// `CostGuard` turns AGENT on for the cost cut (the global ceiling of turns, the hourly agent spend,
// the project budget at 100 %) and SIGNUP for the sign-up's cut; the operator reads why with --status
// and turns it off here once the cause is understood.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ClockId, KillScope } from "@cuadrilla/shared";
import { auditKillSwitch } from "../../packages/bff/src/handlers/cost-guard";
import { createLogger } from "../../packages/bff/src/lib/log";
import { createDynamoRuntimeStore } from "../../packages/bff/src/ops/dynamo-runtime-store";
import { type KillSwitchAuditEvent, KillSwitchRecord, type KillSwitchStore, killSwitchKey, setKillSwitch } from "../../packages/bff/src/ops/kill-switch";
import { parseFlags } from "../channels/cli-args";

export interface KillRequest {
  readonly scope: KillScope;
  readonly on: boolean;
  readonly clockId?: string;
  readonly reason?: string;
}

export const USAGE = "npm run ops:kill -- --scope <ALL|SIMULATOR|AGENT|SIGNUP> --on|--off [--clock <clockId>] [--reason <text>] | --status";

export type KillCommand = { readonly kind: "status" } | { readonly kind: "set"; readonly request: KillRequest };

/** `--status` alone reads; anything else is a write that parseKillArgs validates. */
export function parseKillCommand(argv: readonly string[]): KillCommand {
  if (argv.includes("--status")) {
    if (argv.length !== 1) throw new RangeError(`--status takes no other argument\n${USAGE}`);
    return { kind: "status" };
  }
  return { kind: "set", request: parseKillArgs(argv) };
}

export interface KillStatusLine {
  readonly key: string;
  /** `absent` when the item does not exist (the switch is off). */
  readonly state: "on" | "off" | "absent" | "unreadable";
  readonly setBy?: string;
  readonly setAtReal?: string;
  readonly reason?: string;
}

/** The four global switches as stored; an unparseable item that says "on" still reads as on. */
export async function readKillStatus(store: KillSwitchStore): Promise<KillStatusLine[]> {
  const keys = KillScope.options.map((scope) => killSwitchKey(scope));
  const items = await store.read(keys);
  return keys.map((key): KillStatusLine => {
    const raw = items.get(key);
    if (raw === undefined) return { key, state: "absent" };
    const parsed = KillSwitchRecord.safeParse(raw);
    if (!parsed.success) return { key, state: typeof raw === "object" && raw !== null && Reflect.get(raw, "state") === "on" ? "on" : "unreadable" };
    const { state, setBy, setAtReal, reason } = parsed.data;
    return { key, state, setBy, setAtReal, ...(reason === undefined ? {} : { reason }) };
  });
}

/** The request of the command line; a RangeError for anything ambiguous, so a typo never flips a switch. */
export function parseKillArgs(argv: readonly string[]): KillRequest {
  let scope: string | undefined;
  let on: boolean | undefined;
  let clockId: string | undefined;
  let reason: string | undefined;
  const state = (value: boolean) => () => {
    if (on !== undefined) throw new RangeError("pass exactly one of --on and --off");
    on = value;
  };
  parseFlags(argv, {
    "--scope": (value) => {
      scope = value().toUpperCase();
    },
    "--on": state(true),
    "--off": state(false),
    "--clock": (value) => {
      clockId = value();
    },
    "--reason": (value) => {
      reason = value();
    },
  });
  const parsedScope = KillScope.safeParse(scope);
  if (!parsedScope.success) throw new RangeError(`--scope must be one of ${KillScope.options.join(", ")}\n${USAGE}`);
  if (on === undefined) throw new RangeError(`pass --on or --off\n${USAGE}`);
  if (clockId !== undefined && parsedScope.data !== "AGENT") throw new RangeError("--clock only exists for the AGENT scope");
  if (clockId !== undefined && !ClockId.safeParse(clockId).success) throw new RangeError("--clock is not a clock id");
  if (reason !== undefined && (reason.trim().length === 0 || reason.length > 200)) throw new RangeError("--reason takes 1 to 200 characters");
  return { scope: parsedScope.data, on, ...(clockId === undefined ? {} : { clockId }), ...(reason === undefined ? {} : { reason }) };
}

export interface KillDeps {
  readonly store: KillSwitchStore;
  readonly audit: (event: KillSwitchAuditEvent) => Promise<void>;
}

/** Writes the switch as the operator and audits it. */
export function runKill(request: KillRequest, deps: KillDeps): Promise<KillSwitchRecord> {
  const logger = createLogger({ bindings: { component: "ops-kill" } });
  return setKillSwitch({ store: deps.store, audit: deps.audit, logger }, { ...request, actor: "OPERATOR" });
}

async function main(): Promise<void> {
  const command = parseKillCommand(process.argv.slice(2));
  if (command.kind === "status") {
    for (const line of await readKillStatus(createDynamoRuntimeStore())) {
      const detail = line.setBy === undefined ? "" : ` (by ${line.setBy} at ${line.setAtReal}${line.reason === undefined ? "" : `: ${line.reason}`})`;
      console.log(`ops:kill: ${line.key} ${line.state}${detail}`);
    }
    return;
  }
  const record = await runKill(command.request, { store: createDynamoRuntimeStore(), audit: auditKillSwitch });
  const target = record.clockId === undefined ? `KILL#${record.scope}` : `KILL#AGENT#${record.clockId}`;
  console.log(`ops:kill: ${target} is ${record.state} (audited KILL_SWITCH_SET).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error: unknown) => {
    console.error(`ops:kill: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
