/// <reference path="../../sst-env.d.ts" />
// `LeadStream` (ADR-0026, infra/leads.ts): the stream of `Leads` through its two event filters (a
// pending lead turning `CONFIRMED`, a lead removed by TTL) and, once a day, `{kind: "UNCONFIRMED_SWEEP"}`
// from its schedule. The logic lives in leads/stream.ts; this entry only wires the linked resources:
// `Leads`, `LeadNotifyChannel` + `LeadConfig` (the notice), `Auth` (the pool of the Cognito calls) and
// `GuestAccountDeletion` (invoked asynchronously for an expired confirmed lead).
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { z } from "zod";
import { type CognitoUsers, createCognitoUsers } from "../leads/cognito-users";
import { leadConfig, leadNotifyChannel } from "../leads/config";
import { DeletionRequest, type DeletionRequestInput } from "../leads/deletion";
import { dynamoLeadStore } from "../leads/dynamo-table";
import { type LeadStreamDeps, type StreamSummary, handleLeadRecords, sweepUnconfirmed } from "../leads/stream";
import { StreamEvent, SweepEvent } from "../leads/stream-records";
import { CLIENT_TIMEOUTS, awsClientConfig } from "../lib/clients";
import { type Logger, createLogger } from "../lib/log";
import { currentStage, readLinked } from "../lib/resource";
import { withRetry } from "../lib/retry";

const LinkedFunction = z.object({ name: z.string().min(1) });

let ses: SESv2Client | undefined;
let lambda: LambdaClient | undefined;
let cognito: CognitoUsers | undefined;

/** `Event` invocation: the deletion runs on its own budget, and Lambda retries it twice on failure. */
export function asyncDeletionInvoker(client: Pick<LambdaClient, "send">, functionName: () => string): (request: DeletionRequestInput) => Promise<void> {
  return async (request) => {
    const payload = JSON.stringify(DeletionRequest.parse(request));
    await withRetry(() => client.send(new InvokeCommand({ FunctionName: functionName(), InvocationType: "Event", Payload: new TextEncoder().encode(payload) })), {
      shouldRetry: (error) => error instanceof Error && /Throttl|TooManyRequests|ServiceException|Timeout/.test(error.name),
    });
  };
}

export function defaultLeadStreamDeps(log: Logger): LeadStreamDeps {
  ses ??= new SESv2Client(awsClientConfig(CLIENT_TIMEOUTS.ses));
  lambda ??= new LambdaClient(awsClientConfig(CLIENT_TIMEOUTS.lambda));
  cognito ??= createCognitoUsers();
  return {
    store: dynamoLeadStore(),
    ses,
    channel: leadNotifyChannel,
    config: () => leadConfig(),
    now: () => new Date(),
    stage: currentStage(),
    log,
    cognito,
    invokeDeletion: asyncDeletionInvoker(lambda, () => readLinked("GuestAccountDeletion", LinkedFunction).name),
  };
}

export type LeadStreamResult = StreamSummary | { readonly swept: number };

/** One stream batch or the daily sweep; anything else is refused. */
export async function handleLeadStream(event: unknown, deps: LeadStreamDeps): Promise<LeadStreamResult> {
  const sweep = SweepEvent.safeParse(event);
  if (sweep.success) return { swept: await sweepUnconfirmed(deps) };
  const stream = StreamEvent.safeParse(event);
  if (!stream.success) throw new RangeError("LeadStream accepts only stream records of Leads or its daily sweep");
  return handleLeadRecords(deps, stream.data.Records);
}

export async function handler(event: unknown): Promise<LeadStreamResult> {
  const log = createLogger({ bindings: { component: "lead-stream" } });
  return handleLeadStream(event, defaultLeadStreamDeps(log));
}
