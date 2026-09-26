// Dispatch mock (docs/architecture-integrations.md §7): contract, events, rows, ports and router.
// Explicit re-exports only. The Lambda entry is `./handler` (it reads the linked resources), and a
// consumer that only needs the bus events imports `@cuadrilla/dispatch-mock/events`.

export {
  AppointmentWindow,
  DISPATCH_EVENT_SOURCE,
  DispatchBusEvent,
  DispatchEvent,
  DispatchEventId,
  DispatchEventType,
  DispatchReason,
  MAX_WINDOW_HOURS,
  WorkOrderCancelledDetail,
  WorkOrderReassignedDetail,
  WorkOrderRescheduledDetail,
  ZonedInstant,
  parseDispatchBusEvent,
  sameWindow,
  toBusEvent,
} from "./events";
export type { BusDelivery } from "./events";

export {
  CONFLICT_REASON,
  CancelRequest,
  DISPATCH_ROUTES,
  DispatchAction,
  DispatchCommandResult,
  DispatchErrorBody,
  DispatchEventSummary,
  DispatchHealth,
  DispatchOrderStatus,
  DispatchOrderView,
  DispatchRouteName,
  EVENT_TYPE_OF_ACTION,
  ISP_QUERY_PARAM,
  IdempotencyKey,
  ORDER_MASTER_FIELDS,
  ReassignRequest,
  RescheduleRequest,
  workOrderPath,
} from "./contract";
export type { ConflictReason, DispatchRoute } from "./contract";

export {
  DISPATCH_EVENT_SK_PREFIX,
  DISPATCH_META_SK,
  DispatchEventItem,
  DispatchOrderItem,
  dispatchEventSk,
  dispatchOrderPk,
  eventOfItem,
  orderView,
} from "./items";

export { DispatchConflictError, applyChange, memoryDispatchStore } from "./store";
export type { DispatchRecord, DispatchStore, MemoryDispatchStore, OrderChange } from "./store";

export { DYNAMO_TIMEOUTS, createDispatchDocumentClient, dynamoDispatchStore } from "./store-dynamo";
export type { DocumentSender } from "./store-dynamo";

export { EVENTBRIDGE_TIMEOUTS, PublishError, createEventBridgeClient, eventBridgePublisher, putEventsEntry, recordingPublisher } from "./publisher";
export type { EventPublisher, PublisherRetry, PutEventsSender, RecordingPublisher } from "./publisher";

export { dispatchEventId, runCommand } from "./commands";
export type { CommandDeps, CommandOutcome, DispatchCommand } from "./commands";

export { MAX_BODY_BYTES, createDispatchApi } from "./api";
export type { ApiDeps, DispatchApi, HttpRequest, HttpResponse } from "./api";

export { fromFunctionUrlEvent, toFunctionUrlResult } from "./http";

export { createLogger } from "./log";
export type { LogSink, MockLogFields, MockLogger } from "./log";
