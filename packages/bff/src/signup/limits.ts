// The limits of the own sign-up (ADR-0025 §3), as counters of `Runtime` with a TTL. No counter ever
// holds an IP or an email in clear: `ipHash` (subkey `ip-hash`) and `abuseHash` (subkey `email-hash`
// over the reduced form of the address, leads/keys.ts) name them.
//
//   SIGNUP#IP#<ipHash>#<realHour>              5 starts per hour from one IP            RATE_LIMITED
//   SIGNUP#ANON#<ipHash>#<realHour>            1 per hour from an anonymous IP          RATE_LIMITED
//   SIGNUP#ANONDAY#<realDay>                   30 per day from anonymous IPs (stage)    RATE_LIMITED
//   SIGNUP#EMAIL#<abuseHash>#<realHour>        3 per hour per person                    RATE_LIMITED
//   SIGNUP#EMAILDAY#<abuseHash>#<realDay>      5 per day per person                     RATE_LIMITED
//   SIGNUP#GLOBAL#<realDay>                    300 starts per day in the stage          CAP_REACHED
//   SIGNUPKEY#<abuseHash> (confirmedAccounts)  2 confirmed accounts per person (read)   RATE_LIMITED
//
// The visitor's counters move together in one transaction (all or none), then the day of the stage in
// another: a visitor over its own limit never takes a place of the day. Only `signup.start` reserves;
// the pre sign-up reads the day and the cut and never increments (ADR-0025 §1).
//
// A call of the QaDriver (`qa.runId`, ADR-0025 §7) counts under keys of its own,
// `SIGNUP#qa-<runId>#…`, so public abuse never makes a scenario fail and a scenario never spends
// public room. It has no viewer IP: its IP counters use the run as the address.
import { ConnectorError } from "@cuadrilla/shared";
import type { Item, TableClient, TransactOp } from "../connector/table-client";
import { CONFIRMED_ACCOUNTS, signupKeyKey } from "../leads/guest-accounts";
import { hmacSha256Hex } from "../lib/crypto";

export const SIGNUP_LIMITS = {
  perIpPerHour: 5,
  anonymousPerIpPerHour: 1,
  anonymousPerDay: 30,
  perPersonPerHour: 3,
  perPersonPerDay: 5,
  startsPerDay: 300,
  confirmedAccountsPerPerson: 2,
} as const;

/** Counters of the sign-up live 48 hours past their period (docs/architecture.md §5; ADR-0026, retention). */
const COUNTER_TTL_AFTER_PERIOD_SECONDS = 48 * 3_600;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
export const SIGNUP_COUNTER = "used";
const META = "META";

export const realHour = (at: Date): string => at.toISOString().slice(0, 13);
export const realDay = (at: Date): string => at.toISOString().slice(0, 10);

/** Where the counters of a call live: the public scope, or the QaDriver's run. */
export type LimitScope = { readonly kind: "PUBLIC" } | { readonly kind: "QA"; readonly runId: string };

const prefix = (scope: LimitScope): string => (scope.kind === "QA" ? `SIGNUP#qa-${scope.runId}#` : "SIGNUP#");

export const globalDayKey = (scope: LimitScope, at: Date): string => `${prefix(scope)}GLOBAL#${realDay(at)}`;

/** `ipHash` of the limits: the viewer's IP (or the QA run) under the `ip-hash` subkey. */
export function ipHashOf(ipHashKey: Uint8Array | string, address: string): string {
  return hmacSha256Hex(ipHashKey, address);
}

export interface VisitorKeys {
  readonly ipHash: string;
  readonly abuseHash: string;
  /** AWS WAF labelled the viewer's IP anonymous (its header, read only at the edge). */
  readonly anonymous: boolean;
}

interface CounterSpec {
  readonly key: string;
  readonly limit: number;
  readonly periodEndsAt: Date;
}

function endOfHour(at: Date): Date {
  return new Date(Math.floor(at.getTime() / HOUR_MS) * HOUR_MS + HOUR_MS);
}

function endOfDay(at: Date): Date {
  return new Date(Math.floor(at.getTime() / DAY_MS) * DAY_MS + DAY_MS);
}

/** The counters of one visitor for one start, the anonymous ones only when WAF labelled the IP. */
export function visitorCounters(scope: LimitScope, keys: VisitorKeys, at: Date): CounterSpec[] {
  const p = prefix(scope);
  const hour = endOfHour(at);
  const day = endOfDay(at);
  const specs: CounterSpec[] = [
    { key: `${p}IP#${keys.ipHash}#${realHour(at)}`, limit: SIGNUP_LIMITS.perIpPerHour, periodEndsAt: hour },
    { key: `${p}EMAIL#${keys.abuseHash}#${realHour(at)}`, limit: SIGNUP_LIMITS.perPersonPerHour, periodEndsAt: hour },
    { key: `${p}EMAILDAY#${keys.abuseHash}#${realDay(at)}`, limit: SIGNUP_LIMITS.perPersonPerDay, periodEndsAt: day },
  ];
  if (keys.anonymous) {
    specs.push({ key: `${p}ANON#${keys.ipHash}#${realHour(at)}`, limit: SIGNUP_LIMITS.anonymousPerIpPerHour, periodEndsAt: hour });
    specs.push({ key: `${p}ANONDAY#${realDay(at)}`, limit: SIGNUP_LIMITS.anonymousPerDay, periodEndsAt: day });
  }
  return specs;
}

function incrementOp(spec: CounterSpec, at: Date): TransactOp {
  return {
    op: "increment",
    table: "Runtime",
    key: { PK: spec.key, SK: META },
    attribute: SIGNUP_COUNTER,
    by: 1,
    max: spec.limit,
    defaults: {
      entity: "SignupCounter",
      capLimit: spec.limit,
      createdAt: at.toISOString(),
      expiresAt: Math.floor(spec.periodEndsAt.getTime() / 1000) + COUNTER_TTL_AFTER_PERIOD_SECONDS,
    },
  };
}

export type ReserveOutcome = "RESERVED" | "RATE_LIMITED" | "CAP_REACHED";

function isFull(error: unknown): boolean {
  return error instanceof ConnectorError && error.code === "CONFLICT";
}

/**
 * One start: the visitor's counters together, then the stage's day. A full counter changes nothing of
 * its transaction; a full day after the visitor's counters leaves them counted (it was an attempt).
 */
export async function reserveStart(client: TableClient, scope: LimitScope, keys: VisitorKeys, at: Date): Promise<ReserveOutcome> {
  const iso = at.toISOString();
  try {
    await client.transact(visitorCounters(scope, keys, at).map((spec) => incrementOp(spec, at)), iso);
  } catch (error) {
    if (isFull(error)) return "RATE_LIMITED";
    throw error;
  }
  try {
    await client.transact([incrementOp({ key: globalDayKey(scope, at), limit: SIGNUP_LIMITS.startsPerDay, periodEndsAt: endOfDay(at) }, at)], iso);
  } catch (error) {
    if (isFull(error)) return "CAP_REACHED";
    throw error;
  }
  return "RESERVED";
}

function numberOf(item: Item | undefined, attribute: string): number {
  const value = item?.[attribute];
  return typeof value === "number" ? value : 0;
}

/** Confirmed accounts of one person (`SIGNUPKEY#`, written by post-confirmation and the deletion). */
export async function confirmedAccountsOf(client: Pick<TableClient, "get">, abuseHash: string): Promise<number> {
  return numberOf(await client.get("Runtime", signupKeyKey(abuseHash)), CONFIRMED_ACCOUNTS);
}

/** Starts counted today in the stage (the pre sign-up reads it, never increments it). */
export async function startsToday(client: Pick<TableClient, "get">, scope: LimitScope, at: Date): Promise<number> {
  return numberOf(await client.get("Runtime", { PK: globalDayKey(scope, at), SK: META }), SIGNUP_COUNTER);
}
