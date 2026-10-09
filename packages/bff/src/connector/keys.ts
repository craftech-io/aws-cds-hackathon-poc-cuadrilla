// Partition and sort keys of every entity plus the composite GSI attributes, exactly as
// docs/architecture.md §5 writes them. The seed generator and the world factory build rows with the
// same functions, so a fixture reads the same in a JSON file, in a Query and in a log.
import { TimerKind, type ChecklistItem, type KillScope, type PersonRole } from "@cuadrilla/shared";
import type { LeaseKind } from "../domain/runtime-world";
import { TimerHome, TimerId } from "../domain/timers";
import type { Key } from "./table-client";

export const META = "META";

const pad3 = (n: number): string => {
  if (!Number.isInteger(n) || n < 0 || n > 999) throw new RangeError(`sequence out of range: ${n}`);
  return n.toString().padStart(3, "0");
};

// ---- Isps --------------------------------------------------------------------------------------

export const ispPartition = (ispId: string): string => `ISP#${ispId}`;
export const ispKey = (ispId: string): Key => ({ PK: ispPartition(ispId), SK: META });
export const ispSettingsKey = (ispId: string): Key => ({ PK: ispPartition(ispId), SK: "SETTINGS" });
export const ZONE_PREFIX = "ZONE#";
export const zoneKey = (ispId: string, zoneId: string): Key => ({ PK: ispPartition(ispId), SK: `${ZONE_PREFIX}${zoneId}` });
export const CREW_PREFIX = "CREW#";
export const crewKey = (ispId: string, crewId: string): Key => ({ PK: ispPartition(ispId), SK: `${CREW_PREFIX}${crewId}` });
export const ROSTER_PREFIX = "ROSTER#";
export const rosterPrefix = (crewId: string): string => `${ROSTER_PREFIX}${crewId}#`;
export const rosterKey = (ispId: string, crewId: string, date: string): Key => ({ PK: ispPartition(ispId), SK: `${rosterPrefix(crewId)}${date}` });
export const USER_PREFIX = "USER#";
export const userKey = (ispId: string, userId: string): Key => ({ PK: ispPartition(ispId), SK: `${USER_PREFIX}${userId}` });
/** `Isps GSI1`: console user by Cognito `sub`. */
export const cognitoSubKey = (sub: string): string => `SUB#${sub}`;

// ---- People ------------------------------------------------------------------------------------

export const personPartition = (personId: string): string => `PERSON#${personId}`;
export const personKey = (personId: string): Key => ({ PK: personPartition(personId), SK: META });
export const customerKey = (customerId: string): Key => ({ PK: `CUST#${customerId}`, SK: META });
export const CONSENT_WHATSAPP = "CONSENT#WHATSAPP";
export const consentKey = (personId: string): Key => ({ PK: personPartition(personId), SK: CONSENT_WHATSAPP });
export const profileKey = (installerId: string): Key => ({ PK: personPartition(installerId), SK: "PROFILE" });
export const shiftWindowKey = (personId: string): Key => ({ PK: personPartition(personId), SK: "SHIFTWINDOW" });
/** One row per phone in use in a world: its existence makes the phone unique inside the world. */
export const addressClaimKey = (clockId: string, phoneHash: string): Key => ({ PK: `ADDR#${clockId}#${phoneHash}`, SK: "CLAIM" });
/** `People GSI1`: identity by phone within a world. */
export const phoneKey = (clockId: string, phoneHash: string): string => `${clockId}#${phoneHash}`;
/** `People GSI2`: people of an operator by role, sorted by name. */
export const ispKindKey = (ispId: string, role: PersonRole): string => `ISP#${ispId}#${role}`;
/** Sort name of `People GSI2`: accent-free, lower case, last name first. */
export function sortName(lastName: string, firstName: string, id: string): string {
  const fold = (text: string): string => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  return `${fold(lastName)}#${fold(firstName)}#${id}`;
}

// ---- WorkOrders --------------------------------------------------------------------------------

export const workOrderPartition = (workOrderId: string): string => `WO#${workOrderId}`;
export const workOrderKey = (workOrderId: string): Key => ({ PK: workOrderPartition(workOrderId), SK: META });
export const CHECK_PREFIX = "CHECK#";
export const checklistKey = (workOrderId: string, item: ChecklistItem): Key => ({ PK: workOrderPartition(workOrderId), SK: `${CHECK_PREFIX}${item}` });
export const EVID_PREFIX = "EVID#";
export const evidenceKey = (workOrderId: string, evidenceId: string): Key => ({ PK: workOrderPartition(workOrderId), SK: `${EVID_PREFIX}${evidenceId}` });
export const VAL_PREFIX = "VAL#";
export const validationKey = (workOrderId: string, validationId: string): Key => ({ PK: workOrderPartition(workOrderId), SK: `${VAL_PREFIX}${validationId}` });
export const STEP_PREFIX = "STEP#";
export const stepKey = (workOrderId: string, seq: number): Key => ({ PK: workOrderPartition(workOrderId), SK: `${STEP_PREFIX}${pad3(seq)}` });
export const certificateKey = (workOrderId: string): Key => ({ PK: workOrderPartition(workOrderId), SK: "CERT" });
/** `WorkOrders GSI1`: the orders of an installer's day. */
export const installerDayKey = (installerId: string, date: string): string => `INST#${installerId}#${date}`;
/** `WorkOrders GSI2`: the orders of an operator's day (by status). */
export const ispDayKey = (ispId: string, date: string): string => `ISP#${ispId}#${date}`;
/** `WorkOrders GSI4`: repeated photo within a world and its epoch. */
export const evidenceHashKey = (clockId: string, worldEpoch: number, sha256: string): string => `SHA#${clockId}#${worldEpoch}#${sha256}`;

// ---- Timers ------------------------------------------------------------------------------------

export const TIMER_PREFIX = "TIMER#";
/** `WorkOrders GSI3` and `Cases GSI4` (sparse): timers of a world while SCHEDULED. */
export const clockDueKey = (clockId: string): string => `CLOCK#${clockId}`;

export function timerHomePartition(home: TimerHome): string {
  switch (home.kind) {
    case "WORK_ORDER":
      return workOrderPartition(home.id);
    case "CASE":
      return casePartition(home.id);
    case "PERSON":
      return personPartition(home.id);
  }
}

export const timerKey = (home: TimerHome, kind: TimerKind, timerId: string): Key => ({ PK: timerHomePartition(home), SK: `${TIMER_PREFIX}${kind}#${timerId}` });

/** What a schedule carries to `ScheduleDispatch` to find its timer: `<HOME>|<homeId>|<kind>|<timerId>`. */
export function timerRefKey(ref: { readonly home: TimerHome; readonly kind: TimerKind; readonly timerId: string }): string {
  return `${ref.home.kind}|${ref.home.id}|${ref.kind}|${ref.timerId}`;
}

/** Inverse of `timerRefKey`; `undefined` for anything it would not have produced. */
export function parseTimerRefKey(value: string): { home: TimerHome; kind: TimerKind; timerId: string } | undefined {
  const [homeKind, homeId, kind, timerId, ...rest] = value.split("|");
  if (rest.length > 0) return undefined;
  const home = TimerHome.safeParse({ kind: homeKind, id: homeId });
  const parsedKind = TimerKind.safeParse(kind);
  const parsedId = TimerId.safeParse(timerId);
  return home.success && parsedKind.success && parsedId.success ? { home: home.data, kind: parsedKind.data, timerId: parsedId.data } : undefined;
}

// ---- Cases -------------------------------------------------------------------------------------

export const casePartition = (caseId: string): string => `CASE#${caseId}`;
export const caseKey = (caseId: string): Key => ({ PK: casePartition(caseId), SK: META });
/** `Cases GSI1`: cases of an order, by creation. */
export const caseWorkOrderKey = (workOrderId: string): string => `WO#${workOrderId}`;
/** `Cases GSI2` (sparse): cases a supervisor has taken, to route their messages. */
export const takenByKey = (personId: string): string => `SUP#${personId}#TAKEN`;
/** `Cases GSI3`: the operator's inbox by status. */
export const ispStatusKey = (ispId: string, status: string): string => `ISP#${ispId}#${status}`;

// ---- Conversations -----------------------------------------------------------------------------

export const MSG_PREFIX = "MSG#";
export const messageKey = (personId: string, sentAtSim: string, messageId: string): Key => ({ PK: personPartition(personId), SK: `${MSG_PREFIX}${sentAtSim}#${messageId}` });
export const EVT_PREFIX = "EVT#";
export const messageEventKey = (personId: string, atReal: string, eventId: string): Key => ({ PK: personPartition(personId), SK: `${EVT_PREFIX}${atReal}#${eventId}` });
export const NOTE_PREFIX = "NOTE#";
export const turnNoteKey = (personId: string, atSim: string, turnId: string): Key => ({ PK: personPartition(personId), SK: `${NOTE_PREFIX}${atSim}#${turnId}` });
export const outboxPartition = (ispId: string): string => `OUTBOX#${ispId}`;
export const MAIL_PREFIX = "MAIL#";
export const outboundEmailKey = (ispId: string, sentAtSim: string, mailId: string): Key => ({ PK: outboxPartition(ispId), SK: `${MAIL_PREFIX}${sentAtSim}#${mailId}` });
/** `Conversations GSI2` and `AuditLog GSI1`: the timeline of an order. */
export const timelineKey = (workOrderId: string): string => `WO#${workOrderId}`;

// ---- AuditLog ----------------------------------------------------------------------------------

/** `ISP#<ispId>#<yyyy-mm>` of a UTC ISO instant. */
export const auditPartition = (ispId: string, ts: string): string => `ISP#${ispId}#${ts.slice(0, 7)}`;
export const auditKey = (ispId: string, ts: string, decisionId: string): Key => ({ PK: auditPartition(ispId, ts), SK: `${ts}#${decisionId}` });
/** `AuditLog GSI2`: an operator's decisions of one kind. */
export const decisionKey = (ispId: string, decision: string): string => `ISP#${ispId}#${decision}`;

// ---- Reference ---------------------------------------------------------------------------------

export const referencePartition = (type: string, scope: string): string => `REF#${type}#${scope}`;
export const referenceKey = (type: string, scope: string, key: string): Key => ({ PK: referencePartition(type, scope), SK: key });
export const GLOBAL_SCOPE = "GLOBAL";

// ---- Runtime -----------------------------------------------------------------------------------

export const sessionKey = (sessionId: string): Key => ({ PK: `SESSION#${sessionId}`, SK: META });
export const turnPartition = (turnId: string): string => `TURN#${turnId}`;
export const turnKey = (turnId: string): Key => ({ PK: turnPartition(turnId), SK: META });
export const RESULT_PREFIX = "RESULT#";
export const turnResultPrefix = (tool: string): string => `${RESULT_PREFIX}${tool}#`;
export const turnResultKey = (turnId: string, tool: string, seq: number): Key => ({ PK: turnPartition(turnId), SK: `${turnResultPrefix(tool)}${pad3(seq)}` });
export const nonceKey = (nonce: string): Key => ({ PK: `NONCE#${nonce}`, SK: META });
export const clockKey = (clockId: string): Key => ({ PK: `CLOCK#${clockId}`, SK: META });
export const idempotencyKey = (source: string, id: string): Key => ({ PK: `IDEMP#${source}#${id}`, SK: META });
export const installerStateKey = (installerId: string): Key => ({ PK: `INSTSTATE#${installerId}`, SK: META });
export const worldStateKey = (clockId: string): Key => ({ PK: `WORLDSTATE#${clockId}`, SK: META });
export const pendingPartition = (clockId: string): string => `PENDING#${clockId}`;
export const pendingMailKey = (clockId: string, mailId: string): Key => ({ PK: pendingPartition(clockId), SK: `${MAIL_PREFIX}${mailId}` });
export const leaseKey = (kind: LeaseKind, n: number): Key => ({ PK: `LEASE#${kind}#${n}`, SK: META });
export const phoneLeaseKey = (phoneHash: string): Key => ({ PK: `PHONELEASE#${phoneHash}`, SK: META });
export const joinCodeKey = (code: string): Key => ({ PK: `JOINCODE#${code}`, SK: META });
export const uploadKey = (uploadId: string): Key => ({ PK: `UPLOAD#${uploadId}`, SK: META });
export const LIVE_WORLD_KEY: Key = { PK: "LIVEWORLD", SK: META };
export const tombstoneKey = (clockId: string, worldEpoch: number): Key => ({ PK: `TOMB#${clockId}#${worldEpoch}`, SK: META });
export const probeKey = (probeId: string): Key => ({ PK: `PROBE#${probeId}`, SK: META });
export const worldSessionKey = (clockId: string): Key => ({ PK: `WORLDSESSION#${clockId}`, SK: META });
export const foreignProbeId = (eventId: string): string => `foreign#${eventId}`;
export const faultsKey = (clockId: string): Key => ({ PK: `FAULTS#${clockId}`, SK: META });
/** `KILL#<scope>` (global) or `KILL#AGENT#<clockId>` (one world). */
export function killKey(scope: KillScope, clockId?: string): Key {
  if (clockId !== undefined && scope !== "AGENT") throw new RangeError("only the AGENT kill switch exists per world");
  return { PK: clockId === undefined ? `KILL#${scope}` : `KILL#AGENT#${clockId}`, SK: META };
}

// ---- Runtime counters (docs/architecture.md §5) ------------------------------------------------

/** `yyyy-mm-ddThh` of an instant in UTC: the real hour of anti-abuse limits and caps. */
export const hourKey = (instant: Date): string => instant.toISOString().slice(0, 13);
/** `yyyy-mm-dd` of an instant in UTC: the real day of caps. */
export const dayKey = (instant: Date): string => instant.toISOString().slice(0, 10);

/** Plain counters (docs/architecture.md §5); cost caps are keyed by ops/cost-caps.ts. */
export const COUNTER_KEYS = {
  /** Business rate limit in simulated hours: "+1 h" of the world clock opens a new window. */
  rateSim: (clockId: string, addressHash: string, simHour: string): string => `RATE#${clockId}#${addressHash}#${simHour}`,
  /** Anti-abuse rate limit in real hours: "+1 h" never resets it. */
  rateReal: (clockId: string, addressHash: string, realHour: string): string => `RATE#${clockId}#${addressHash}#REAL#${realHour}`,
  unknownReplies: (realDay: string): string => `UNKNOWN#GLOBAL#${realDay}`,
  jump: (clockId: string, realHour: string): string => `JUMP#${clockId}#${realHour}`,
  epoch: (clockId: string): string => `COUNTER#EPOCH#${clockId}`,
  named: (name: string): string => `COUNTER#${name}`,
} as const;

export const counterRowKey = (counterKey: string): Key => ({ PK: counterKey, SK: META });

// ---- CuadrillaMetrics --------------------------------------------------------------------------

export const metricsPartition = (ispId: string): string => `ISP#${ispId}`;
export const kpiKey = (ispId: string, source: string, clockId: string, workOrderId: string): Key => ({ PK: metricsPartition(ispId), SK: `${source}#${clockId}#${workOrderId}` });
export const evalResultPrefix = (runId: string, kind?: "Q" | "P"): string => (kind === undefined ? `EVAL#${runId}#` : `EVAL#${runId}#${kind}#`);
export const evalResultKey = (ispId: string, runId: string, kind: "Q" | "P", itemId: string): Key => ({ PK: metricsPartition(ispId), SK: `${evalResultPrefix(runId, kind)}${itemId}` });
