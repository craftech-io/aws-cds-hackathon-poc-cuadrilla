// Ports of the operational aggregates: operators, people, work orders (with checklist, evidence,
// validations, steps and certificate), timers and cases. Handlers depend on these interfaces, never
// on @aws-sdk/lib-dynamodb; the same implementation runs over DynamoDB and over memory.
import type {
  CaseStatus,
  ChecklistItem,
  ChecklistItemStatus,
  RejectReason,
  StepOutcome,
  TemplateName,
  TemplateStatus,
  TimerFiredBy,
  TimerKind,
  TimerStatus,
  WorkOrderStatus,
} from "@cuadrilla/shared";
import type { Case, LadderEntry } from "../domain/cases";
import type { NewEntity, Transition } from "../domain/common";
import type { ConsoleUser, Crew, Isp, IspSettings, ShiftRoster, Zone } from "../domain/isps";
import type { AddressClaim, Consent, ConsentMedium, Customer, InstallerProfile, Person, ProfileEvent, ShiftWindow, StaffRole } from "../domain/people";
import type { Timer, TimerHome } from "../domain/timers";
import type {
  Certificate,
  CertificateDelivery,
  ChecklistEntry,
  Evidence,
  ManualOverride,
  OnuReading,
  PhotoValidation,
  TroubleshootingStep,
  WorkOrder,
} from "../domain/work-orders";

export interface UserMatch {
  readonly userId: string;
  readonly active: boolean;
}

export type SettingsPatch = Partial<Omit<NewEntity<typeof IspSettings>, "ispId" | "clockId" | "history">>;

export interface IspsPort {
  getIsp(ispId: string): Promise<Isp | undefined>;
  /** Create or replace the operator row (world factory, seed). */
  putIsp(isp: NewEntity<typeof Isp>): Promise<Isp>;
  /** `resolveBrand` output of the world (ADR-0018); `null` removes it. */
  setDisplayName(ispId: string, displayName: string | null): Promise<Isp>;
  getSettings(ispId: string): Promise<IspSettings | undefined>;
  putSettings(settings: NewEntity<typeof IspSettings>): Promise<IspSettings>;
  updateSettings(ispId: string, patch: SettingsPatch, options?: { readonly expectedVersion?: number }): Promise<IspSettings>;
  /** Simulated template state of the world (plan B), with its history. */
  setTemplateStatus(ispId: string, name: TemplateName, status: TemplateStatus, transition: Transition): Promise<IspSettings>;
  getZone(ispId: string, zoneId: string): Promise<Zone | undefined>;
  listZones(ispId: string): Promise<Zone[]>;
  putZone(zone: NewEntity<typeof Zone>): Promise<Zone>;
  getCrew(ispId: string, crewId: string): Promise<Crew | undefined>;
  listCrews(ispId: string): Promise<Crew[]>;
  putCrew(crew: NewEntity<typeof Crew>): Promise<Crew>;
  getRoster(ispId: string, crewId: string, date: string): Promise<ShiftRoster | undefined>;
  listRosters(ispId: string, crewId: string): Promise<ShiftRoster[]>;
  /** Creates the roster of a crew and day, or changes its supervisors with a dated history. */
  setRoster(roster: NewEntity<typeof ShiftRoster>, transition: Transition): Promise<ShiftRoster>;
  getUser(ispId: string, userId: string): Promise<ConsoleUser | undefined>;
  listUsers(ispId: string): Promise<ConsoleUser[]>;
  /** Create or replace a console user; an empty `cognitoSub` keeps the stored one (a reload never unlinks). */
  putUser(user: NewEntity<typeof ConsoleUser>): Promise<ConsoleUser>;
  /** The console user of a Cognito `sub` (`GSI1 SUB#<sub>`), in any operator. */
  findUserBySub(sub: string): Promise<ConsoleUser | undefined>;
  /** `UserLookup` of auth/staff.ts: the user of `sub` only if it belongs to `ispId`. */
  findBySub(ispId: string, sub: string): Promise<UserMatch | undefined>;
  setCognitoSub(ispId: string, userId: string, sub: string): Promise<ConsoleUser>;
  setUserActive(ispId: string, userId: string, active: boolean): Promise<ConsoleUser>;
}

export interface PhoneContact {
  /** Normalized E.164. */
  readonly phone: string;
  /** HMAC of the phone with the `phone-hash` subkey. */
  readonly phoneHash: string;
}

export interface PersonPatch {
  readonly firstName?: string;
  readonly lastName?: string;
  readonly crewId?: string | null;
  readonly zoneId?: string | null;
  readonly email?: string | null;
  /** A new phone moves the world's `ADDR#` claim in the same transaction; `null` releases it. */
  readonly contact?: PhoneContact | null;
}

export interface PeoplePort {
  getPerson(personId: string): Promise<Person | undefined>;
  requirePerson(personId: string): Promise<Person>;
  listPeople(ispId: string, role: StaffRole): Promise<Person[]>;
  /** Identity by phone within a world; throws `AmbiguousIdentityError` rather than guess. */
  findByPhone(clockId: string, phoneHash: string): Promise<Person | undefined>;
  /** The person and its `ADDR#<clockId>#<phoneHash>` claim in one transaction; CONFLICT if the phone is taken in the world. */
  createPerson(person: NewEntity<typeof Person>): Promise<Person>;
  updatePerson(personId: string, patch: PersonPatch, options?: { readonly expectedVersion?: number }): Promise<Person>;
  /** Allow list switch, with a dated history (PolicyAudit). */
  setActive(personId: string, active: boolean, transition: Transition): Promise<Person>;
  /** Every inbound message (a button tap included) opens the 24 h window. */
  recordInbound(personId: string, at: { readonly atSim?: string; readonly atReal?: string }): Promise<Person>;
  getAddressClaim(clockId: string, phoneHash: string): Promise<AddressClaim | undefined>;
  getCustomer(customerId: string): Promise<Customer | undefined>;
  listCustomers(ispId: string): Promise<Customer[]>;
  putCustomer(customer: NewEntity<typeof Customer>): Promise<Customer>;
  getConsent(personId: string): Promise<Consent | undefined>;
  grantConsent(input: { readonly personId: string; readonly clockId: string; readonly medium: ConsentMedium; readonly textVersion: string }, transition: Transition): Promise<Consent>;
  revokeConsent(personId: string, transition: Transition): Promise<Consent>;
  getProfile(installerId: string): Promise<InstallerProfile | undefined>;
  putProfile(profile: NewEntity<typeof InstallerProfile>): Promise<InstallerProfile>;
  /** Adds one measured event (count and dated event) to the installer's profile. */
  recordProfileEvent(installerId: string, clockId: string, event: ProfileEvent): Promise<InstallerProfile>;
  getShiftWindow(personId: string): Promise<ShiftWindow | undefined>;
  openShiftWindow(window: NewEntity<typeof ShiftWindow>): Promise<ShiftWindow>;
}

export interface ChecklistChange {
  readonly status?: ChecklistItemStatus;
  /** Adds to `attempts` (rejected photos of the item). */
  readonly addAttempts?: number;
  readonly lastRejectReason?: RejectReason | null;
  readonly validationId?: string | null;
  readonly evidenceId?: string | null;
  readonly override?: ManualOverride | null;
  readonly updatedAtSim?: string;
}

export interface ChecklistGuard {
  readonly expectedVersion?: number;
  readonly expectedStatus?: readonly ChecklistItemStatus[];
}

export type WorkOrderPatch = Partial<
  Pick<WorkOrder, "installerId" | "crewId" | "zoneId" | "date" | "appointmentWindow" | "plan" | "onuSerial" | "onuModel" | "oltPort" | "opticalClass" | "failedReason" | "closedAtSim">
>;

export interface WorkOrdersPort {
  getWorkOrder(workOrderId: string): Promise<WorkOrder | undefined>;
  requireWorkOrder(workOrderId: string): Promise<WorkOrder>;
  /** The order plus its five `CHECK#` items in `PENDING` (unless `checklist: false`), in one transaction. */
  createWorkOrder(workOrder: NewEntity<typeof WorkOrder>, options?: { readonly checklist?: boolean }): Promise<WorkOrder>;
  /** Orders of an installer's simulated day, by appointment start (`GSI1`). */
  listInstallerDay(installerId: string, date: string): Promise<WorkOrder[]>;
  /** Orders of an operator's simulated day, optionally of one status (`GSI2`). */
  listIspDay(ispId: string, date: string, status?: WorkOrderStatus): Promise<WorkOrder[]>;
  /** Status transition with history; `from` guards the current status (conditional write). */
  setStatus(workOrderId: string, to: WorkOrderStatus, transition: Transition, guard?: { readonly from?: readonly WorkOrderStatus[]; readonly expectedVersion?: number }): Promise<WorkOrder>;
  /** Dispatch changes (reschedule, reassign) and closing fields; recomputes the GSI keys. */
  updateWorkOrder(workOrderId: string, patch: WorkOrderPatch, options?: { readonly expectedVersion?: number }): Promise<WorkOrder>;
  recordOnuReading(workOrderId: string, reading: OnuReading): Promise<WorkOrder>;
  setOnHoldSafety(workOrderId: string, onHold: boolean, transition: Transition): Promise<WorkOrder>;
  /** A G1 block of the Harness opens a new AgentCore session for the order. */
  bumpSessionEpoch(workOrderId: string): Promise<WorkOrder>;
  listChecklist(workOrderId: string): Promise<ChecklistEntry[]>;
  getChecklistItem(workOrderId: string, item: ChecklistItem): Promise<ChecklistEntry | undefined>;
  /** Create or replace a checklist item (world presets, seed). */
  putChecklistItem(entry: NewEntity<typeof ChecklistEntry>): Promise<ChecklistEntry>;
  updateChecklistItem(workOrderId: string, item: ChecklistItem, change: ChecklistChange, transition: Transition, guard?: ChecklistGuard): Promise<ChecklistEntry>;
  createEvidence(evidence: NewEntity<typeof Evidence>): Promise<Evidence>;
  getEvidence(workOrderId: string, evidenceId: string): Promise<Evidence | undefined>;
  listEvidence(workOrderId: string): Promise<Evidence[]>;
  /** Evidence with these bytes in the world and its epoch (`GSI4`, `DUPLICATE_EVIDENCE`). */
  findEvidenceByHash(clockId: string, worldEpoch: number, sha256: string): Promise<Evidence[]>;
  createValidation(validation: NewEntity<typeof PhotoValidation>): Promise<PhotoValidation>;
  getValidation(workOrderId: string, validationId: string): Promise<PhotoValidation | undefined>;
  listValidations(workOrderId: string, item?: ChecklistItem): Promise<PhotoValidation[]>;
  /** Appends a step with the next sequence number of the order. */
  appendStep(step: Omit<NewEntity<typeof TroubleshootingStep>, "seq">): Promise<TroubleshootingStep>;
  listSteps(workOrderId: string): Promise<TroubleshootingStep[]>;
  updateStepOutcome(workOrderId: string, seq: number, outcome: StepOutcome, transition: Transition): Promise<TroubleshootingStep>;
  getCertificate(workOrderId: string): Promise<Certificate | undefined>;
  /** Create or replace the certificate (a re-render with a new brand keeps its deliveries). */
  putCertificate(certificate: NewEntity<typeof Certificate>): Promise<Certificate>;
  /** Replaces the delivery to the same recipient and channel, or adds it. */
  setDelivery(workOrderId: string, delivery: CertificateDelivery): Promise<Certificate>;
}

export interface TimerStatusChange {
  readonly status: Exclude<TimerStatus, "SCHEDULED">;
  readonly firedBy?: TimerFiredBy;
  readonly firedAtSim?: string;
  readonly reason?: string;
}

export interface TimerRef {
  readonly home: TimerHome;
  readonly kind: TimerKind;
  readonly timerId: string;
}

export interface TimersPort {
  /** Creates a timer; CONFLICT if one with the same key exists (a timer is created once). */
  createTimer(timer: NewEntity<typeof Timer>): Promise<Timer>;
  getTimer(ref: TimerRef): Promise<Timer | undefined>;
  listTimers(home: TimerHome): Promise<Timer[]>;
  /** FIRED, SKIPPED or CANCELLED; leaves the due index. Conditional on the version the caller read. */
  setTimerStatus(ref: TimerRef, change: TimerStatusChange, expectedVersion: number): Promise<Timer>;
  /** Back to SCHEDULED at a new due time (worker re-evaluation, deferred sends). */
  rescheduleTimer(ref: TimerRef, dueAtSim: string, expectedVersion: number, options?: { readonly payload?: Record<string, unknown>; readonly reason?: string }): Promise<Timer>;
  setScheduleName(ref: TimerRef, scheduleName: string | null, expectedVersion: number): Promise<Timer>;
  deleteTimer(ref: TimerRef): Promise<void>;
  /** SCHEDULED timers of a world due at or before `uptoSim`, by due time (orders and cases). */
  listDueTimers(clockId: string, uptoSim?: string, limit?: number): Promise<Timer[]>;
  /** SCHEDULED timers that live on people (DAY_START of installers without orders). */
  listDuePersonTimers(ispId: string, uptoSim?: string): Promise<Timer[]>;
}

export interface CaseGuard {
  readonly expectedVersion?: number;
  readonly rungVersion?: number;
  readonly status?: readonly CaseStatus[];
}

export type CasePatch = Partial<Pick<Case, "status" | "rung" | "takenBy" | "takenAtSim" | "summary" | "evidenceIds" | "bridge" | "closedAtSim" | "closedBy" | "closeSummary" | "hazardCategory">>;

export interface CasesPort {
  createCase(caseItem: NewEntity<typeof Case>): Promise<Case>;
  getCase(caseId: string): Promise<Case | undefined>;
  requireCase(caseId: string): Promise<Case>;
  /** Cases of an order, by creation (`GSI1`). */
  listCasesOfWorkOrder(workOrderId: string): Promise<Case[]>;
  /** The operator's inbox of one status (`GSI3`). */
  listCasesByStatus(ispId: string, status: CaseStatus): Promise<Case[]>;
  /** Cases a supervisor holds (`GSI2`), to route their messages. */
  listTakenBy(personId: string): Promise<Case[]>;
  /** Conditional update (version, rungVersion, status); status and rung changes enter the history. */
  updateCase(caseId: string, patch: CasePatch, guard: CaseGuard, transition?: Transition): Promise<Case>;
  /** Appends a ladder step; with `rung`, moves to that rung and bumps `rungVersion`. */
  advanceLadder(caseId: string, entry: LadderEntry, guard: CaseGuard & { readonly rungVersion: number }, move?: { readonly rung: Case["rung"] }): Promise<Case>;
  /** "Tomar caso": wins only while the case is OPEN (the first supervisor). */
  takeCase(caseId: string, supervisorId: string, transition: Transition & { readonly atSim: string }, guard?: CaseGuard): Promise<Case>;
  closeCase(caseId: string, input: { readonly closeSummary?: string }, transition: Transition & { readonly atSim: string }, guard?: CaseGuard): Promise<Case>;
}
