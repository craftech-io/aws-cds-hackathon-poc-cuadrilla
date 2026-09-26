// Lambda Function URL (payload format 2.0) to and from the router's plain request and response.
import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from "aws-lambda";
import type { HttpRequest, HttpResponse } from "./api";

export function fromFunctionUrlEvent(event: LambdaFunctionURLEvent): HttpRequest {
  const query: Record<string, string | undefined> = { ...event.queryStringParameters };
  const body = event.body === undefined ? undefined : event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  return {
    method: event.requestContext.http.method,
    path: event.rawPath,
    query,
    ...(body === undefined ? {} : { body }),
    requestId: event.requestContext.requestId,
  };
}

export function toFunctionUrlResult(response: HttpResponse): LambdaFunctionURLResult {
  return { statusCode: response.statusCode, headers: { ...response.headers }, body: response.body, isBase64Encoded: false };
}
