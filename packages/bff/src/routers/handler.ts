// Lambda entry point of the console BFF (Function URL behind the Router, payload format 2.0).
// infra/bff.ts points at `packages/bff/src/routers/handler.handler`.
import type { AnyTRPCRouter } from "@trpc/server";
import { awsLambdaRequestHandler } from "@trpc/server/adapters/aws-lambda";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2, Context as LambdaContext } from "aws-lambda";
import { describeError } from "../auth/errors";
import { createLogger } from "../lib/log";
import { stripApiPrefix } from "./api-path";
import { appRouter } from "./index";
import { type Context, type CreateContextOptions, createContext } from "./trpc";

// Failures that are the caller's doing are logged where they are refused (routers/trpc.ts).
const EXPECTED = new Set(["UNAUTHORIZED", "FORBIDDEN", "BAD_REQUEST", "NOT_FOUND", "CONFLICT", "PRECONDITION_FAILED"]);

export type BffHandler = (event: APIGatewayProxyEventV2, context: LambdaContext) => Promise<APIGatewayProxyStructuredResultV2>;

export function createHandler(router: AnyTRPCRouter, contextOf: (options: CreateContextOptions) => Promise<Context>): BffHandler {
  const trpcHandler = awsLambdaRequestHandler<AnyTRPCRouter, APIGatewayProxyEventV2>({
    router,
    createContext: ({ event }) => contextOf({ event }),
    // Responses carry data of one operator: neither CloudFront nor the browser may keep them.
    responseMeta: () => ({ headers: { "cache-control": "no-store" } }),
    onError({ error, path, ctx }) {
      if (EXPECTED.has(error.code)) return;
      // The input is never logged: it may carry names, contacts or free text of a party.
      // Untyped for a generic router; it is whatever `contextOf` returned, or nothing if that failed.
      const context: Context | undefined = ctx;
      const log = context?.log ?? createLogger({ bindings: { service: "bff" } });
      log.error("console.procedure.failed", { path: path ?? "unknown", code: error.code, ...describeError(error.cause ?? error) });
    },
  });
  return (event, context) => trpcHandler(stripApiPrefix(event), context);
}

export const handler: BffHandler = createHandler(appRouter, createContext);
