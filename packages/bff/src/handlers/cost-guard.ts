// `CostGuard` (ADR-0019, ADR-0025 §4, docs/architecture.md §12 and §14): subscribed to the topic
// `CostAlerts`, it only ever turns a kill switch ON. Which one comes from a CLOSED table in this file,
// keyed by the name of the alarm that fired or of the budget that notified:
//
//   the sign-up's alarms (bounces and complaints of the authentication emails, a burst of sign-ups)
//   → `KILL#SIGNUP`, so the reputation of SES, shared by the whole account, is protected before a pause;
//   the cost alarms (the global ceiling of turns reached, the agent's hourly spend over the stage's budget)
//   and the project budget at 100 % (AWS Budgets publishes plain text with a `Budget Name:` line)
//   → `KILL#AGENT`: no Harness turn, transcription or photo validation; physical safety goes on.
//
// Any other message (an unknown alarm or budget, another app's, an alarm back to OK, text that is
// neither) turns nothing on and is only logged. Only the operator turns a switch off
// (`npm run ops:kill -- --scope SIGNUP|AGENT --off`).
//
// Its role may only `PutItem` a `KILL#*` key of `Runtime` and append to `AuditLog`; every change is
// audited as `KILL_SWITCH_SET` (actor SYSTEM) under the stage's demo operator.
import type { SNSEvent } from "aws-lambda";
import { z } from "zod";
import { DEMO_ISP_ID, type KillScope } from "@cuadrilla/shared";
import { connector } from "../connector";
import { type Logger, createLogger } from "../lib/log";
import { runtimeStore } from "../ops/defaults";
import { type KillSwitchAuditEvent, type SetKillSwitchDeps, setKillSwitch } from "../ops/kill-switch";

/** Prefix of every alarm and budget of the stage (`<app>-<stage>-`, infra/cost-guard.ts `alarmName`). */
export const ALARM_PREFIX = "aws-cds-hackathon-poc-cuadrilla-poc-";

/** The closed table: alarm (name after the prefix) → the scope it turns on. Nothing else ever acts. */
export const ALARM_SCOPES: Readonly<Record<string, KillScope>> = {
  AuthEmailBounces: "SIGNUP",
  AuthEmailBounceRate: "SIGNUP",
  AuthEmailComplaints: "SIGNUP",
  SignupBurst: "SIGNUP",
  TurnCapHitsGlobal: "AGENT",
  AgentSpendHourly: "AGENT",
};

/** Budget (name after the prefix, infra/observability-spec.ts `budgetName`) → scope; it only notifies at 100 %. */
export const BUDGET_SCOPES: Readonly<Record<string, KillScope>> = { monthly: "AGENT" };

const BUDGET_NAME_LINE = /^Budget Name:[ \t]*(\S[^\r\n]{0,254}?)[ \t]*$/m;

/** The part of a CloudWatch alarm notification this handler reads. */
const AlarmMessage = z.object({ AlarmName: z.string().min(1).max(255), NewStateValue: z.string().min(1).max(32) });

export type CostGuardDecision =
  | { readonly action: "TURN_ON"; readonly scope: KillScope; readonly source: "ALARM" | "BUDGET"; readonly alarm: string }
  | { readonly action: "IGNORE"; readonly reason: "NOT_AN_ALARM" | "NOT_IN_ALARM" | "UNKNOWN_ALARM"; readonly alarm?: string };

/** The name after the prefix when the table knows it; never an inherited key. */
function lookup(table: Readonly<Record<string, KillScope>>, name: string): { readonly key: string; readonly scope: KillScope } | undefined {
  const key = name.slice(ALARM_PREFIX.length);
  return name.startsWith(ALARM_PREFIX) && Object.hasOwn(table, key) ? { key, scope: table[key] as KillScope } : undefined;
}

/** A notification of AWS Budgets (plain text): only a budget of the closed table acts. */
function decideBudget(message: string): CostGuardDecision {
  const name = BUDGET_NAME_LINE.exec(message)?.[1];
  if (name === undefined) return { action: "IGNORE", reason: "NOT_AN_ALARM" };
  const found = lookup(BUDGET_SCOPES, name);
  if (found === undefined) return { action: "IGNORE", reason: "UNKNOWN_ALARM", alarm: name.slice(0, 120) };
  return { action: "TURN_ON", scope: found.scope, source: "BUDGET", alarm: found.key };
}

/** What one SNS message asks for, by the closed table only. */
export function decide(message: string): CostGuardDecision {
  let json: unknown;
  try {
    json = JSON.parse(message);
  } catch {
    return decideBudget(message);
  }
  const parsed = AlarmMessage.safeParse(json);
  if (!parsed.success) return { action: "IGNORE", reason: "NOT_AN_ALARM" };
  const { AlarmName: name, NewStateValue: state } = parsed.data;
  const found = lookup(ALARM_SCOPES, name);
  if (found === undefined) return { action: "IGNORE", reason: "UNKNOWN_ALARM", alarm: name.slice(0, 120) };
  if (state !== "ALARM") return { action: "IGNORE", reason: "NOT_IN_ALARM", alarm: found.key };
  return { action: "TURN_ON", scope: found.scope, source: "ALARM", alarm: found.key };
}

export interface CostGuardDeps {
  readonly kill: Pick<SetKillSwitchDeps, "store" | "realClock">;
  readonly audit: (event: KillSwitchAuditEvent) => Promise<void>;
  readonly logger: Logger;
}

/** Every record of the event: turns on what the table says, never anything else, never off. */
export async function handleCostAlerts(event: SNSEvent, deps: CostGuardDeps): Promise<CostGuardDecision[]> {
  const decisions: CostGuardDecision[] = [];
  for (const record of event.Records) {
    const decision = decide(record.Sns.Message);
    decisions.push(decision);
    if (decision.action === "IGNORE") {
      deps.logger.warn("cost alert ignored", { action: "COST_ALERT_IGNORED", reason: decision.reason, alarm: decision.alarm });
      continue;
    }
    await setKillSwitch({ ...deps.kill, audit: deps.audit, logger: deps.logger }, { scope: decision.scope, on: true, actor: "COST_GUARD", reason: `${decision.source === "BUDGET" ? "budget" : "alarm"} ${decision.alarm}` });
  }
  return decisions;
}

/** `KILL_SWITCH_SET` in `AuditLog`, under the stage's demo operator (the switch is global). */
export function auditKillSwitch(event: KillSwitchAuditEvent): Promise<void> {
  const { record } = event;
  return connector()
    .audit.append({
      ispId: DEMO_ISP_ID,
      decision: "ACTION",
      action: event.action,
      actor: record.setBy === "OPERATOR" ? "OPERATOR" : "SYSTEM",
      ...(record.reason === undefined ? {} : { reason: record.reason }),
      detail: { scope: record.scope, state: record.state, setBy: record.setBy, setAtReal: record.setAtReal },
    })
    .then(() => undefined);
}

export async function handler(event: SNSEvent): Promise<void> {
  const logger = createLogger({ bindings: { component: "cost-guard" } });
  await handleCostAlerts(event, { kill: { store: runtimeStore() }, audit: auditKillSwitch, logger });
}
