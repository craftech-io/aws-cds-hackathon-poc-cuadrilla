// The row codec of every entity: its table, its key and its GSI attributes, computed from the entity's
// own fields. Repositories build every row through here and the seed store checks every seeded row
// against it, so a row written by the seed, a preset or the product is always the same row.
// Instants that are sort keys (`dueAtSim`, `createdAtSim`, `sentAtSim`, `ts`) are stored in UTC ISO
// form (`utcIso`), so lexical order is time order in every index.
import { ConnectorError, type PersonRole } from "@cuadrilla/shared";
import * as K from "./keys";
import type { EntityName } from "../domain/common";
import type { DomainTable } from "../domain/registry";
import type { TimerHome } from "../domain/timers";
import { utcIso, type Key } from "./table-client";

type Fields = Record<string, unknown>;

export interface RowCodec {
  /** Table of the row (a timer's table depends on its home). */
  table(fields: Fields): DomainTable;
  key(fields: Fields): Key;
  /** GSI attributes; an absent attribute keeps the row out of a sparse index. */
  gsi(fields: Fields): Fields;
  /** Fields whose stored form is normalized (UTC instants used as sort keys). */
  normalize(fields: Fields): Fields;
}

const str = (fields: Fields, name: string): string => {
  const value = fields[name];
  if (typeof value !== "string" || value.length === 0) throw new RangeError(`missing key field ${name}`);
  return value;
};
const num = (fields: Fields, name: string): number => {
  const value = fields[name];
  if (typeof value !== "number") throw new RangeError(`missing key field ${name}`);
  return value;
};
const opt = (fields: Fields, name: string): string | undefined => (typeof fields[name] === "string" && fields[name] !== "" ? (fields[name] as string) : undefined);

function utcFields(...names: string[]): (fields: Fields) => Fields {
  return (fields) => Object.fromEntries(names.filter((name) => typeof fields[name] === "string").map((name) => [name, utcIso(fields[name] as string)]));
}

function codec(table: DomainTable, key: (fields: Fields) => Key, gsi: (fields: Fields) => Fields = () => ({}), normalize: (fields: Fields) => Fields = () => ({})): RowCodec {
  return { table: () => table, key, gsi, normalize };
}

/** Table a timer lives in, by its home. */
export function timerTableOf(home: TimerHome): DomainTable {
  return home.kind === "WORK_ORDER" ? "WorkOrders" : home.kind === "CASE" ? "Cases" : "People";
}

const timelineGsi = (at: string) => (fields: Fields): Fields => {
  const workOrderId = opt(fields, "workOrderId");
  return workOrderId === undefined ? {} : { workOrderKey: K.timelineKey(workOrderId), sentAtSim: utcIso(str(fields, at)) };
};

const personGsi = (role: PersonRole) => (fields: Fields): Fields => ({
  ispKindKey: K.ispKindKey(str(fields, "ispId"), role),
  sortName: K.sortName(str(fields, "lastName"), str(fields, "firstName"), str(fields, role === "CUSTOMER" ? "customerId" : "personId")),
});

export const CODECS: Readonly<Record<EntityName, RowCodec>> = {
  Isp: codec("Isps", (f) => K.ispKey(str(f, "ispId"))),
  IspSettings: codec("Isps", (f) => K.ispSettingsKey(str(f, "ispId"))),
  Zone: codec("Isps", (f) => K.zoneKey(str(f, "ispId"), str(f, "zoneId"))),
  Crew: codec("Isps", (f) => K.crewKey(str(f, "ispId"), str(f, "crewId"))),
  ShiftRoster: codec("Isps", (f) => K.rosterKey(str(f, "ispId"), str(f, "crewId"), str(f, "date"))),
  ConsoleUser: codec(
    "Isps",
    (f) => K.userKey(str(f, "ispId"), str(f, "userId")),
    (f) => (opt(f, "cognitoSub") === undefined ? {} : { cognitoSubKey: K.cognitoSubKey(str(f, "cognitoSub")) }),
  ),
  Person: codec(
    "People",
    (f) => K.personKey(str(f, "personId")),
    (f) => ({
      ...personGsi(str(f, "role") as PersonRole)(f),
      ...(opt(f, "phoneHash") === undefined ? {} : { phoneKey: K.phoneKey(str(f, "clockId"), str(f, "phoneHash")) }),
    }),
  ),
  Customer: codec("People", (f) => K.customerKey(str(f, "customerId")), personGsi("CUSTOMER")),
  Consent: codec("People", (f) => K.consentKey(str(f, "personId"))),
  InstallerProfile: codec("People", (f) => K.profileKey(str(f, "installerId"))),
  ShiftWindow: codec("People", (f) => K.shiftWindowKey(str(f, "personId"))),
  AddressClaim: codec("People", (f) => K.addressClaimKey(str(f, "clockId"), str(f, "phoneHash"))),
  WorkOrder: codec(
    "WorkOrders",
    (f) => K.workOrderKey(str(f, "workOrderId")),
    (f) => {
      const window = f.appointmentWindow as { startSim?: unknown } | undefined;
      const start = typeof window?.startSim === "string" ? window.startSim : "";
      return {
        installerDayKey: K.installerDayKey(str(f, "installerId"), str(f, "date")),
        windowStartSim: utcIso(start),
        ispDayKey: K.ispDayKey(str(f, "ispId"), str(f, "date")),
      };
    },
  ),
  ChecklistItem: codec("WorkOrders", (f) => K.checklistKey(str(f, "workOrderId"), str(f, "item") as never)),
  Evidence: codec(
    "WorkOrders",
    (f) => K.evidenceKey(str(f, "workOrderId"), str(f, "evidenceId")),
    (f) => ({ evidenceHash: K.evidenceHashKey(str(f, "clockId"), num(f, "worldEpoch"), str(f, "sha256")) }),
  ),
  PhotoValidation: codec("WorkOrders", (f) => K.validationKey(str(f, "workOrderId"), str(f, "validationId"))),
  TroubleshootingStep: codec("WorkOrders", (f) => K.stepKey(str(f, "workOrderId"), num(f, "seq"))),
  Certificate: codec("WorkOrders", (f) => K.certificateKey(str(f, "workOrderId"))),
  Timer: {
    table: (f) => timerTableOf(f.home as TimerHome),
    key: (f) => K.timerKey(f.home as TimerHome, str(f, "kind") as never, str(f, "timerId")),
    gsi: (f) => (f.status === "SCHEDULED" ? { clockDueKey: K.clockDueKey(str(f, "clockId")) } : {}),
    normalize: utcFields("dueAtSim"),
  },
  Case: codec(
    "Cases",
    (f) => K.caseKey(str(f, "caseId")),
    (f) => ({
      workOrderKey: K.caseWorkOrderKey(str(f, "workOrderId")),
      ispStatusKey: K.ispStatusKey(str(f, "ispId"), str(f, "status")),
      ...(f.status === "TAKEN" && opt(f, "takenBy") !== undefined ? { takenByKey: K.takenByKey(str(f, "takenBy")) } : {}),
    }),
    utcFields("createdAtSim"),
  ),
  Message: codec("Conversations", (f) => K.messageKey(str(f, "personId"), utcIso(str(f, "sentAtSim")), str(f, "messageId")), timelineGsi("sentAtSim"), utcFields("sentAtSim")),
  MessageEvent: codec("Conversations", (f) => K.messageEventKey(str(f, "personId"), utcIso(str(f, "atReal")), str(f, "eventId"))),
  TurnNote: codec("Conversations", (f) => K.turnNoteKey(str(f, "personId"), utcIso(str(f, "atSim")), str(f, "turnId")), timelineGsi("atSim"), utcFields("atSim")),
  OutboundEmail: codec("Conversations", (f) => K.outboundEmailKey(str(f, "ispId"), utcIso(str(f, "sentAtSim")), str(f, "mailId")), timelineGsi("sentAtSim"), utcFields("sentAtSim")),
  Decision: codec(
    "AuditLog",
    (f) => K.auditKey(str(f, "ispId"), utcIso(str(f, "ts")), str(f, "decisionId")),
    (f) => {
      const workOrderId = (f.refs as { workOrderId?: unknown } | undefined)?.workOrderId;
      return {
        decisionKey: K.decisionKey(str(f, "ispId"), str(f, "decision")),
        ...(typeof workOrderId === "string" && workOrderId !== "" ? { workOrderKey: K.timelineKey(workOrderId) } : {}),
      };
    },
    utcFields("ts"),
  ),
  Template: codec("Reference", (f) => K.referenceKey("TEMPLATE", "WHATSAPP", str(f, "name"))),
  RateCard: codec("Reference", (f) => K.referenceKey("RATECARD", K.GLOBAL_SCOPE, str(f, "key"))),
  NameCheck: codec("Reference", (f) => K.referenceKey("NAMECHECK", K.GLOBAL_SCOPE, str(f, "term"))),
  Rubric: codec("Reference", (f) => K.referenceKey("RUBRIC", str(f, "rubricVersion"), str(f, "item"))),
  SafetyLexicon: codec("Reference", (f) => K.referenceKey("SAFETY_LEXICON", str(f, "lexiconVersion"), str(f, "entryKey"))),
  ManualIndex: codec("Reference", (f) => K.referenceKey("MANUALINDEX", str(f, "manualVersion"), str(f, "sectionId"))),
  KbThreshold: codec("Reference", (f) => K.referenceKey("KBTHRESHOLD", str(f, "thresholdVersion"), K.META)),
  EvalQuestion: codec("Reference", (f) => K.referenceKey("EVAL", "QUESTIONS", str(f, "questionId"))),
  EvalPhoto: codec("Reference", (f) => K.referenceKey("EVAL", "PHOTOS", str(f, "photoId"))),
  RejectReasonCopy: codec("Reference", (f) => K.referenceKey("REJECT_REASON_COPY", str(f, "locale"), str(f, "reason"))),
  Session: codec("Runtime", (f) => K.sessionKey(str(f, "sessionId"))),
  Turn: codec("Runtime", (f) => K.turnKey(str(f, "turnId"))),
  TurnResult: codec("Runtime", (f) => K.turnResultKey(str(f, "turnId"), str(f, "tool"), num(f, "seq"))),
  Nonce: codec("Runtime", (f) => K.nonceKey(str(f, "nonce"))),
  Clock: codec("Runtime", (f) => K.clockKey(str(f, "clockId"))),
  Idempotency: codec("Runtime", (f) => K.idempotencyKey(str(f, "source"), str(f, "id"))),
  Counter: codec("Runtime", (f) => K.counterRowKey(str(f, "counterKey"))),
  // A cap counter keeps its ledger key only in `PK` (ops/cost-caps.ts builds it).
  CapCounter: codec("Runtime", (f) => K.counterRowKey(str(f, "PK"))),
  KillSwitch: codec("Runtime", (f) => K.killKey(str(f, "scope") as never, opt(f, "clockId"))),
  InstallerState: codec("Runtime", (f) => K.installerStateKey(str(f, "installerId"))),
  WorldState: codec("Runtime", (f) => K.worldStateKey(str(f, "clockId"))),
  PendingMail: codec("Runtime", (f) => K.pendingMailKey(str(f, "clockId"), str(f, "mailId"))),
  Lease: codec("Runtime", (f) => K.leaseKey(str(f, "leaseKind") as never, num(f, "n"))),
  PhoneLease: codec("Runtime", (f) => K.phoneLeaseKey(str(f, "phoneHash"))),
  JoinCode: codec("Runtime", (f) => K.joinCodeKey(str(f, "code"))),
  Upload: codec("Runtime", (f) => K.uploadKey(str(f, "uploadId"))),
  LiveWorld: codec("Runtime", () => K.LIVE_WORLD_KEY),
  Tombstone: codec("Runtime", (f) => K.tombstoneKey(str(f, "clockId"), num(f, "worldEpoch"))),
  Probe: codec("Runtime", (f) => K.probeKey(str(f, "probeId"))),
  Faults: codec("Runtime", (f) => K.faultsKey(str(f, "clockId"))),
  WorldSession: codec("Runtime", (f) => K.worldSessionKey(str(f, "clockId"))),
  ConversationKpi: codec("CuadrillaMetrics", (f) => K.kpiKey(str(f, "ispId"), str(f, "source"), str(f, "clockId"), str(f, "workOrderId"))),
  EvalResult: codec("CuadrillaMetrics", (f) => K.evalResultKey(str(f, "ispId"), str(f, "runId"), str(f, "kind") as "Q" | "P", str(f, "itemId"))),
};

// A missing key field or an unparseable sort-key instant is a VALIDATION error (the tool envelope's
// `INVALID`), never a crash.
function encoding<T>(entity: EntityName, build: () => T): T {
  try {
    return build();
  } catch (error) {
    if (error instanceof RangeError) throw new ConnectorError("VALIDATION", `${entity}: ${error.message}`, undefined, { cause: error });
    throw error;
  }
}

/** Key, GSI attributes and normalized fields of an entity, from its own fields. */
export function encodeRow(entity: EntityName, fields: object): { table: DomainTable; key: Key; fields: Fields; gsi: Fields } {
  const rowCodec = CODECS[entity];
  return encoding(entity, () => {
    const normalized = { ...(fields as Fields), ...rowCodec.normalize(fields as Fields) };
    return { table: rowCodec.table(normalized), key: rowCodec.key(normalized), fields: normalized, gsi: rowCodec.gsi(normalized) };
  });
}

/** Table and key of an entity from the fields that make its key alone (reads). */
export function keyOf(entity: EntityName, keyFields: object): { table: DomainTable; key: Key } {
  const rowCodec = CODECS[entity];
  return encoding(entity, () => ({ table: rowCodec.table(keyFields as Fields), key: rowCodec.key(keyFields as Fields) }));
}
