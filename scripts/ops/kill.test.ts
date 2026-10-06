import { describe, expect, it } from "vitest";
import { KillScope } from "@cuadrilla/shared";
import type { KillSwitchAuditEvent } from "../../packages/bff/src/ops/kill-switch";
import { createMemoryRuntimeStore } from "../../packages/bff/src/ops/memory-runtime-store";
import { parseKillArgs, parseKillCommand, readKillStatus, runKill } from "./kill";

function deps() {
  const store = createMemoryRuntimeStore();
  const audits: KillSwitchAuditEvent[] = [];
  return { store, audits, run: (argv: string[]) => runKill(parseKillArgs(argv), { store, audit: async (event) => void audits.push(event) }) };
}

describe("npm run ops:kill (ADR-0019, ADR-0025 §4) [FL-112]", () => {
  it("knows the four scopes, the sign-up's included", () => {
    expect([...KillScope.options].sort()).toEqual(["AGENT", "ALL", "SIGNUP", "SIMULATOR"]);
    for (const scope of KillScope.options) expect(parseKillArgs(["--scope", scope.toLowerCase(), "--on"]).scope).toBe(scope);
  });

  it("turns the sign-up's cut on and, only from here, off again, auditing KILL_SWITCH_SET as the operator", async () => {
    const { store, audits, run } = deps();
    await run(["--scope", "SIGNUP", "--on", "--reason", "bounces of the authentication emails"]);
    expect((await store.read(["KILL#SIGNUP"])).get("KILL#SIGNUP")).toMatchObject({ scope: "SIGNUP", state: "on", setBy: "OPERATOR" });
    const record = await run(["--scope", "SIGNUP", "--off"]);
    expect(record).toMatchObject({ scope: "SIGNUP", state: "off", setBy: "OPERATOR" });
    expect((await store.read(["KILL#SIGNUP"])).get("KILL#SIGNUP")).toMatchObject({ state: "off" });
    expect(audits.map((event) => [event.action, event.record.state, event.record.setBy])).toEqual([
      ["KILL_SWITCH_SET", "on", "OPERATOR"],
      ["KILL_SWITCH_SET", "off", "OPERATOR"],
    ]);
  });

  it("flips the agent of one world with --clock, and only for the AGENT scope", async () => {
    const { store, run } = deps();
    await run(["--scope", "AGENT", "--on", "--clock", "GLOBAL#isp-demo"]);
    expect((await store.read(["KILL#AGENT#GLOBAL#isp-demo"])).get("KILL#AGENT#GLOBAL#isp-demo")).toMatchObject({ state: "on", clockId: "GLOBAL#isp-demo" });
    expect(() => parseKillArgs(["--scope", "SIGNUP", "--on", "--clock", "GLOBAL#isp-demo"])).toThrow(/only exists for the AGENT scope/);
  });

  it("refuses anything ambiguous before writing: no scope, an unknown one, both or neither of --on and --off", () => {
    expect(() => parseKillArgs(["--on"])).toThrow(/--scope must be one of/);
    expect(() => parseKillArgs(["--scope", "EVERYTHING", "--on"])).toThrow(/--scope must be one of/);
    expect(() => parseKillArgs(["--scope", "SIGNUP", "--on", "--off"])).toThrow(/exactly one of --on and --off/);
    expect(() => parseKillArgs(["--scope", "SIGNUP"])).toThrow(/pass --on or --off/);
    expect(() => parseKillArgs(["--scope", "SIGNUP", "--on", "--reason", "x".repeat(201)])).toThrow(/1 to 200/);
    expect(() => parseKillArgs(["--scope", "SIGNUP", "--on", "--yes"])).toThrow(/unknown argument/);
  });

  it("--status reads the four global switches and writes nothing; it takes no other argument", async () => {
    const { store, run } = deps();
    expect(parseKillCommand(["--status"])).toEqual({ kind: "status" });
    expect(() => parseKillCommand(["--status", "--scope", "AGENT"])).toThrow(/takes no other argument/);
    expect(parseKillCommand(["--scope", "AGENT", "--off"])).toEqual({ kind: "set", request: { scope: "AGENT", on: false } });
    await run(["--scope", "AGENT", "--on", "--reason", "budget monthly"]);
    await store.write("KILL#SIMULATOR", { state: "on" } as never);
    const lines = await readKillStatus(store);
    expect(lines.map((line) => [line.key, line.state])).toEqual([
      ["KILL#ALL", "absent"],
      ["KILL#SIMULATOR", "on"],
      ["KILL#AGENT", "on"],
      ["KILL#SIGNUP", "absent"],
    ]);
    expect(lines[2]).toMatchObject({ setBy: "OPERATOR", reason: "budget monthly" });
  });
});
