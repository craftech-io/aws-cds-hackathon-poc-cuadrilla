// Lambda entry of `DispatchMock` (Function URL, AWS_IAM; invoked by `Bff` and `QaDriver` only, by
// resource policy). It wires the router to the `Dispatch` table and the `Feeds` bus and nothing else.
import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from "aws-lambda";
import { createDispatchApi, type DispatchApi } from "./api";
import { fromFunctionUrlEvent, toFunctionUrlResult } from "./http";
import { createEventBridgeClient, eventBridgePublisher } from "./publisher";
import { linkedName } from "./resources";
import { createDispatchDocumentClient, dynamoDispatchStore } from "./store-dynamo";

let api: DispatchApi | undefined;

function dispatchApi(): DispatchApi {
  api ??= createDispatchApi({
    store: dynamoDispatchStore(createDispatchDocumentClient(), linkedName("Dispatch")),
    publisher: eventBridgePublisher(createEventBridgeClient(), linkedName("Feeds")),
    // Real time, only for `createdAt`/`updatedAt` and log durations: event times come from the caller's world clock.
    now: () => new Date(),
  });
  return api;
}

export async function handler(event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  return toFunctionUrlResult(await dispatchApi().handle(fromFunctionUrlEvent(event)));
}
