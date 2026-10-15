// The agent steps of SC-01 (start of the day) and SC-09 (plan B) on the local world: "Ver órdenes" and
// "ÓRDENES" bring the detail of the installer's day. Oracles of the scenarios (scripts/scenarios/sc-01,
// sc-09): the detail lists the installer's orders, by refs or by their numbers in the text.
import { describe, expect, it } from "vitest";
import { turnsSummary, useAgentWorld } from "../support/agent-world";
import { dirtyOutbound, refList, repliesTo } from "../support/oracles";

const worlds = useAgentWorld();
const ROGELIO_DAY = [
  ["wo-24817", "24817"],
  ["wo-24818", "24818"],
  ["wo-24819", "24819"],
] as const;

describe("SC-01 / SC-09 · the day (agent)", () => {
  it("[SC-01/2] [FL-010] \"Ver órdenes\" → the detail of the day with its three orders", async () => {
    const { flow, agent } = await worlds.open();
    await flow.at("07:30");

    await flow.tap("inst-rogelio", "VIEW_ORDERS");

    const detail = (await repliesTo(flow, "inst-rogelio")).at(-1);
    expect(detail, turnsSummary(agent.turns)).toBeDefined();
    const listed = refList(detail ?? {}, "workOrderIds");
    const inText = ROGELIO_DAY.every(([, number]) => (detail?.text ?? "").includes(number));
    expect(ROGELIO_DAY.every(([id]) => listed.includes(id)) || inText, `refs ${listed.join(",")}; text: ${detail?.text ?? ""}`).toBe(true);
    expect(await dirtyOutbound(flow, "inst-rogelio")).toEqual([]);
  });

  it("[SC-09/4.b] [FL-016] with ordenes_del_dia denied, \"ÓRDENES\" opens the window and brings the detail", async () => {
    const { flow, agent } = await worlds.open();
    await flow.data.isps.setTemplateStatus("isp-demo", "ordenes_del_dia", "REJECTED", { actor: "QA", atSim: await flow.simNow() });
    await flow.at("07:30");
    expect(await flow.delivered("inst-rogelio", "DAY_START")).toEqual([]);

    await flow.text("inst-rogelio", "ÓRDENES");

    const detail = (await repliesTo(flow, "inst-rogelio")).at(-1);
    expect(detail, turnsSummary(agent.turns)).toBeDefined();
    expect(refList(detail ?? {}, "workOrderIds").includes("wo-24817") || (detail?.text ?? "").includes("24817"), detail?.text ?? "").toBe(true);
    expect(await dirtyOutbound(flow, "inst-rogelio")).toEqual([]);
  });
});
