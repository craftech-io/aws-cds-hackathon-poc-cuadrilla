import { describe, expect, it } from "vitest";
import type { DecisionInput } from "../connector/ports";
import { DEMO, GUEST_07 } from "../services/people/testing";
import { type ConsoleTestWorld, consoleTestWorld } from "./console-testing";

async function decide(t: ConsoleTestWorld, input: Omit<DecisionInput, "ispId" | "clockId" | "actor"> & { actor?: DecisionInput["actor"] }): Promise<void> {
  await t.memory.connector.audit.append({ ispId: t.world.ispId, clockId: t.world.clockId, actor: "SYSTEM", ...input });
}

async function seedDecisions(t: ConsoleTestWorld): Promise<void> {
  const order = { workOrderId: t.world.ids.order };
  await decide(t, { atSim: "2026-10-13T09:21:00-06:00", decision: "ALLOW", action: "SEND_WHATSAPP", ruleIds: ["CP-WA-24H", "CP-CITATION"], trigger: "INSTALLER_MESSAGE", actor: "AGENT", refs: order, messageId: "wa-out-1" });
  await decide(t, {
    atSim: "2026-10-13T09:22:00-06:00",
    decision: "DENY",
    action: "SEND_WHATSAPP",
    ruleIds: ["CP-OPT-IN"],
    evaluated: [
      { ruleId: "CP-OPT-IN", result: "FAIL" },
      { ruleId: "CP-WA-24H", result: "PASS" },
    ],
    refs: order,
  });
  await decide(t, { atSim: "2026-10-13T21:30:00-06:00", decision: "DEFER", action: "SEND_WHATSAPP", ruleIds: ["CP-QUIET-HOURS"], refs: order });
  await decide(t, { atSim: "2026-10-13T09:40:00-06:00", decision: "ACTION", action: "GUARDRAIL_BLOCK", refs: order });
  await decide(t, { atSim: "2026-10-13T09:41:00-06:00", decision: "VIOLATION", action: "POLICY_VIOLATION", reason: "NO_ALLOW_DECISION", messageId: "wa-out-9", detail: { check: "ALLOW_DECISION" } });
}

describe("audit router [FL-088]", () => {
  it("[FL-088] every decision of the world with its rule, trigger and actor, filterable by decision, action and rule", async () => {
    const t = await consoleTestWorld(DEMO);
    await seedDecisions(t);
    const console = await t.as("OPS", "usr-ops");
    const all = await console.audit.list();
    expect(all.month).toBe("2026-10");
    expect(all.total).toBe(5);
    expect(all.decisions[0]).toMatchObject({ decision: "DEFER", ruleIds: ["CP-QUIET-HOURS"], atSim: "2026-10-13T21:30:00-06:00" });
    expect((await console.audit.list({ decision: "ALLOW" })).decisions).toEqual([expect.objectContaining({ action: "SEND_WHATSAPP", trigger: "INSTALLER_MESSAGE", actor: "AGENT", messageId: "wa-out-1" })]);
    expect((await console.audit.list({ ruleId: "CP-WA-24H" })).total).toBe(2);
    expect((await console.audit.list({ action: "GUARDRAIL_BLOCK" })).total).toBe(1);
  });

  it("[FL-088] the violations next to DENY and DEFER per rule, and blocks by origin; another world's rows never show", async () => {
    const t = await consoleTestWorld(DEMO);
    const guest = await consoleTestWorld(GUEST_07, t);
    await seedDecisions(t);
    const console = await t.as();
    expect(await console.audit.violations()).toMatchObject({ count: 1, violations: [{ reason: "NO_ALLOW_DECISION", check: "ALLOW_DECISION" }] });
    const byRule = await console.audit.decisionsByRule();
    expect(byRule.violations).toBe(1);
    expect(byRule.rules).toEqual(
      expect.arrayContaining([
        { ruleId: "CP-OPT-IN", ALLOW: 0, DENY: 1, DEFER: 0 },
        { ruleId: "CP-QUIET-HOURS", ALLOW: 0, DENY: 0, DEFER: 1 },
        { ruleId: "CP-WA-24H", ALLOW: 1, DENY: 0, DEFER: 0 },
      ]),
    );
    expect(byRule.blocks).toEqual([{ origin: "GUARDRAIL", count: 1 }]);
    const guestConsole = await guest.as();
    expect((await guestConsole.audit.list()).total).toBe(0);
    expect((await guestConsole.audit.violations()).count).toBe(0);
  });
});
