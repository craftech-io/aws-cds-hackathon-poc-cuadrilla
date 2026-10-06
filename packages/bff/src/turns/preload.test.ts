import { beforeEach, describe, expect, it } from "vitest";
import type { ToolResponse } from "../agent-tools/common/handler";
import { CLOCK, MSG, type WorkerKit, inboundEvent, inboundMessage, seedWorld, sessionOf, workerKit } from "../worker/testing";
import { readsFor } from "./preload";

let kit: WorkerKit;

beforeEach(async () => {
  kit = workerKit();
  await seedWorld(kit);
});

const envelopeOf = (index = 0): string => kit.rec.harness[index]?.envelope ?? "";

function toolResults(envelope: string): Array<{ tool: string; json: unknown }> {
  return [...envelope.matchAll(/<tool-result tool="([a-z_]+)">(.*)<\/tool-result>/g)].map((match) => ({ tool: match[1] ?? "", json: JSON.parse(match[2] ?? "null") }));
}

describe("turns/preload [FL-025]", () => {
  it("[FL-025] with an active order, an installer's message preloads get_work_order, get_checklist and get_work_orders with the turn's token, each through createToolHandler with its RESULT# row", async () => {
    const message = await inboundMessage(kit, { text: "hola" });
    await kit.run(inboundEvent(message));
    const envelope = envelopeOf();
    const { turnId } = sessionOf(envelope);
    expect(toolResults(envelope).map((result) => result.tool)).toEqual(["get_work_order", "get_checklist", "get_work_orders"]);
    for (const tool of ["get_work_order", "get_checklist", "get_work_orders"]) {
      expect(await kit.connector.runtime.listTurnResults(turnId, tool)).toHaveLength(1);
    }
    expect(toolResults(envelope).find((result) => result.tool === "get_work_orders")?.json).toMatchObject({ ok: true, recentWorkOrders: [{ workOrderNumber: "24817", open: true }] });
  });

  it("[FL-025] runs the reads in parallel: all three are asked before any answers", async () => {
    const started: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const wrap = (target: "orders" | "evidence") => ({
      invoke: async (tool: string, input: Readonly<Record<string, unknown>>): Promise<ToolResponse> => {
        started.push(tool);
        if (started.length === 3) release();
        await Promise.race([gate, new Promise((resolve) => setTimeout(resolve, 500))]);
        return kit.reads[target].invoke(tool, input);
      },
    });
    Object.assign(kit.deps.turn, { reads: { orders: wrap("orders"), evidence: wrap("evidence") } });
    const message = await inboundMessage(kit, { text: "hola" });
    const before = Date.now();
    await kit.run(inboundEvent(message));
    expect(started).toHaveLength(3);
    expect(Date.now() - before).toBeLessThan(450);
  });

  it("[FL-025] escapes <, > and & of the preloaded JSON and keeps it outside the untrusted block", async () => {
    const message = await inboundMessage(kit, { text: "ok" });
    await kit.run(inboundEvent(message));
    const envelope = envelopeOf();
    const lines = envelope.split("\n");
    const block = lines.findIndex((line) => /^<inbound-[0-9a-f]{6} /.test(line));
    const firstResult = lines.findIndex((line) => line.startsWith("<tool-result "));
    expect(block).toBeGreaterThan(0);
    expect(firstResult).toBeGreaterThan(block);
    expect(envelope).toContain("Calle Ficticia 5 \\u003cNorte\\u003e \\u0026 Sur");
    expect(envelope).not.toContain("<Norte>");
  });

  it("[FL-025] leaves a failing read out of the envelope and the turn goes on", async () => {
    const failing = { invoke: async (tool: string, input: Readonly<Record<string, unknown>>) => (tool === "get_checklist" ? Promise.reject(new Error("boom")) : kit.reads.evidence.invoke(tool, input)) };
    Object.assign(kit.deps.turn, { reads: { orders: kit.reads.orders, evidence: failing } });
    const message = await inboundMessage(kit, { text: "gracias" });
    await kit.run(inboundEvent(message));
    expect(toolResults(envelopeOf()).map((result) => result.tool)).toEqual(["get_work_order", "get_work_orders"]);
    expect(kit.rec.harness).toHaveLength(1);
    expect(kit.tools.logs.some((line) => line.message === "turn.preload_failed" && line.tool === "get_checklist")).toBe(true);
  });

  it("[FL-025] preloads nothing while the agent is cut (KILL#AGENT): no RESULT#, no Harness", async () => {
    await kit.tools.killAgent(CLOCK);
    const message = await inboundMessage(kit, { text: "hola" });
    await kit.run(inboundEvent(message));
    expect(kit.rec.reads).toEqual([]);
    expect(kit.rec.harness).toEqual([]);
    expect(kit.rec.notices.map((notice) => notice.notice)).toEqual(["servicePaused"]);
  });

  it("[FL-025] answers a second 'hola' at the same simulated time with its own turn and its own preloaded reads", async () => {
    const first = await inboundMessage(kit, { text: "hola" });
    await kit.run(inboundEvent(first));
    const second = await inboundMessage(kit, { messageId: `${MSG}2`, text: "hola" });
    await kit.run(inboundEvent(second, "wa-in-0000000000000000000000000000000000000002"));
    expect(kit.rec.harness).toHaveLength(2);
    expect(sessionOf(envelopeOf(0)).turnId).not.toBe(sessionOf(envelopeOf(1)).turnId);
    expect(toolResults(envelopeOf(1))).toHaveLength(3);
  });

  it("plans the reads by trigger and by order: no order → only the installer's list; a turn the installer did not open → no list", () => {
    expect(readsFor("INSTALLER_MESSAGE", false).map((read) => read.tool)).toEqual(["get_work_orders"]);
    expect(readsFor("CASE_CLOSED", true).map((read) => read.tool)).toEqual(["get_work_order", "get_checklist"]);
    expect(readsFor("WORK_ORDER_CHANGED", false)).toEqual([]);
  });
});
