// Test support for the policy tests (never imported by runtime code): a policy input of the demo
// world on Tuesday 13/10/2026 (America/Mexico_City, UTC−6 all year) that each test changes in one
// place. People, orders and cases are the synthetic ones of docs/seed-spec.md.
import type { z } from "zod";
import type { ContactRule } from "@cuadrilla/shared";
import { CASE_1, CASE_2, CLOCK, ISP, installer as connectorInstaller, testConnector } from "../connector/testing";
import type { EvaluatedRule } from "../domain/audit";
import type { NewEntity } from "../domain/common";
import type { IspSettings, ShiftRoster } from "../domain/isps";
import { type PolicyDecision, evaluate, ruleEntry } from "./engine";
import type { PersonRecipient, PolicyFacts, PolicyInputShape, PolicyInstant, PolicyMessage } from "./types";

type MessageInput = z.input<typeof PolicyMessage>;
type PersonInput = z.input<typeof PersonRecipient>;
type FactsInput = z.input<typeof PolicyFacts>;

export const WORLD = CLOCK;
export const CASE_ID = CASE_1;
export const OTHER_CASE_ID = CASE_2;
export const SHA_CERT = "c".repeat(64);
/** Real time of the evaluations: the demo world is replayed weeks after its simulated day. */
export const REAL_NOW = "2026-11-02T18:00:00.000Z";

/** `"2026-10-13 21:30"` in Mexico City as an ISO instant in UTC. */
export function mx(local: string): string {
  return new Date(`${local.replace(" ", "T")}:00-06:00`).toISOString();
}

/** The instant of an evaluation: simulated local time in Mexico City and a real instant. */
export function at(localSim: string, real: string = REAL_NOW): PolicyInstant {
  return { sim: mx(localSim), real };
}

/** An agent reply to Rogelio about his active order, answering his message. */
export function reply(overrides: Partial<MessageInput> = {}): MessageInput {
  return { kind: "REPLY", channel: "WHATSAPP", form: "TEXT", author: "AGENT", text: "Listo, ya quedó en línea.", workOrderId: "wo-24817", inResponseToInbound: true, ...overrides };
}

/** A system message of any kind (fixed text, template, case message). */
export function system(kind: MessageInput["kind"], overrides: Partial<MessageInput> = {}): MessageInput {
  return { kind, channel: "WHATSAPP", form: "TEXT", author: "SYSTEM", ...overrides };
}

export function dayStart(overrides: Partial<MessageInput> = {}): MessageInput {
  return system("DAY_START", { form: "TEMPLATE", templateName: "ordenes_del_dia", ...overrides });
}

/** Rogelio: active, opted in, a synthetic identity who wrote at 09:20. */
export function installer(overrides: Partial<PersonInput> = {}): PersonInput {
  return { kind: "PERSON", personId: "inst-rogelio", role: "INSTALLER", active: true, hasPhone: true, consent: "GRANTED", route: "SIMULATED", lastInboundAtSim: mx("2026-10-13 09:20"), ...overrides };
}

export function supervisor(personId: string = "sup-adriana", overrides: Partial<PersonInput> = {}): PersonInput {
  return installer({ personId, role: "SUPERVISOR", ...overrides });
}

/** The demo world at 09:21, with its 21:00-07:00 quiet hours. */
export function facts(overrides: Partial<FactsInput> = {}): FactsInput {
  return { now: at("2026-10-13 09:21"), world: { clockId: WORLD, quietHours: { start: "21:00", end: "07:00" } }, ...overrides };
}

export interface Parts {
  readonly message?: MessageInput;
  readonly recipient?: PolicyInputShape["recipient"];
  readonly facts?: FactsInput;
}

export function input(parts: Parts = {}): PolicyInputShape {
  return { message: parts.message ?? reply(), recipient: parts.recipient ?? installer(), facts: parts.facts ?? facts() };
}

/** Evaluates the input built from `parts`. */
export function decide(parts: Parts = {}): PolicyDecision {
  return evaluate(input(parts));
}

/** The entry of `ruleId` in the decision on `parts`. */
export function entryOf(parts: Parts, ruleId: ContactRule): EvaluatedRule {
  return ruleEntry(decide(parts), ruleId);
}

/** `"DENY CP-OPTIN NO_OPT_IN"`, `"ALLOW"`, `"DEFER CP-QUIET-HOURS QUIET_HOURS"`: a decision in one line. */
export function summary(decision: PolicyDecision): string {
  return decision.allowed ? "ALLOW" : `${decision.outcome} ${decision.deniedBy ?? ""} ${decision.reason ?? ""}`;
}

// ---- Stored records (memory connector) -------------------------------------------------------------

/** Settings of the demo world (docs/seed-spec.md §4). */
export function demoSettings(overrides: Partial<NewEntity<typeof IspSettings>> = {}): NewEntity<typeof IspSettings> {
  return {
    ispId: ISP,
    clockId: CLOCK,
    quietHours: { start: "21:00", end: "07:00" },
    caseTimeoutSec: 600,
    demoMode: true,
    demoCaseTimeoutSec: 60,
    whatsappMode: "simulated",
    turnCaps: { perHour: 200, perDay: 1000 },
    simulatorCaps: { turnsPerHour: 60, turnsPerDay: 300, validationsPerDay: 100, transcribeSecPerDay: 1800, emailsPerDay: 20, messagesPerRealHourPerIdentity: 20 },
    ...overrides,
  };
}

/** Roster of crew Norte 3 on 13/10: Adriana on duty, Héctor as backup, 07:00-19:00. */
export const ROSTER_N3: NewEntity<typeof ShiftRoster> = {
  ispId: ISP,
  clockId: CLOCK,
  crewId: "crew-n3",
  date: "2026-10-13",
  primaryId: "sup-adriana",
  secondaryId: "sup-hector",
  startsAtSim: mx("2026-10-13 07:00"),
  endsAtSim: mx("2026-10-13 19:00"),
};

/** A memory connector with the demo operator, its settings, Rogelio (opted in on 01/10) and the roster. */
export async function policyWorld(): Promise<ReturnType<typeof testConnector>> {
  const world = testConnector("2026-11-02T18:00:00.000Z");
  const { isps, people } = world.connector;
  await isps.putIsp({ ispId: ISP, kind: "DEMO", clockId: CLOCK });
  await isps.putSettings(demoSettings());
  await isps.setRoster(ROSTER_N3, { actor: "SEED" });
  await people.createPerson(connectorInstaller());
  await people.grantConsent({ personId: "inst-rogelio", clockId: CLOCK, medium: "WHATSAPP_KEYWORD", textVersion: "v001" }, { actor: "PERSON:inst-rogelio", atSim: mx("2026-10-01 08:00") });
  return world;
}
