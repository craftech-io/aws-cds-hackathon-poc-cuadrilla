// The `InstallerWorker` (docs/architecture.md §7, ADR-0017): one event of `InstallerEvents.fifo` at a time
// (batch 1; the events of an installer in order), dispatched by type (worker/dispatch.ts).
//
// Double idempotency: SQS drops a repeated `MessageDeduplicationId = eventId` for 5 minutes, and
// `Runtime/IDEMP#<type>#<eventId>` (7 days) is written once the event's effect is recorded, so a
// redelivery after that is acknowledged without running again, while a delivery that failed halfway runs
// again (its steps that must not repeat keep their own marks: the safety instruction, the physical action,
// the notices, the Harness itself). An event that finished, ran before, or is refused for good leaves
// `inFlight` (worker/settle.ts).
//
// An event that fails is thrown back to SQS and stays in flight. On its last attempt (`ApproximateReceiveCount
// ≥ maxReceiveCount`) the worker takes it out of `inFlight`, writes `processError` and audits
// `EVENT_DEAD_LETTERED` before rethrowing (FL-099 d). A body that does not parse is a producer's bug: logged,
// taken out of `inFlight` by what it says about itself, and acknowledged, never retried into a turn. A turn
// throttled with no time left (TurnRequeued) leaves `inFlight` in that attempt and goes back to the queue.
import type { SQSEvent, SQSRecord } from "aws-lambda";
import type { Connector } from "../connector/ports";
import { correlationIdFrom, type Logger } from "../lib/log";
import type { NetworkClient } from "../network/client";
import { type TurnDeps, TurnRequeued } from "../turns/deps";
import { dispatchEvent } from "./dispatch";
import { type InstallerQueueEvent, type LooseIdentity, MAX_RECEIVE_COUNT, MalformedEventError, isWorldEvent, looseIdentity, parseQueueEvent } from "./events";
import type { InstallerEventSink, WorkerContext, WorkerPorts } from "./ports";
import { type EventIdentity, deadLetter, settleEvent } from "./settle";

/** Remaining time when the runtime gives none (tests, local flows): the Lambda's 360 s. */
export const DEFAULT_REMAINING_MS = 360_000;

export interface WorkerDeps {
  readonly data: Connector;
  readonly turn: Omit<TurnDeps, "data" | "ports">;
  readonly ports: WorkerPorts;
  readonly network: Pick<NetworkClient, "reportPhysicalAction">;
  readonly sink: InstallerEventSink;
  /** Real time. */
  readonly now: () => Date;
  readonly loggerFor: (correlationId: string) => Logger;
}

export interface LambdaContextLike {
  getRemainingTimeInMillis(): number;
}

export type InstallerWorker = (event: SQSEvent, context?: LambdaContextLike) => Promise<void>;

function receiveCountOf(record: SQSRecord): number {
  const count = Number(record.attributes.ApproximateReceiveCount);
  return Number.isInteger(count) && count > 0 ? count : 1;
}

function identityOf(event: InstallerQueueEvent): EventIdentity | undefined {
  return isWorldEvent(event) ? { eventId: event.eventId, clockId: event.clockId, ispId: event.ispId, installerId: event.installerId } : undefined;
}

function looseEventIdentity(loose: LooseIdentity): EventIdentity | undefined {
  const { eventId, clockId, installerId } = loose;
  if (eventId === undefined || clockId === undefined || installerId === undefined) return undefined;
  return { eventId, clockId, installerId, ...(loose.ispId === undefined ? {} : { ispId: loose.ispId }) };
}

async function settle(deps: WorkerDeps, identity: EventIdentity | undefined): Promise<void> {
  if (identity !== undefined) await settleEvent(deps.data, identity);
}

async function run(deps: WorkerDeps, ctx: WorkerContext, event: InstallerQueueEvent): Promise<void> {
  if ((await deps.data.runtime.getIdempotency(event.type, event.eventId)) !== undefined) {
    ctx.log.info("event.already_processed");
    await settle(deps, identityOf(event));
    return;
  }
  await dispatchEvent({ turn: { ...deps.turn, data: deps.data, ports: deps.ports }, ports: deps.ports, network: deps.network }, ctx, event);
  await deps.data.runtime.claimIdempotency(event.type, event.eventId);
  await settle(deps, identityOf(event));
  ctx.log.info("event.processed");
}

async function processRecord(deps: WorkerDeps, record: SQSRecord, context: LambdaContextLike | undefined): Promise<void> {
  const loose = looseIdentity(record.body);
  const receiveCount = receiveCountOf(record);
  const log = deps.loggerFor(correlationIdFrom(loose.correlationId ?? loose.eventId)).child({ service: "installer-worker", type: loose.type ?? "UNKNOWN", eventId: loose.eventId, receiveCount });
  const nowMs = deps.now().getTime();
  const ctx: WorkerContext = { log, sink: deps.sink, now: deps.now, receiveCount, lambdaDeadlineMs: nowMs + (context?.getRemainingTimeInMillis() ?? DEFAULT_REMAINING_MS) };
  let event: InstallerQueueEvent;
  try {
    event = parseQueueEvent(record.body);
  } catch (error) {
    if (!(error instanceof MalformedEventError)) throw error;
    log.error("event.malformed", { reason: error.message.slice(0, 300) });
    await settle(deps, looseEventIdentity(loose));
    return;
  }
  try {
    await run(deps, ctx, event);
  } catch (error) {
    const last = receiveCount >= MAX_RECEIVE_COUNT;
    log.error("event.failed", { cause: error instanceof Error ? error.name : "unknown", lastAttempt: last });
    if (last) await deadLetter(deps.data, identityOf(event), { type: event.type, message: error instanceof Error ? error.name : "unknown", atReal: deps.now().toISOString() }, log);
    else if (error instanceof TurnRequeued) await settle(deps, identityOf(event));
    throw error;
  }
}

/** The SQS handler: batch 1, so a failure fails only its own event. */
export function createInstallerWorker(deps: WorkerDeps): InstallerWorker {
  return async (event, context) => {
    for (const record of event.Records) await processRecord(deps, record, context);
  };
}
