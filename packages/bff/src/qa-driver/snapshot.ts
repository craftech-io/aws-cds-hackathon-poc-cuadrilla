// `snapshot` of the `QaDriver` (docs/tool-catalog.md): what a scenario asserts on, read from stored state
// and the audit log, never from the wording of the model (docs/test-plan.md §4.3). One call reads the
// world (clock, pending timers, its people's quiescence) and, per order it names, the order, its checklist,
// validations, evidence, steps, cases with their ladder, certificate and deliveries, timeline (messages,
// emails, turn notes) and decisions; per person, the thread and the consent; per case, the case.
//
// The rows are the domain's as stored (synthetic data of a QA world); the runner never writes them to a
// report, only what its asserts conclude.
import type { Connector } from "../connector/ports";
import type { Decision } from "../domain/audit";
import type { Case } from "../domain/cases";
import type { Message, OutboundEmail, TurnNote } from "../domain/conversations";
import type { Consent } from "../domain/people";
import type { Timer } from "../domain/timers";
import type { Certificate, ChecklistEntry, Evidence, PhotoValidation, TroubleshootingStep, WorkOrder } from "../domain/work-orders";
import { scheduledTimers } from "../clock/state";
import { simNowOf } from "../lib/clock";
import { keyOfTimer } from "../timers/dispatch";

export interface TimerView {
  readonly timerKey: string;
  readonly kind: string;
  readonly dueAtSim: string;
  readonly home: { readonly kind: string; readonly id: string };
  readonly status?: string;
  readonly firedBy?: string;
  readonly reason?: string;
  readonly version?: number;
}

const timerView = (timer: Timer): TimerView => ({
  timerKey: keyOfTimer(timer),
  kind: timer.kind,
  dueAtSim: timer.dueAtSim,
  home: { kind: timer.home.kind, id: timer.home.id },
  status: timer.status,
  version: timer.version,
  ...(timer.firedBy === undefined ? {} : { firedBy: timer.firedBy }),
  ...(timer.reason === undefined ? {} : { reason: timer.reason }),
});

/** What a turn used, from its stored tool results (`Runtime/TURN#`): the oracle of citations and facts. */
export interface TurnView {
  readonly turnId: string;
  readonly stopReason?: string;
  readonly tools: readonly string[];
  /** Sections `search_procedures` returned in the turn. */
  readonly searchedSections: readonly string[];
  /** Every number the turn's tool results carried (readings, windows, order numbers), as text. */
  readonly figures: readonly string[];
}

export interface OrderSnapshot {
  readonly order: WorkOrder;
  readonly checklist: readonly ChecklistEntry[];
  readonly validations: readonly PhotoValidation[];
  readonly evidence: readonly Evidence[];
  readonly steps: readonly TroubleshootingStep[];
  readonly cases: readonly Case[];
  readonly certificate?: Certificate;
  readonly messages: readonly Message[];
  readonly emails: readonly OutboundEmail[];
  readonly turnNotes: readonly TurnNote[];
  readonly turns: readonly TurnView[];
  readonly decisions: readonly Decision[];
  /** Every timer of the order, whatever its status. */
  readonly timers: readonly TimerView[];
}

export interface PersonSnapshot {
  readonly personId: string;
  readonly active: boolean;
  readonly role: string;
  readonly phoneHash?: string;
  readonly lastInboundAtSim?: string;
  readonly consent?: Consent;
  readonly messages: readonly Message[];
  readonly turnNotes: readonly TurnNote[];
  readonly inFlight: readonly string[];
  readonly activeWorkOrderId?: string;
  readonly processError?: { readonly eventId: string; readonly message: string };
  /** Every timer that lives on the person (the `DAY_START` of an installer without orders). */
  readonly timers: readonly TimerView[];
}

export interface QaSnapshot {
  readonly clockId: string;
  readonly simNow: string;
  readonly mode: string;
  readonly worldEpoch: number;
  readonly timers: readonly TimerView[];
  readonly orders: readonly OrderSnapshot[];
  readonly people: readonly PersonSnapshot[];
  readonly cases: readonly Case[];
  /** Every timer of each case named (the ladder's `CASE_TIMEOUT`s, whatever their status). */
  readonly caseTimers: ReadonlyArray<{ readonly caseId: string; readonly timers: readonly TimerView[] }>;
  /** Decisions of the world's operator in the world's month (up to 500, newest last). */
  readonly decisions: readonly Decision[];
  readonly outbox: readonly OutboundEmail[];
}

export interface SnapshotDeps {
  readonly data: Connector;
  readonly now: () => Date;
}

export interface SnapshotRequest {
  readonly clockId: string;
  readonly workOrderIds: readonly string[];
  readonly personIds: readonly string[];
  readonly caseIds: readonly string[];
  readonly audit: boolean;
}

const FIGURE = /-?\d+(?:[.,]\d+)?/g;

function figuresOf(value: unknown, into: Set<string>): void {
  if (typeof value === "number") into.add(String(value));
  else if (typeof value === "string") for (const match of value.matchAll(FIGURE)) into.add(match[0]);
  else if (Array.isArray(value)) for (const item of value) figuresOf(item, into);
  else if (typeof value === "object" && value !== null) for (const item of Object.values(value)) figuresOf(item, into);
}

async function turnView(deps: SnapshotDeps, note: TurnNote): Promise<TurnView> {
  const results = await deps.data.runtime.listTurnResults(note.turnId);
  const sections = results
    .filter((result) => result.tool === "search_procedures")
    .flatMap((result) => ((result.output.passages as Array<{ sectionId?: unknown }> | undefined) ?? []).map((passage) => (typeof passage.sectionId === "string" ? passage.sectionId : "")))
    .filter((id) => id !== "");
  const figures = new Set<string>();
  for (const result of results) figuresOf(result.output, figures);
  return { turnId: note.turnId, ...(note.stopReason === undefined ? {} : { stopReason: note.stopReason }), tools: [...new Set(results.map((result) => result.tool))], searchedSections: [...new Set(sections)], figures: [...figures] };
}

const ofWorld = <T extends { readonly clockId?: string }>(clockId: string, rows: readonly T[]): T[] => rows.filter((row) => row.clockId === undefined || row.clockId === clockId);

async function orderSnapshot(deps: SnapshotDeps, clockId: string, workOrderId: string): Promise<OrderSnapshot> {
  const work = deps.data.workOrders;
  const order = await work.requireWorkOrder(workOrderId);
  const [checklist, validations, evidence, steps, cases, certificate, timeline, decisions, timers] = await Promise.all([
    work.listChecklist(workOrderId),
    work.listValidations(workOrderId),
    work.listEvidence(workOrderId),
    work.listSteps(workOrderId),
    deps.data.cases.listCasesOfWorkOrder(workOrderId),
    work.getCertificate(workOrderId),
    deps.data.conversations.listTimeline(workOrderId),
    deps.data.audit.listByWorkOrder(workOrderId),
    deps.data.timers.listTimers({ kind: "WORK_ORDER", id: workOrderId }),
  ]);
  const messages = timeline.filter((entry): entry is Message => entry.entity === "Message");
  const emails = timeline.filter((entry): entry is OutboundEmail => entry.entity === "OutboundEmail");
  const turnNotes = timeline.filter((entry): entry is TurnNote => entry.entity === "TurnNote");
  const turns = await Promise.all(turnNotes.map((note) => turnView(deps, note)));
  return {
    order,
    checklist,
    validations,
    evidence,
    steps,
    cases: ofWorld(clockId, cases),
    ...(certificate === undefined ? {} : { certificate }),
    messages,
    emails,
    turnNotes,
    turns,
    decisions: ofWorld(clockId, decisions),
    timers: timers.map(timerView),
  };
}

async function personSnapshot(deps: SnapshotDeps, personId: string): Promise<PersonSnapshot> {
  const people = deps.data.people;
  const person = await people.requirePerson(personId);
  const [consent, messages, turnNotes, state, timers] = await Promise.all([
    people.getConsent(personId),
    deps.data.conversations.listMessages(personId, { limit: 300 }),
    person.role === "INSTALLER" ? deps.data.conversations.listTurnNotes(personId, 100) : Promise.resolve([]),
    person.role === "INSTALLER" ? deps.data.worlds.getInstallerState(personId) : Promise.resolve(undefined),
    deps.data.timers.listTimers({ kind: "PERSON", id: personId }),
  ]);
  return {
    personId,
    active: person.active,
    role: person.role,
    ...(person.phoneHash === undefined ? {} : { phoneHash: person.phoneHash }),
    ...(person.lastInboundAtSim === undefined ? {} : { lastInboundAtSim: person.lastInboundAtSim }),
    ...(consent === undefined ? {} : { consent }),
    messages,
    turnNotes,
    inFlight: state?.inFlight ?? [],
    ...(state?.activeWorkOrderId === undefined ? {} : { activeWorkOrderId: state.activeWorkOrderId }),
    ...(state?.processError === undefined ? {} : { processError: { eventId: state.processError.eventId, message: state.processError.message } }),
    timers: timers.map(timerView),
  };
}

/** The world as stored right now (`snapshot`). */
export async function takeSnapshot(deps: SnapshotDeps, request: SnapshotRequest): Promise<QaSnapshot> {
  const clock = await deps.data.runtime.getClock(request.clockId);
  if (clock === undefined) return { clockId: request.clockId, simNow: "", mode: "ABSENT", worldEpoch: -1, timers: [], orders: [], people: [], cases: [], caseTimers: [], decisions: [], outbox: [] };
  const simNow = simNowOf(clock, deps.now().getTime());
  const timers = (await scheduledTimers(clock, { data: deps.data })).map(timerView);
  const orders = await Promise.all(request.workOrderIds.map((id) => orderSnapshot(deps, request.clockId, id)));
  const people = await Promise.all(request.personIds.map((id) => personSnapshot(deps, id)));
  const cases = await Promise.all(request.caseIds.map((id) => deps.data.cases.requireCase(id)));
  const caseTimers = await Promise.all(request.caseIds.map(async (caseId) => ({ caseId, timers: (await deps.data.timers.listTimers({ kind: "CASE", id: caseId })).map(timerView) })));
  const month = simNow.toISOString().slice(0, 7);
  const decisions = request.audit ? ofWorld(request.clockId, await deps.data.audit.listByMonth(clock.ispId, month, { limit: 500 })) : [];
  const outbox = ofWorld(request.clockId, await deps.data.conversations.listOutbox(clock.ispId, { limit: 100 }));
  return { clockId: request.clockId, simNow: simNow.toISOString(), mode: clock.mode, worldEpoch: clock.worldEpoch, timers, orders, people, cases: ofWorld(request.clockId, cases), caseTimers, decisions, outbox };
}
