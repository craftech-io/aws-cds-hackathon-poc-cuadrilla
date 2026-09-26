// The only place that instantiates the DynamoDB adapter (docs/build-plan.md §1). Lambdas call
// `connector()`; tests and local flows call `createMemoryConnector()`. Nothing outside connector/
// imports @aws-sdk/lib-dynamodb.
import { dynamoDocumentClient } from "../lib/clients";
import { createConnector } from "./dynamo/connector";
import { DynamoTableClient } from "./dynamo/client";
import { createRepoContext } from "./dynamo/repo";
import type { Connector } from "./ports";

export type * from "./ports";
export { createMemoryConnector, type MemoryConnector, type MemoryConnectorOptions } from "./memory/index";
export { defaultWorldPolicy, type WorldPolicy, type WorldStamp } from "./world";
export { COUNTER_KEYS, dayKey, foreignProbeId, hourKey, parseTimerRefKey, timerRefKey } from "./keys";

let instance: Connector | undefined;

/** Connector over DynamoDB, one per Lambda container (tables resolved through the SST link). */
export function connector(): Connector {
  instance ??= createConnector(createRepoContext(new DynamoTableClient(dynamoDocumentClient())));
  return instance;
}

/** Test seam: forget the process-wide connector. */
export function resetConnector(): void {
  instance = undefined;
}
