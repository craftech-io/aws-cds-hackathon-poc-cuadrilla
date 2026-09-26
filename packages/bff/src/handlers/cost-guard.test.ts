import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SNSEvent } from "aws-lambda";
import { describe, expect, it } from "vitest";
import type { Clock } from "../lib/clock";
import { createLogger } from "../lib/log";
import type { KillSwitchAuditEvent } from "../ops/kill-switch";
import { createMemoryRuntimeStore } from "../ops/memory-runtime-store";
import { ALARM_PREFIX, ALARM_SCOPES, decide, handleCostAlerts } from "./cost-guard";

const NOW = Date.parse("2026-10-20T15:00:00.000Z");
const clock: Clock = { now: async () => new Date(NOW) };
const SIGNUP_ALARMS = ["AuthEmailBounces", "AuthEmailBounceRate", "AuthEmailComplaints", "SignupBurst"];

function alarm(suffix: string, state = "ALARM", prefix = ALARM_PREFIX): string {
  return JSON.stringify({ AlarmName: `${prefix}${suffix}`, NewStateValue: state, OldStateValue: "OK", NewStateReason: "Threshold crossed", Region: "US East (N. Virginia)" });
}

function snsEvent(...messages: string[]): SNSEvent {
  return {
    Records: messages.map((Message, index) => ({
      EventSource: "aws:sns",
      EventVersion: "1.0",
      EventSubscriptionArn: "arn:aws:sns:us-east-1:111111111111:app-poc-CostAlerts:sub",
      Sns: { Message, MessageId: `m-${index}`, Type: "Notification", TopicArn: "arn:aws:sns:us-east-1:111111111111:app-poc-CostAlerts", Timestamp: "2026-10-20T15:00:00.000Z", Subject: "", SignatureVersion: "1", Signature: "", SigningCertUrl: "", UnsubscribeUrl: "", MessageAttributes: {} },
    })),
  } as SNSEvent;
}

async function run(...messages: string[]) {
  const store = createMemoryRuntimeStore();
  const audits: KillSwitchAuditEvent[] = [];
  const lines: string[] = [];
  const logger = createLogger({ sink: (line) => lines.push(line) });
  const decisions = await handleCostAlerts(snsEvent(...messages), { kill: { store, realClock: clock }, audit: async (event) => void audits.push(event), logger });
  const items = await store.read(["KILL#SIGNUP", "KILL#ALL", "KILL#AGENT", "KILL#SIMULATOR"]);
  return { decisions, audits, items, lines, store };
}

describe("CostGuard turns the sign-up's cut on from the closed table (ADR-0025 §4) [FL-112]", () => {
  it.each(SIGNUP_ALARMS)("%s in ALARM turns KILL#SIGNUP on, as COST_GUARD, audited once", async (suffix) => {
    const { items, audits } = await run(alarm(suffix));
    expect(items.get("KILL#SIGNUP")).toMatchObject({ scope: "SIGNUP", state: "on", setBy: "COST_GUARD", reason: `alarm ${suffix}` });
    expect([...items.keys()]).toEqual(["KILL#SIGNUP"]);
    expect(audits).toEqual([{ action: "KILL_SWITCH_SET", record: expect.objectContaining({ scope: "SIGNUP", state: "on", setBy: "COST_GUARD" }) }]);
  });

  it("maps exactly the four alarms of the sign-up, all to SIGNUP", () => {
    expect(ALARM_SCOPES).toEqual(Object.fromEntries(SIGNUP_ALARMS.map((suffix) => [suffix, "SIGNUP"])));
  });

  it("never turns anything off: an alarm back to OK changes nothing, even with the cut on", async () => {
    const first = await run(alarm("AuthEmailBounces"));
    const later = await handleCostAlerts(snsEvent(alarm("AuthEmailBounces", "OK"), alarm("SignupBurst", "INSUFFICIENT_DATA")), {
      kill: { store: first.store, realClock: clock },
      audit: async () => undefined,
      logger: createLogger({ sink: () => undefined }),
    });
    expect(later.map((decision) => decision.action)).toEqual(["IGNORE", "IGNORE"]);
    expect((await first.store.read(["KILL#SIGNUP"])).get("KILL#SIGNUP")).toMatchObject({ state: "on" });
  });

  it("turns nothing on for an unknown alarm, another app's alarm of the same name, or a message that is not an alarm", async () => {
    const { decisions, items, audits, lines } = await run(
      alarm("TurnErrors"),
      alarm("AuthEmailBounces", "ALARM", "other-app-poc-"),
      "AWS Budgets notification: you exceeded 80% of your budget",
      JSON.stringify({ AlarmName: 42 }),
    );
    expect(decisions).toEqual([
      { action: "IGNORE", reason: "UNKNOWN_ALARM", alarm: `${ALARM_PREFIX}TurnErrors` },
      { action: "IGNORE", reason: "UNKNOWN_ALARM", alarm: "other-app-poc-AuthEmailBounces" },
      { action: "IGNORE", reason: "NOT_AN_ALARM" },
      { action: "IGNORE", reason: "NOT_AN_ALARM" },
    ]);
    expect(items.size).toBe(0);
    expect(audits).toEqual([]);
    expect(lines.filter((line) => line.includes("COST_ALERT_IGNORED"))).toHaveLength(4);
  });

  it("does not trust an inherited key of the table", () => {
    expect(decide(alarm("constructor"))).toEqual({ action: "IGNORE", reason: "UNKNOWN_ALARM", alarm: `${ALARM_PREFIX}constructor` });
    expect(decide(alarm("toString"))).toMatchObject({ action: "IGNORE" });
  });
});

describe("the table and the alarms of infra/cost-guard.ts agree", () => {
  const infra = readFileSync(resolve(process.cwd(), "infra/cost-guard.ts"), "utf8");

  it("every alarm the infra creates is in the closed table, and every entry has its alarm", () => {
    const declared = [...infra.matchAll(/name: alarmName\("([A-Za-z]+)"\)/g)].map((match) => match[1]).sort();
    expect(declared).toEqual(Object.keys(ALARM_SCOPES).sort());
    expect(infra).toContain("return `${$app.name}-${$app.stage}-${suffix}`;");
    expect(ALARM_PREFIX).toBe("aws-cds-hackathon-poc-cuadrilla-poc-");
  });

  it("points CostGuard at this handler, with one reserved execution", () => {
    expect(infra).toContain('export const COST_GUARD_HANDLER = "packages/bff/src/handlers/cost-guard.handler";');
    expect(infra).toContain("concurrency: { reserved: 1 }");
  });
});
