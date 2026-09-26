// AWS SDK v3 client settings with explicit timeouts and retry budgets for every AWS service the
// Lambdas call (CLAUDE.md: "toda llamada externa con timeout y reintento con backoff"). Each service
// client module builds its client with `new XClient(awsClientConfig(CLIENT_TIMEOUTS.x))`, so the
// deadline of each call lives here, below the timeout of the Lambda that makes it. Service modules
// add their own error mapping and, where the domain needs it, retries with `lib/retry.ts`.
//
// Only DynamoDB is instantiated here (the connector's DocumentClient): importing every SDK client
// from one module would put all of them in every bundle.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { NodeHttpHandler } from "@smithy/node-http-handler";

export interface ClientTimeouts {
  /** Milliseconds to wait for the whole response before the SDK gives up on one attempt. */
  readonly requestTimeoutMs: number;
  /** Milliseconds to establish the TCP connection. */
  readonly connectionTimeoutMs: number;
  /** SDK attempts including the first one (the SDK retries throttling and transient errors). */
  readonly maxAttempts: number;
}

const CONNECT_MS = 1_000;

/**
 * Per service. DynamoDB answers in milliseconds (anything past 2 s is an outage). The Harness turn
 * is bounded by its own `timeoutSeconds` 90 and the worker's time budget decides any retry, so the
 * SDK never retries it; the photo validator (`Converse`) gets 30 s and 2 retries
 * (docs/architecture.md §9.6); `CertificateWriter` runs up to 30 s.
 */
export const CLIENT_TIMEOUTS = {
  dynamodb: { requestTimeoutMs: 2_000, connectionTimeoutMs: CONNECT_MS, maxAttempts: 3 },
  harness: { requestTimeoutMs: 95_000, connectionTimeoutMs: CONNECT_MS, maxAttempts: 1 },
  converse: { requestTimeoutMs: 30_000, connectionTimeoutMs: CONNECT_MS, maxAttempts: 3 },
  guardrail: { requestTimeoutMs: 5_000, connectionTimeoutMs: CONNECT_MS, maxAttempts: 3 },
  knowledgeBase: { requestTimeoutMs: 8_000, connectionTimeoutMs: CONNECT_MS, maxAttempts: 3 },
  memory: { requestTimeoutMs: 10_000, connectionTimeoutMs: CONNECT_MS, maxAttempts: 3 },
  transcribe: { requestTimeoutMs: 5_000, connectionTimeoutMs: CONNECT_MS, maxAttempts: 3 },
  ses: { requestTimeoutMs: 5_000, connectionTimeoutMs: CONNECT_MS, maxAttempts: 3 },
  socialMessaging: { requestTimeoutMs: 8_000, connectionTimeoutMs: CONNECT_MS, maxAttempts: 3 },
  s3: { requestTimeoutMs: 10_000, connectionTimeoutMs: CONNECT_MS, maxAttempts: 3 },
  scheduler: { requestTimeoutMs: 5_000, connectionTimeoutMs: CONNECT_MS, maxAttempts: 3 },
  sqs: { requestTimeoutMs: 5_000, connectionTimeoutMs: CONNECT_MS, maxAttempts: 3 },
  sns: { requestTimeoutMs: 5_000, connectionTimeoutMs: CONNECT_MS, maxAttempts: 3 },
  eventBridge: { requestTimeoutMs: 5_000, connectionTimeoutMs: CONNECT_MS, maxAttempts: 3 },
  lambda: { requestTimeoutMs: 35_000, connectionTimeoutMs: CONNECT_MS, maxAttempts: 2 },
  cognito: { requestTimeoutMs: 5_000, connectionTimeoutMs: CONNECT_MS, maxAttempts: 3 },
  cloudwatch: { requestTimeoutMs: 5_000, connectionTimeoutMs: CONNECT_MS, maxAttempts: 3 },
} as const satisfies Record<string, ClientTimeouts>;

export type ClientName = keyof typeof CLIENT_TIMEOUTS;

/** Kept for existing callers: the DynamoDB budget. */
export const DYNAMO_TIMEOUTS: ClientTimeouts = CLIENT_TIMEOUTS.dynamodb;

export function awsClientConfig(timeouts: ClientTimeouts) {
  return {
    maxAttempts: timeouts.maxAttempts,
    requestHandler: new NodeHttpHandler({
      requestTimeout: timeouts.requestTimeoutMs,
      connectionTimeout: timeouts.connectionTimeoutMs,
    }),
  };
}

let documentClient: DynamoDBDocumentClient | undefined;

export function createDocumentClient(timeouts: ClientTimeouts = CLIENT_TIMEOUTS.dynamodb): DynamoDBDocumentClient {
  const base = new DynamoDBClient(awsClientConfig(timeouts));
  return DynamoDBDocumentClient.from(base, {
    // Optional entity fields are `undefined` in TypeScript and simply absent in DynamoDB.
    marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: false },
    unmarshallOptions: { wrapNumbers: false },
  });
}

/** Process-wide DocumentClient, reused across Lambda invocations of the same container. */
export function dynamoDocumentClient(): DynamoDBDocumentClient {
  documentClient ??= createDocumentClient();
  return documentClient;
}
