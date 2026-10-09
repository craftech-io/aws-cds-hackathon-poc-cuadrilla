/// <reference path="../../sst-env.d.ts" />
// The AWS adapters of the `QaDriver`'s ports in the stage, each over what its role holds
// (infra/iam-capabilities.ts row `QaDriver`, infra/qa-driver-fence.ts, infra/leads-spec.ts QA_SEAM_GRANTS):
// Lambda invokes of the targets, `PolicyAudit`, `GuestAccountDeletion`; the simulator's media in `Media`;
// AgentCore Memory reads; the DLQ; the alarm history; the foreign event on the app's own topic; the two web
// ACLs (signed JSON calls: the SDK of WAFv2 is not a dependency of the app); the pool's clients and JWKS;
// and the QA seam's Cognito calls. Names and ids come from links (`Resource`, never `process.env`).
import { CloudWatchClient, DescribeAlarmHistoryCommand } from "@aws-sdk/client-cloudwatch";
import { AdminConfirmSignUpCommand, AdminGetUserCommand, AdminInitiateAuthCommand, CognitoIdentityProviderClient, DescribeUserPoolClientCommand, SignUpCommand, UserNotFoundException } from "@aws-sdk/client-cognito-identity-provider";
import { BedrockAgentCoreClient, ListEventsCommand, ListMemoryRecordsCommand, ListSessionsCommand, ResourceNotFoundException } from "@aws-sdk/client-bedrock-agentcore";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { Sha256 } from "@aws-crypto/sha256-js";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { SignatureV4 } from "@smithy/signature-v4";
import { Resource } from "sst";
import { z } from "zod";
import { ToolError } from "@cuadrilla/shared";
import { CLIENT_TIMEOUTS, awsClientConfig } from "../lib/clients";
import { bucketName, readLinked } from "../lib/resource";
import { secretValue } from "../lib/secrets";
import type { AlarmTransition, DlqMessage, DlqPort, MemoryEventView, MemoryReader, MemoryRecordView, ToolInvoker } from "./ports";
import type { SeamCognito, SeamUser } from "./signup-fence";

const REGION = "us-east-1";
const Named = z.object({ name: z.string().min(1) });
const QueueUrl = z.object({ url: z.string().url() });
export const QaTargetsLink = z.object({
  userPoolId: z.string().min(1),
  clients: z.object({ consoleWeb: z.string().min(1), guestSignup: z.string().min(1), qaProbe: z.string().min(1) }),
  webAcls: z.object({ edge: z.object({ name: z.string(), id: z.string(), scope: z.literal("CLOUDFRONT") }), auth: z.object({ name: z.string(), id: z.string(), scope: z.literal("REGIONAL") }) }),
});
export const qaTargets = () => readLinked("QaTargets", QaTargetsLink);

let lambda: LambdaClient | undefined;
/** Synchronous invoke of a linked function; its error answer is the action's failure. */
export async function invokeLinked(logicalName: string, payload: unknown): Promise<unknown> {
  lambda ??= new LambdaClient({ region: REGION, ...awsClientConfig({ ...CLIENT_TIMEOUTS.lambda, requestTimeoutMs: 300_000 }) });
  const output = await lambda.send(new InvokeCommand({ FunctionName: readLinked(logicalName, Named).name, InvocationType: "RequestResponse", Payload: new TextEncoder().encode(JSON.stringify(payload)) }));
  const text = output.Payload === undefined ? "null" : new TextDecoder().decode(output.Payload);
  if (output.FunctionError !== undefined) throw new ToolError("UNAVAILABLE", `${logicalName} failed (${output.FunctionError})`, "INVOKE_FAILED");
  return JSON.parse(text) as unknown;
}

export const lambdaTools: ToolInvoker = { invoke: (target, event) => invokeLinked(target, event) };

let s3: S3Client | undefined;
export async function putMediaObject(input: { readonly key: string; readonly bytes: Uint8Array; readonly contentType: string }): Promise<void> {
  s3 ??= new S3Client({ region: REGION, ...awsClientConfig(CLIENT_TIMEOUTS.s3) });
  await s3.send(new PutObjectCommand({ Bucket: bucketName("Media"), Key: input.key, Body: input.bytes, ContentType: input.contentType }));
}

// ---- AgentCore Memory (reads only) -----------------------------------------------------------------

const MemoryLink = z.object({ memoryId: z.string().min(1) });
let agentcore: BedrockAgentCoreClient | undefined;
const memoryClient = (): BedrockAgentCoreClient => (agentcore ??= new BedrockAgentCoreClient({ region: REGION, ...awsClientConfig(CLIENT_TIMEOUTS.memory) }));

async function pages<T>(fetch: (token: string | undefined) => Promise<{ items: T[]; next?: string | undefined }>): Promise<T[]> {
  const all: T[] = [];
  let token: string | undefined;
  do {
    const page = await fetch(token);
    all.push(...page.items);
    token = page.next;
  } while (token !== undefined && all.length < 2_000);
  return all;
}

async function missingIsEmpty<T>(read: () => Promise<T[]>): Promise<T[]> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof ResourceNotFoundException) return [];
    throw error;
  }
}

export const agentCoreMemoryReader: MemoryReader = {
  listRecords: (namespacePrefix) =>
    missingIsEmpty(() =>
      pages<MemoryRecordView>(async (nextToken) => {
        const out = await memoryClient().send(new ListMemoryRecordsCommand({ memoryId: readLinked("Memory", MemoryLink).memoryId, namespace: namespacePrefix, maxResults: 100, nextToken }));
        const items = (out.memoryRecordSummaries ?? []).map((record) => ({
          memoryRecordId: record.memoryRecordId ?? "",
          namespace: record.namespaces?.[0] ?? "",
          createdAt: record.createdAt?.toISOString() ?? "",
          text: record.content !== undefined && "text" in record.content ? (record.content.text ?? "") : "",
        }));
        return { items, next: out.nextToken };
      }),
    ),
  listSessions: (actorId) =>
    missingIsEmpty(() =>
      pages<string>(async (nextToken) => {
        const out = await memoryClient().send(new ListSessionsCommand({ memoryId: readLinked("Memory", MemoryLink).memoryId, actorId, maxResults: 100, nextToken }));
        return { items: (out.sessionSummaries ?? []).map((session) => session.sessionId ?? "").filter((id) => id !== ""), next: out.nextToken };
      }),
    ),
  listEvents: (actorId, sessionId) =>
    missingIsEmpty(() =>
      pages<MemoryEventView>(async (nextToken) => {
        const out = await memoryClient().send(new ListEventsCommand({ memoryId: readLinked("Memory", MemoryLink).memoryId, actorId, sessionId, includePayloads: true, maxResults: 100, nextToken }));
        const items = (out.events ?? []).map((event) => ({
          eventId: event.eventId ?? "",
          sessionId,
          timestamp: event.eventTimestamp?.toISOString() ?? "",
          texts: (event.payload ?? []).flatMap((part) => (part.conversational?.content !== undefined && "text" in part.conversational.content ? [part.conversational.content.text ?? ""] : [])),
        }));
        return { items, next: out.nextToken };
      }),
    ),
};

// ---- The DLQ and the alarm ---------------------------------------------------------------------------

let sqs: SQSClient | undefined;
const DlqBody = z.looseObject({ eventId: z.string().optional(), clockId: z.string().optional(), type: z.string().optional() });

export const sqsDlq: DlqPort = {
  async receive() {
    sqs ??= new SQSClient({ region: REGION, ...awsClientConfig(CLIENT_TIMEOUTS.sqs) });
    const found: DlqMessage[] = [];
    for (let round = 0; round < 5; round += 1) {
      const out = await sqs.send(new ReceiveMessageCommand({ QueueUrl: readLinked("InstallerEventsDlq", QueueUrl).url, MaxNumberOfMessages: 10, VisibilityTimeout: 10, WaitTimeSeconds: 1 }));
      const messages = out.Messages ?? [];
      for (const message of messages) {
        let body: z.infer<typeof DlqBody> = {};
        try {
          body = DlqBody.parse(JSON.parse(message.Body ?? "{}"));
        } catch {
          body = {};
        }
        if (body.eventId !== undefined && message.ReceiptHandle !== undefined) found.push({ eventId: body.eventId, receiptHandle: message.ReceiptHandle, ...(body.clockId === undefined ? {} : { clockId: body.clockId }), ...(body.type === undefined ? {} : { type: body.type }) });
      }
      if (messages.length === 0) break;
    }
    return found;
  },
  async remove(receiptHandle) {
    sqs ??= new SQSClient({ region: REGION, ...awsClientConfig(CLIENT_TIMEOUTS.sqs) });
    await sqs.send(new DeleteMessageCommand({ QueueUrl: readLinked("InstallerEventsDlq", QueueUrl).url, ReceiptHandle: receiptHandle }));
  },
};

let cloudwatch: CloudWatchClient | undefined;
/** The DLQ's alarm, if the stage has one (`<app>-<stage>-InstallerEventsDlq`, inside the role's fence). */
export async function dlqAlarmHistory(sinceReal: string): Promise<AlarmTransition[]> {
  cloudwatch ??= new CloudWatchClient({ region: REGION, ...awsClientConfig(CLIENT_TIMEOUTS.cloudwatch) });
  const alarmName = `${Resource.App.name}-${Resource.App.stage}-InstallerEventsDlq`;
  const out = await cloudwatch.send(new DescribeAlarmHistoryCommand({ AlarmName: alarmName, StartDate: new Date(sinceReal), HistoryItemType: "StateUpdate", MaxRecords: 50 }));
  return (out.AlarmHistoryItems ?? []).map((item) => ({ alarmName: item.AlarmName ?? alarmName, timestamp: item.Timestamp?.toISOString() ?? "", summary: item.HistorySummary ?? "" }));
}

// ---- The foreign event (FL-095) -----------------------------------------------------------------------

let sns: SNSClient | undefined;
const TopicLink = z.object({ arn: z.string().min(1) });
/** A Meta number id that is never ours: digits derived from the event id, refused if it ever equals ours. */
function foreignMetaId(eventId: string): string {
  const digits = eventId.replace(/[^0-9]/g, "").padEnd(15, "7").slice(0, 15);
  const ours = (() => {
    try {
      return secretValue("WhatsAppMetaPhoneNumberId");
    } catch {
      return "";
    }
  })();
  if (digits === ours) throw new ToolError("INVALID", "the foreign event would carry our own number", "OWN_NUMBER");
  return digits;
}

export async function publishForeign(input: { readonly eventId: string; readonly sentAtReal: Date }): Promise<{ readonly snsMessageId: string }> {
  sns ??= new SNSClient({ region: REGION, ...awsClientConfig(CLIENT_TIMEOUTS.sns) });
  const metaId = foreignMetaId(input.eventId);
  const timestamp = input.sentAtReal.toISOString();
  const entry = { id: "qa-foreign-waba", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "15550000000", phone_number_id: metaId }, messages: [{ from: "5215500000000", id: `wamid.QA.${input.eventId}`, timestamp: String(Math.floor(input.sentAtReal.getTime() / 1000)), type: "text", text: { body: "qa" } }] } }] };
  const message = JSON.stringify({
    context: { MetaWabaIds: [{ wabaId: "qa-foreign-waba", arn: `arn:aws:social-messaging:${REGION}:000000000000:waba/qa-foreign` }], MetaPhoneNumberIds: [{ metaPhoneNumberId: metaId, arn: `arn:aws:social-messaging:${REGION}:000000000000:phone-number-id/qa-foreign` }] },
    whatsAppWebhookEntry: JSON.stringify(entry),
    aws_account_id: "000000000000",
    message_timestamp: timestamp,
    messageId: input.eventId,
  });
  const out = await sns.send(new PublishCommand({ TopicArn: readLinked("WaInbound", TopicLink).arn, Message: message, MessageAttributes: { "qa-foreign": { DataType: "String", StringValue: "1" } } }));
  if (out.MessageId === undefined) throw new ToolError("UNAVAILABLE", "SNS returned no message id");
  return { snsMessageId: out.MessageId };
}

// ---- WAFv2, signed (no SDK of WAFv2 in the app) ----------------------------------------------------------

async function wafv2(target: "GetWebACL" | "GetWebACLForResource", body: Record<string, unknown>): Promise<unknown> {
  const host = `wafv2.${REGION}.amazonaws.com`;
  const signer = new SignatureV4({ service: "wafv2", region: REGION, credentials: defaultProvider(), sha256: Sha256 });
  const payload = JSON.stringify(body);
  const signed = await signer.sign({ method: "POST", protocol: "https:", hostname: host, path: "/", query: {}, headers: { host, "content-type": "application/x-amz-json-1.1", "x-amz-target": `AWSWAF_20190729.${target}` }, body: payload });
  const { host: _host, ...headers } = signed.headers;
  const response = await fetch(`https://${host}/`, { method: "POST", headers, body: payload, signal: AbortSignal.timeout(10_000) });
  const text = await response.text();
  if (!response.ok) throw new ToolError("UNAVAILABLE", `wafv2 ${target} answered ${response.status}`, "WAF_PROBE");
  return JSON.parse(text) as unknown;
}

export async function webAcls(): Promise<unknown> {
  const targets = qaTargets();
  const userPoolArn = `arn:aws:cognito-idp:${REGION}:${await accountId()}:userpool/${targets.userPoolId}`;
  const [edge, auth, poolAssociation] = await Promise.all([
    wafv2("GetWebACL", { Name: targets.webAcls.edge.name, Id: targets.webAcls.edge.id, Scope: "CLOUDFRONT" }),
    wafv2("GetWebACL", { Name: targets.webAcls.auth.name, Id: targets.webAcls.auth.id, Scope: "REGIONAL" }),
    wafv2("GetWebACLForResource", { ResourceArn: userPoolArn }),
  ]);
  return { edge, auth, poolAssociation };
}

async function accountId(): Promise<string> {
  const match = /^arn:aws:sns:[a-z0-9-]+:(\d{12}):/.exec(readLinked("WaInbound", TopicLink).arn);
  if (match?.[1] === undefined) throw new ToolError("UNAVAILABLE", "the account of the stage is unknown");
  return match[1];
}

// ---- Cognito: the pool's configuration and the QA seam ----------------------------------------------

let cognito: CognitoIdentityProviderClient | undefined;
const cognitoClient = (): CognitoIdentityProviderClient => (cognito ??= new CognitoIdentityProviderClient({ region: REGION, ...awsClientConfig(CLIENT_TIMEOUTS.cognito) }));

export async function authConfiguration(): Promise<unknown> {
  const targets = qaTargets();
  const describe = async (clientId: string) => {
    const out = await cognitoClient().send(new DescribeUserPoolClientCommand({ UserPoolId: targets.userPoolId, ClientId: clientId }));
    const client = out.UserPoolClient;
    return {
      explicitAuthFlows: client?.ExplicitAuthFlows ?? [],
      idTokenValidity: client?.IdTokenValidity ?? null,
      accessTokenValidity: client?.AccessTokenValidity ?? null,
      tokenValidityUnits: client?.TokenValidityUnits ?? null,
      allowedOAuthFlowsUserPoolClient: client?.AllowedOAuthFlowsUserPoolClient ?? false,
      callbackUrls: client?.CallbackURLs ?? [],
      writeAttributes: client?.WriteAttributes ?? [],
      readAttributes: client?.ReadAttributes ?? [],
      generateSecret: client?.ClientSecret !== undefined,
    };
  };
  const jwks = await fetch(`https://cognito-idp.${REGION}.amazonaws.com/${targets.userPoolId}/.well-known/jwks.json`, { signal: AbortSignal.timeout(10_000) });
  const keys = jwks.ok ? ((await jwks.json()) as { keys?: unknown[] }).keys?.length ?? 0 : 0;
  return { clients: { ConsoleWeb: await describe(targets.clients.consoleWeb), GuestSignup: await describe(targets.clients.guestSignup), QaProbe: await describe(targets.clients.qaProbe) }, jwks: { status: jwks.status, keys } };
}

export const cognitoSeam: SeamCognito = {
  async getUser(username): Promise<SeamUser | undefined> {
    try {
      const out = await cognitoClient().send(new AdminGetUserCommand({ UserPoolId: qaTargets().userPoolId, Username: username }));
      const attribute = (name: string) => out.UserAttributes?.find((entry) => entry.Name === name)?.Value;
      const email = attribute("email");
      const sub = attribute("sub");
      return { username, status: out.UserStatus ?? "UNKNOWN", emailVerified: attribute("email_verified") === "true", ...(email === undefined ? {} : { email }), ...(sub === undefined ? {} : { sub }) };
    } catch (error) {
      if (error instanceof UserNotFoundException) return undefined;
      throw error;
    }
  },
  async confirm(username) {
    await cognitoClient().send(new AdminConfirmSignUpCommand({ UserPoolId: qaTargets().userPoolId, Username: username }));
  },
  async adminSignIn(username, password) {
    const targets = qaTargets();
    const out = await cognitoClient().send(new AdminInitiateAuthCommand({ UserPoolId: targets.userPoolId, ClientId: targets.clients.qaProbe, AuthFlow: "ADMIN_USER_PASSWORD_AUTH", AuthParameters: { USERNAME: username, PASSWORD: password } }));
    const idToken = out.AuthenticationResult?.IdToken;
    if (idToken === undefined) throw new ToolError("UNAVAILABLE", "the sign-in returned no id token (a challenge?)", "QA_SIGN_IN");
    return { idToken };
  },
  async signUp(input) {
    await cognitoClient().send(
      new SignUpCommand({
        ClientId: qaTargets().clients.guestSignup,
        Username: input.username,
        Password: input.password,
        UserAttributes: [
          { Name: "email", Value: input.email },
          { Name: "locale", Value: input.locale },
          { Name: "name", Value: input.name },
        ],
        ...(input.ticket === undefined ? {} : { ClientMetadata: { signupTicket: input.ticket } }),
      }),
    );
  },
};
