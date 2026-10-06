// The budget of one agent turn (docs/architecture.md §7, ADR-0019), checked before anything spends:
//
//   1. the kill switch (`KILL#ALL`, `KILL#AGENT`, `KILL#AGENT#<clockId>`)  → PAUSED: `servicePaused`, no Harness
//   2. one turn reserved, all or nothing, in the world's simulator caps (`SIMCAP#`), the operator's turn
//      caps (`TURNCAP#<ispId>`) and the stage's ceiling (`TURNCAP#GLOBAL`; a sign-up world also in its
//      account quota and the sign-up sub-ceiling)                      → TURN_CAP: `turnCap`, no Harness
//
// The reservation carries the event id, so a redelivered event never takes a second turn. QA and
// evaluation worlds never touch the real ceiling (ops/cost-caps.ts gives them their own or none).
import type { KillScope } from "@cuadrilla/shared";
import type { Logger } from "../lib/log";
import { type CapLedger, type CostCapsDeps, reserveCost } from "../ops/cost-caps";
import { type KillSwitchReader, agentKillDecision } from "../ops/kill-switch";

export type TurnBudget =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly refusal: "PAUSED"; readonly scope: KillScope }
  | {
      readonly allowed: false;
      readonly refusal: "TURN_CAP";
      /** `SIMULATOR`, `OPERATOR` or `GLOBAL`; `GUEST_ACCOUNT`/`GUEST_SIGNUP` for a sign-up world's tiers. */
      readonly scope: string;
      readonly ledger: CapLedger;
      readonly period: "HOUR" | "DAY";
      readonly limit: number;
      readonly resetsAtReal: string;
    };

export interface TurnBudgetDeps {
  readonly kill: KillSwitchReader;
  readonly costCaps: CostCapsDeps;
}

export interface TurnWorld {
  readonly clockId: string;
  /** `Isps/SETTINGS` of the world's operator. */
  readonly settings: unknown;
}

/**
 * Kill switch first, then one turn in every ledger that caps it. ops/cost-caps.ts logs the refusal on `log`
 * with its metric (`TurnCapHits{scope}`, `SimulatorCapHits`, `GuestSignupCapHits`).
 */
export async function reserveTurn(deps: TurnBudgetDeps, world: TurnWorld, eventId: string, log: Logger): Promise<TurnBudget> {
  const kill = agentKillDecision(await deps.kill.status(world.clockId));
  if (!kill.proceed) return { allowed: false, refusal: "PAUSED", scope: kill.scope };
  const outcome = await reserveCost({ ...deps.costCaps, logger: log }, {
    world,
    resource: "turns",
    amount: 1,
    reserve: ["SIMULATOR", "OPERATOR", "GLOBAL"],
    surface: "AGENT",
    idempotencyKey: `turn#${eventId}`,
  });
  if (outcome.ok) return { allowed: true };
  if (outcome.code === "KILL_SWITCH_ACTIVE") return { allowed: false, refusal: "PAUSED", scope: outcome.scope };
  const { counter } = outcome;
  return { allowed: false, refusal: "TURN_CAP", scope: counter.tier ?? counter.ledger, ledger: counter.ledger, period: counter.period, limit: counter.limit, resetsAtReal: counter.resetsAtReal };
}
