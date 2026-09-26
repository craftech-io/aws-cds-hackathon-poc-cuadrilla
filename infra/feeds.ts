// The `Feeds` event bus and its rule to `FeedEvents` (docs/architecture.md §4 and §7,
// docs/architecture-integrations.md §7, docs/build-plan.md WP-24).
//
// The simulated dispatcher (`DispatchMock`, infra/mocks.ts) pushes `WorkOrderRescheduled`,
// `WorkOrderReassigned` and `WorkOrderCancelled` onto this bus the way a real dispatch system would.
// One rule, source `mock.dispatch` and those three detail types (the single source of both is
// packages/dispatch-mock/src/events.ts), targets `FeedEvents`, which validates with zod, resolves the
// order by operator and number, deduplicates by `eventId` and enqueues `DISPATCH_EVENT` in the
// installer's FIFO group. Nothing else publishes here and nothing else listens.
//
// Links. A linked bus hands the Lambda its name and ARN and no permission at all: SST would attach
// `events:*` on the bus. `DispatchMock` gets exactly `events:PutEvents` on it (`{Feeds}` in
// infra/iam-capabilities.ts, resolved by infra/mocks.ts). This module is the only one that creates a
// bus, so the wrap below reaches no other component.
//
// `FeedEvents` belongs to infra/workers.ts (WP-27), which sst.config.ts evaluates after this module, so
// it is read late, from the Function that module exports (under its SST name or camelCased). Until it
// does, the bus has no rule and the deploy log says so.
//
// Name: `<app>-<stage>-FeedsBus-<random>`, inside the `event-bus/<app>-*` fence of the CI deploy role;
// the rule and the Lambda permission carry the `sst:app` tag. Cost: per event published; nothing bills
// while the dispatcher is idle.
//
// Verify:
//   aws --profile craftech-demos events list-event-buses --name-prefix aws-cds-hackathon-poc-cuadrilla-poc-FeedsBus
//   aws --profile craftech-demos events list-rules --event-bus-name <bus name>
//     → one rule, EventPattern {"detail-type":["WorkOrderRescheduled","WorkOrderReassigned","WorkOrderCancelled"],"source":["mock.dispatch"]}
//   aws --profile craftech-demos events list-targets-by-rule --event-bus-name <bus name> --rule <rule name>   → FeedEvents

import { DISPATCH_EVENT_SOURCE, DispatchEventType } from "../packages/dispatch-mock/src/events";

/** Event pattern of the rule to `FeedEvents`: only what the simulated dispatcher publishes. */
export const FEED_EVENTS_PATTERN = {
  source: [DISPATCH_EVENT_SOURCE],
  detailType: [...DispatchEventType.options],
};

/** What a linked bus hands a Lambda (`Resource.Feeds.name`); every grant on it is explicit. */
export function busNameOnly(bus: { readonly name: unknown; readonly arn: unknown }): { properties: { name: unknown; arn: unknown } } {
  return { properties: { name: bus.name, arn: bus.arn } };
}

sst.Linkable.wrap(sst.aws.Bus, busNameOnly);

export const Feeds = new sst.aws.Bus("Feeds");

/** The rule and target to `FeedEvents`, once infra/workers.ts exports it; `undefined` until then. */
export const feedEventsRule = $util
  .output(
    import("./workers").then((module) => {
      const fn: unknown = Reflect.get(module, "FeedEvents") ?? Reflect.get(module, "feedEvents");
      if (fn instanceof sst.aws.Function) return fn;
      $util.log.warn("infra/workers.ts exports no FeedEvents Function yet: the Feeds bus has no rule until it does.");
      return undefined;
    }),
  )
  .apply((fn) => (fn === undefined ? undefined : Feeds.subscribe("FeedEvents", fn, { pattern: FEED_EVENTS_PATTERN })));
