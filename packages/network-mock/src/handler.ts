// Lambda entry of `NetworkMock` (Function URL, AWS_IAM): adapts the Function URL event to
// `handleNetworkRequest` and writes one JSON log line per request with the caller's correlation id,
// the world, the route and the end of the serial only (the mock holds no personal data, and logs
// never carry a full serial or a header value that was not validated).
import { MOCK_HEADERS, WORLD_HEADER } from "@cuadrilla/network-contract";
import { ClockId } from "@cuadrilla/shared";
import type { APIGatewayProxyStructuredResultV2, LambdaFunctionURLEvent } from "aws-lambda";
import { networkTableStore } from "./dynamo-store";
import { handleNetworkRequest, type MockDeps, type MockRequest, type MockResponse } from "./routes";

export function toMockRequest(event: LambdaFunctionURLEvent): MockRequest {
  const body = event.body === undefined ? undefined : event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  return {
    method: event.requestContext.http.method,
    path: event.rawPath,
    headers: event.headers,
    ...(body === undefined ? {} : { body }),
  };
}

/** Function URLs answer with the API Gateway v2 structured result. */
export type FunctionUrlResult = APIGatewayProxyStructuredResultV2;

export function toFunctionUrlResult(response: MockResponse): FunctionUrlResult {
  return { statusCode: response.status, headers: { ...response.headers }, body: response.body };
}

// Same shape the BFF logger accepts from a caller; anything else falls back to the Lambda request id.
const CORRELATION = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

function headerOf(request: MockRequest, name: string): string | undefined {
  return Object.entries(request.headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

function logContext(request: MockRequest, requestId: string): Record<string, string> {
  const correlation = headerOf(request, MOCK_HEADERS.correlation);
  const world = ClockId.safeParse(headerOf(request, WORLD_HEADER));
  const serialTail = /^\/v1\/onus\/([A-Z0-9]{8,16})(?:\/|$)/.exec(request.path)?.[1]?.slice(-4);
  return {
    correlationId: correlation !== undefined && CORRELATION.test(correlation) ? correlation : requestId,
    method: request.method,
    route: request.path.replace(/^\/v1\/onus\/[^/]+/, "/v1/onus/{serial}").slice(0, 80),
    ...(world.success ? { clockId: world.data } : {}),
    ...(serialTail === undefined ? {} : { serialTail }),
  };
}

export function createHandler(deps: () => MockDeps, write: (line: string) => void = (line) => process.stdout.write(`${line}\n`)) {
  return async (event: LambdaFunctionURLEvent): Promise<FunctionUrlResult> => {
    const request = toMockRequest(event);
    const context = deps();
    const startedAt = context.now();
    const fields = logContext(request, event.requestContext.requestId);
    let response: MockResponse;
    try {
      response = await handleNetworkRequest(request, context);
    } catch (error) {
      write(JSON.stringify({ level: "error", time: context.now().toISOString(), message: "network mock failure", ...fields, errorName: error instanceof Error ? error.name : "unknown" }));
      response = { status: 500, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "internal error" }) };
    }
    const finishedAt = context.now();
    const level = response.status >= 500 ? "warn" : "info";
    write(JSON.stringify({ level, time: finishedAt.toISOString(), message: "network mock request", ...fields, status: response.status, durationMs: finishedAt.getTime() - startedAt.getTime() }));
    return toFunctionUrlResult(response);
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Real time here is the mock's own edge: record metadata and reads that do not carry the world's time. */
export const handler = createHandler(() => ({ store: networkTableStore(), now: () => new Date(), sleep }));
