// The `Connector` port (docs/build-plan.md WP-07): one object with a port per aggregate. Handlers,
// tools, the worker and the routers receive it by injection; `connector/index.ts` builds it over
// DynamoDB in a Lambda and `createMemoryConnector()` over memory in tests and local flows.
import type { CasesPort, IspsPort, PeoplePort, TimersPort, WorkOrdersPort } from "./ports-data";
import type { AuditPort, ConversationsPort, MetricsPort, ReferencePort, RuntimePort, SeedStore, WorldRuntimePort } from "./ports-runtime";

export interface Connector {
  readonly isps: IspsPort;
  readonly people: PeoplePort;
  readonly workOrders: WorkOrdersPort;
  readonly timers: TimersPort;
  readonly cases: CasesPort;
  readonly conversations: ConversationsPort;
  readonly audit: AuditPort;
  readonly reference: ReferencePort;
  readonly runtime: RuntimePort;
  readonly worlds: WorldRuntimePort;
  readonly metrics: MetricsPort;
  readonly seed: SeedStore;
}

export type {
  CaseGuard,
  CasePatch,
  CasesPort,
  ChecklistChange,
  ChecklistGuard,
  IspsPort,
  PeoplePort,
  PersonPatch,
  PhoneContact,
  SettingsPatch,
  TimerRef,
  TimerStatusChange,
  TimersPort,
  UserMatch,
  WorkOrderPatch,
  WorkOrdersPort,
} from "./ports-data";

export type {
  AuditPort,
  ConversationsPort,
  CounterReservation,
  DecisionInput,
  KpiDelta,
  KpiRef,
  MailRef,
  MessagePatch,
  MessageRef,
  MetricsPort,
  PendingMailState,
  ReferencePort,
  ReservationResult,
  RuntimePort,
  SeedLoadResult,
  SeedStore,
  TimelineEntry,
  WorldRuntimePort,
} from "./ports-runtime";
