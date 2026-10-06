// Lambda entry of `FeedEvents` (docs/architecture-integrations.md §7, infra/workers.ts and the rule of
// infra/feeds.ts): the events of the `Feeds` bus that the dispatch mock publishes. The work is
// feeds/dispatch-events.ts: zod over the event, the order by operator and number, deduplication by the
// dispatcher's `eventId` and `DISPATCH_EVENT` on the group of the order's installer, where the worker
// applies it (feeds/apply-dispatch.ts). An invalid event, an unknown order or a duplicate is logged and
// acknowledged; a failure to queue throws, and EventBridge delivers the event again.
import { connector } from "../connector/index";
import { type DispatchAcceptOutcome, type DispatchFeedDeps, acceptDispatchEvent } from "../feeds/dispatch-events";
import { stageQueueSink } from "../feeds/stage";
import { type Logger, createLogger, newCorrelationId } from "../lib/log";

export interface FeedEventsResult {
  readonly status: DispatchAcceptOutcome;
}

export type FeedEventsHandler = (event: unknown) => Promise<FeedEventsResult>;

const newLogger = (): Logger => createLogger({ correlationId: newCorrelationId(), bindings: { component: "feed-events" } });

export function createFeedEventsHandler(depsFor: (log: Logger) => DispatchFeedDeps, newLog: () => Logger = newLogger): FeedEventsHandler {
  return async (event) => ({ status: await acceptDispatchEvent(event, depsFor(newLog())) });
}

function stageDeps(log: Logger): DispatchFeedDeps {
  const data = connector();
  return { connector: data, queue: stageQueueSink(data), logger: log };
}

export const handler: FeedEventsHandler = createFeedEventsHandler(stageDeps);
