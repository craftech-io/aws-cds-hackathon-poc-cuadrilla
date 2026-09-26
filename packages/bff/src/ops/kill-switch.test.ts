import { describe, expect, it } from "vitest";
import { ToolError } from "@cuadrilla/shared";
import type { Clock } from "../lib/clock";
import { createLogger } from "../lib/log";
import {
  KILL_CACHE_TTL_MS,
  type KillStatus,
  type KillSwitchAuditEvent,
  type KillSwitchStore,
  SERVICE_PAUSED_NOTICE,
  WORLD_KILL_TTL_SECONDS,
  agentKillDecision,
  blockingScope,
  createKillSwitchReader,
  killSwitchKey,
  setKillSwitch,
  toolKillGate,
} from "./kill-switch";
import { createMemoryRuntimeStore } from "./memory-runtime-store";

const REAL = Date.parse("2026-10-20T15:00:00.000Z");
const QA_WORLD = "qa-812-1-sc-14";
const OTHER_QA_WORLD = "qa-812-1-sc-02";

function movableClock(start = REAL): Clock & { advance(ms: number): void } {
  let now = start;
  return { now: async () => new Date(now), advance: (ms) => void (now += ms) };
}

/** A memory store that counts reads, standing for `Runtime` shared by every container. */
function countingStore() {
  const memory = createMemoryRuntimeStore();
  let reads = 0;
  let failing = false;
  const store: KillSwitchStore = {
    read: async (keys) => {
      reads += 1;
      if (failing) throw new Error("Runtime is down");
      return memory.read(keys);
    },
    write: (key, record, expiresAt) => memory.write(key, record, expiresAt),
  };
  return { memory, store, reads: () => reads, fail: (value: boolean) => void (failing = value) };
}

const TOOLS = ["get_work_orders", "get_work_order", "get_onu_status", "search_procedures", "get_checklist", "validate_install_photo", "update_checklist", "send_whatsapp", "record_troubleshooting_step", "escalate_case", "close_installation"];

describe("kill switch status", () => {
  it("[FL-100] reads the global switches and the AGENT switch of the world asked about, world by world", async () => {
    const { store } = countingStore();
    const clock = movableClock();
    await setKillSwitch({ store, realClock: clock }, { scope: "AGENT", clockId: QA_WORLD, on: true, actor: "QA" });
    const reader = createKillSwitchReader({ store, realClock: clock });
    expect(await reader.status(QA_WORLD)).toEqual({ all: false, simulator: false, agent: false, signup: false, world: { clockId: QA_WORLD, agent: true } });
    expect(await reader.status(OTHER_QA_WORLD)).toMatchObject({ agent: false, world: { agent: false } });
    expect(await reader.status()).toEqual({ all: false, simulator: false, agent: false, signup: false });
  });

  it("[FL-100] caches every item for at most 30 seconds, so another container's write is seen within 30 s", async () => {
    const { store, reads } = countingStore();
    const clock = movableClock();
    const reader = createKillSwitchReader({ store, realClock: clock });
    expect((await reader.status()).agent).toBe(false);
    // The operator's script (another process) turns the agent off.
    await setKillSwitch({ store, realClock: clock }, { scope: "AGENT", on: true, actor: "OPERATOR", reason: "budget" });
    clock.advance(KILL_CACHE_TTL_MS - 1);
    expect((await reader.status()).agent).toBe(false);
    expect(reads()).toBe(1);
    clock.advance(1);
    expect((await reader.status()).agent).toBe(true);
    expect(reads()).toBe(2);
  });

  it("[FL-100] sees its own container's write at once", async () => {
    const { store } = countingStore();
    const clock = movableClock();
    const reader = createKillSwitchReader({ store, realClock: clock });
    expect((await reader.status()).simulator).toBe(false);
    await setKillSwitch({ store, realClock: clock, reader }, { scope: "SIMULATOR", on: true, actor: "OPERATOR" });
    expect((await reader.status()).simulator).toBe(true);
  });

  it("never caches longer than 30 seconds", () => {
    const { store } = countingStore();
    expect(() => createKillSwitchReader({ store, ttlMs: KILL_CACHE_TTL_MS + 1 })).toThrow(RangeError);
    expect(() => createKillSwitchReader({ store, ttlMs: -1 })).toThrow(RangeError);
  });

  it("answers from a recent cache when Runtime cannot be read, and fails when there is none", async () => {
    const { store, fail } = countingStore();
    const clock = movableClock();
    const reader = createKillSwitchReader({ store, realClock: clock, logger: createLogger({ sink: () => undefined }) });
    await reader.status();
    fail(true);
    clock.advance(KILL_CACHE_TTL_MS);
    await expect(reader.status()).resolves.toMatchObject({ agent: false });
    await expect(reader.status(QA_WORLD)).rejects.toThrow("Runtime is down");
  });

  it("fails closed on an item whose state says on, even if the rest of it is malformed", async () => {
    const lines: string[] = [];
    const store: KillSwitchStore = { read: async () => new Map([["KILL#AGENT", { state: "on", setBy: "someone" }]]), write: async () => undefined };
    const reader = createKillSwitchReader({ store, logger: createLogger({ level: "warn", sink: (line) => lines.push(line) }) });
    expect((await reader.status()).agent).toBe(true);
    expect(lines.join("\n")).toContain("does not match its schema");
  });
});

describe("what the switch blocks", () => {
  const off: KillStatus = { all: false, simulator: false, agent: false };

  it("ALL blocks every surface; SIMULATOR only the simulator; AGENT, global or of the world, only the agent", () => {
    const all = { ...off, all: true };
    expect(["AGENT", "SIMULATOR", "CONSOLE"].map((surface) => blockingScope(all, surface as "AGENT"))).toEqual(["ALL", "ALL", "ALL"]);
    const simulator = { ...off, simulator: true };
    expect([blockingScope(simulator, "SIMULATOR"), blockingScope(simulator, "AGENT"), blockingScope(simulator, "CONSOLE")]).toEqual(["SIMULATOR", undefined, undefined]);
    const agent = { ...off, agent: true };
    expect([blockingScope(agent, "AGENT"), blockingScope(agent, "SIMULATOR"), blockingScope(agent, "CONSOLE")]).toEqual(["AGENT", undefined, undefined]);
    expect(blockingScope({ ...off, world: { clockId: QA_WORLD, agent: true } }, "AGENT")).toBe("AGENT");
    expect(blockingScope(off, "AGENT")).toBeUndefined();
  });

  it("[FL-112] SIGNUP blocks only the own sign-up, and ALL blocks it too", () => {
    const signup = { ...off, signup: true };
    expect([blockingScope(signup, "SIGNUP"), blockingScope(signup, "AGENT"), blockingScope(signup, "SIMULATOR"), blockingScope(signup, "CONSOLE")]).toEqual(["SIGNUP", undefined, undefined, undefined]);
    expect(blockingScope({ ...off, all: true }, "SIGNUP")).toBe("ALL");
    expect(blockingScope({ ...off, all: true, signup: true }, "SIGNUP")).toBe("ALL");
    expect(blockingScope({ ...off, agent: true, simulator: true }, "SIGNUP")).toBeUndefined();
    // A status built by hand without the sign-up switch reads it as off.
    expect(blockingScope(off, "SIGNUP")).toBeUndefined();
  });

  it("[FL-100] LAM-KILL: every tool is UNAVAILABLE without effects while the agent is cut, except report_safety_hazard", () => {
    const cut = { ...off, world: { clockId: QA_WORLD, agent: true } };
    for (const tool of TOOLS) expect(toolKillGate(cut, tool), tool).toEqual({ ok: false, error: { code: "UNAVAILABLE", message: "the service is paused", reason: "KILL_SWITCH_ACTIVE" } });
    expect(toolKillGate(cut, "report_safety_hazard")).toBeUndefined();
    for (const tool of TOOLS) expect(toolKillGate(off, tool)).toBeUndefined();
    expect(toolKillGate({ ...off, simulator: true }, "send_whatsapp")).toBeUndefined();
  });

  it("[FL-100] the worker answers servicePaused without invoking the Harness, and the safety instruction still goes out", async () => {
    const { store } = countingStore();
    const clock = movableClock();
    const reader = createKillSwitchReader({ store, realClock: clock });
    await setKillSwitch({ store, realClock: clock, reader }, { scope: "AGENT", clockId: QA_WORLD, on: true, actor: "QA" });
    const sent: string[] = [];
    let harnessCalls = 0;
    // The order of docs/architecture.md §7: the safety classifier first (never gated), then the gate.
    async function handleInbound(text: string): Promise<void> {
      if (/chispe|cable pelado/.test(text)) sent.push("SAFETY_INSTRUCTION");
      const decision = agentKillDecision(await reader.status(QA_WORLD));
      if (!decision.proceed) {
        sent.push(decision.notice);
        return;
      }
      harnessCalls += 1;
    }
    await handleInbound("Ya limpié el conector, ya prende");
    await handleInbound("Hay un cable pelado en el poste, está chispeando");
    expect(sent).toEqual([SERVICE_PAUSED_NOTICE, "SAFETY_INSTRUCTION", SERVICE_PAUSED_NOTICE]);
    expect(harnessCalls).toBe(0);
    await setKillSwitch({ store, realClock: clock, reader }, { scope: "AGENT", clockId: QA_WORLD, on: false, actor: "QA" });
    await handleInbound("Ya limpié el conector, ya prende");
    expect(harnessCalls).toBe(1);
    expect(agentKillDecision({ ...off, all: true })).toEqual({ proceed: false, notice: "servicePaused", scope: "ALL" });
  });
});

describe("the sign-up switch [FL-112]", () => {
  it("[FL-112] the reader reads KILL#SIGNUP with the global switches and sees the operator's write within 30 s", async () => {
    const { store } = countingStore();
    const clock = movableClock();
    const reader = createKillSwitchReader({ store, realClock: clock });
    expect((await reader.status()).signup).toBe(false);
    await setKillSwitch({ store, realClock: clock }, { scope: "SIGNUP", on: true, actor: "OPERATOR", reason: "bounces of the authentication emails" });
    clock.advance(KILL_CACHE_TTL_MS);
    const status = await reader.status();
    expect(status).toMatchObject({ signup: true, all: false, agent: false, simulator: false });
    expect(blockingScope(status, "SIGNUP")).toBe("SIGNUP");
    expect(blockingScope(status, "AGENT")).toBeUndefined();
  });

  it("[FL-112] CostGuard turns KILL#SIGNUP on but never off; only the operator turns it off, audited", async () => {
    const memory = createMemoryRuntimeStore();
    const events: KillSwitchAuditEvent[] = [];
    const audit = async (event: KillSwitchAuditEvent) => void events.push(event);
    await expect(setKillSwitch({ store: memory, audit }, { scope: "SIGNUP", on: true, actor: "COST_GUARD", reason: "alarm AuthEmailBounces" })).resolves.toMatchObject({ scope: "SIGNUP", state: "on", setBy: "COST_GUARD" });
    await expect(setKillSwitch({ store: memory, audit }, { scope: "SIGNUP", on: false, actor: "COST_GUARD" })).rejects.toBeInstanceOf(ToolError);
    await expect(setKillSwitch({ store: memory, audit }, { scope: "SIGNUP", on: true, actor: "QA" })).rejects.toBeInstanceOf(ToolError);
    expect(memory.items.get("KILL#SIGNUP")?.state).toBe("on");
    await setKillSwitch({ store: memory, audit }, { scope: "SIGNUP", on: false, actor: "OPERATOR" });
    expect(memory.items.get("KILL#SIGNUP")).toMatchObject({ state: "off", setBy: "OPERATOR" });
    expect(memory.items.get("KILL#SIGNUP")).not.toHaveProperty("expiresAt");
    expect(events.map((event) => [event.action, event.record.scope, event.record.state])).toEqual([
      ["KILL_SWITCH_SET", "SIGNUP", "on"],
      ["KILL_SWITCH_SET", "SIGNUP", "off"],
    ]);
    expect(killSwitchKey("SIGNUP")).toBe("KILL#SIGNUP");
    expect(() => killSwitchKey("SIGNUP", QA_WORLD)).toThrow(RangeError);
  });
});

describe("set_kill_switch", () => {
  it("[FL-100] audits KILL_SWITCH_SET with who set it and when, in real time", async () => {
    const memory = createMemoryRuntimeStore();
    const events: KillSwitchAuditEvent[] = [];
    const record = await setKillSwitch({ store: memory, realClock: movableClock(), audit: async (event) => void events.push(event) }, { scope: "AGENT", on: true, actor: "OPERATOR", reason: "budget at 100 %" });
    expect(record).toEqual({ scope: "AGENT", state: "on", setBy: "OPERATOR", setAtReal: "2026-10-20T15:00:00.000Z", reason: "budget at 100 %" });
    expect(events).toEqual([{ action: "KILL_SWITCH_SET", record }]);
    expect(memory.items.get("KILL#AGENT")).toEqual(record);
  });

  it("[FL-100] CostGuard only turns the global switches on, never off", async () => {
    const memory = createMemoryRuntimeStore();
    await expect(setKillSwitch({ store: memory }, { scope: "ALL", on: true, actor: "COST_GUARD" })).resolves.toMatchObject({ state: "on", setBy: "COST_GUARD" });
    await expect(setKillSwitch({ store: memory }, { scope: "ALL", on: false, actor: "COST_GUARD" })).rejects.toBeInstanceOf(ToolError);
    await expect(setKillSwitch({ store: memory }, { scope: "AGENT", clockId: QA_WORLD, on: true, actor: "COST_GUARD" })).rejects.toThrow(/global/);
    expect(memory.items.get("KILL#ALL")?.state).toBe("on");
  });

  it("[FL-100] the QaDriver flips only the AGENT switch of a qa-* world, which expires with the world", async () => {
    const memory = createMemoryRuntimeStore();
    await setKillSwitch({ store: memory, realClock: movableClock() }, { scope: "AGENT", clockId: QA_WORLD, on: true, actor: "QA" });
    expect(memory.items.get(`KILL#AGENT#${QA_WORLD}`)).toMatchObject({ state: "on", clockId: QA_WORLD, expiresAt: REAL / 1000 + WORLD_KILL_TTL_SECONDS });
    for (const request of [
      { scope: "AGENT" as const, on: true, actor: "QA" as const },
      { scope: "AGENT" as const, clockId: "GUEST#isp-guest-test", on: true, actor: "QA" as const },
      { scope: "AGENT" as const, clockId: "GLOBAL#isp-demo", on: true, actor: "QA" as const },
      { scope: "AGENT" as const, clockId: "eval-812-1", on: true, actor: "QA" as const },
    ]) {
      await expect(setKillSwitch({ store: memory }, request)).rejects.toBeInstanceOf(ToolError);
    }
    expect(memory.items.has("KILL#AGENT")).toBe(false);
  });

  it("keeps the switches of the demo and guest worlds without TTL and refuses a world switch that is not AGENT", async () => {
    const memory = createMemoryRuntimeStore();
    await setKillSwitch({ store: memory }, { scope: "AGENT", clockId: "GUEST#isp-guest-07", on: true, actor: "OPERATOR" });
    expect(memory.items.get("KILL#AGENT#GUEST#isp-guest-07")).not.toHaveProperty("expiresAt");
    await expect(setKillSwitch({ store: memory }, { scope: "SIMULATOR", clockId: QA_WORLD, on: true, actor: "OPERATOR" })).rejects.toBeInstanceOf(ToolError);
    expect(() => killSwitchKey("ALL", QA_WORLD)).toThrow(RangeError);
    expect(() => killSwitchKey("AGENT", "tomorrow")).toThrow();
    expect(killSwitchKey("SIMULATOR")).toBe("KILL#SIMULATOR");
  });
});
