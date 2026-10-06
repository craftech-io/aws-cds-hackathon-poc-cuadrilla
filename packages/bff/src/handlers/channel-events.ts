// Lambda entry of `ChannelEvents` (docs/architecture-integrations.md §1-§2, infra/workers.ts and the rule
// of infra/messaging-email.ts): the SES events of the app's configuration set, through the default bus.
// The work is feeds/email-events.ts: the outbox row and the world's pending mark move, and an email of
// an order whose status changed becomes `EMAIL_EVENT` on the group of the order's installer. An event
// without `EmailTags.workOrderId` is never queued (Cognito's emails carry no tag; a lead notice that
// failed only adds `LeadNotifyFailures`), and no address ever reaches a log line. An event that is not
// ours is acknowledged; a dependency that fails throws, and EventBridge delivers the event again.
//
// The configuration set is `<app>-email-<stage>` (infra/iam-capabilities.ts `EMAIL_CONFIGURATION_SET`):
// this function links its tables and the queue, not the `EmailChannel` it never sends through.
import { connector } from "../connector/index";
import { type EmailEventsDeps, type EmailEventsOutcome, processEmailEvent } from "../feeds/email-events";
import { stageQueueSink } from "../feeds/stage";
import { type Logger, createLogger, newCorrelationId } from "../lib/log";
import { currentStage } from "../lib/resource";

const APP = "aws-cds-hackathon-poc-cuadrilla";

/** `<app>-email-<stage>`: the only configuration set whose events are ours. */
export function configurationSetOf(stage: string): string {
  return `${APP}-email-${stage}`;
}

export interface ChannelEventsResult {
  readonly status: EmailEventsOutcome;
}

export type ChannelEventsHandler = (event: unknown) => Promise<ChannelEventsResult>;

const newLogger = (): Logger => createLogger({ correlationId: newCorrelationId(), bindings: { component: "channel-events" } });

export function createChannelEventsHandler(depsFor: (log: Logger) => EmailEventsDeps, newLog: () => Logger = newLogger): ChannelEventsHandler {
  return async (event) => ({ status: await processEmailEvent(event, depsFor(newLog())) });
}

function stageDeps(log: Logger): EmailEventsDeps {
  const data = connector();
  return { connector: data, queue: stageQueueSink(data), configurationSetName: configurationSetOf(currentStage()), logger: log };
}

export const handler: ChannelEventsHandler = createChannelEventsHandler(stageDeps);
