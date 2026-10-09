// Lambda entry point of the console BFF (Function URL behind the Router, payload format 2.0).
// infra/bff.ts points at `packages/bff/src/routers/handler.handler`.
//
// The deployed handler runs the edge (routers/edge.ts) before anything else: a request that did not
// come through CloudFront gets `403` without a body and a `signup.` procedure outside its one shape
// gets `400`, both before tRPC parses the path, the query or the body. Only then is the viewer's IP
// read, and it travels in the tRPC context (`edge`), never in the input. A handler built without an
// edge guard (the in-process routers of the tests and of the local servers) has no viewer at all, so
// `signup.start` answers UNAVAILABLE there.
//
// The one other event is the QaDriver's direct invocation of the QA seam (`QA_SIGNUP_START`,
// routers/qa-seam.ts): never a request of the Function URL, which always carries `requestContext`.
import type { AnyTRPCRouter } from "@trpc/server";
import { awsLambdaRequestHandler } from "@trpc/server/adapters/aws-lambda";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2, Context as LambdaContext } from "aws-lambda";
import { describeError } from "../auth/errors";
import { createLogger } from "../lib/log";
import { stripApiPrefix } from "./api-path";
import { type EdgeGuardDeps, guardEdge, linkedEdgeGuard } from "./edge";
import { defaultDeps } from "./deps";
import { appRouter } from "./index";
import { type QaSeamAnswer, type QaSignupStartRequest, handleQaSeam, isQaSeamEvent } from "./qa-seam";
import { type Context, type CreateContextOptions, type EdgeContext, createCallerFactory, createContext, createQaPublicContext } from "./trpc";

// Failures that are the caller's doing are logged where they are refused (routers/trpc.ts).
const EXPECTED = new Set(["UNAUTHORIZED", "FORBIDDEN", "BAD_REQUEST", "NOT_FOUND", "CONFLICT", "PRECONDITION_FAILED", "TOO_MANY_REQUESTS"]);

export type BffHandler = (event: APIGatewayProxyEventV2, context: LambdaContext) => Promise<APIGatewayProxyStructuredResultV2>;

export interface HandlerOptions {
  /** The origin check and the sign-up shape; the deployed handler always has it. */
  readonly edge?: EdgeGuardDeps;
}

export function createHandler(router: AnyTRPCRouter, contextOf: (options: CreateContextOptions) => Promise<Context>, options: HandlerOptions = {}): BffHandler {
  // The viewer of each request, by the event object tRPC hands back to `createContext`.
  const viewers = new WeakMap<APIGatewayProxyEventV2, EdgeContext>();
  const trpcHandler = awsLambdaRequestHandler<AnyTRPCRouter, APIGatewayProxyEventV2>({
    router,
    createContext: ({ event }) => {
      const edge = viewers.get(event);
      return contextOf(edge === undefined ? { event } : { event, edge });
    },
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
  return async (event, context) => {
    let passed = event;
    let edge: EdgeContext | undefined;
    if (options.edge !== undefined) {
      const verdict = guardEdge(event, options.edge);
      if (verdict.kind === "REJECT") return verdict.response;
      passed = verdict.event;
      edge = verdict.edge;
    }
    const routed = stripApiPrefix(passed);
    if (edge !== undefined) viewers.set(routed, edge);
    return trpcHandler(routed, context);
  };
}

const http: BffHandler = createHandler(appRouter, createContext, { edge: linkedEdgeGuard() });
const createAppCaller = createCallerFactory(appRouter);

/** `signup.start` of the real `appRouter` with the run's context (its counters under `SIGNUP#qa-<runId>#…`). */
function qaSignupStart(request: QaSignupStartRequest) {
  return createAppCaller(createQaPublicContext({ runId: request.runId, correlationId: request.correlationId }, defaultDeps())).signup.start(request.form);
}

export function handler(event: APIGatewayProxyEventV2, context: LambdaContext): Promise<APIGatewayProxyStructuredResultV2>;
export function handler(event: unknown, context: LambdaContext): Promise<APIGatewayProxyStructuredResultV2 | QaSeamAnswer>;
export async function handler(event: unknown, context: LambdaContext): Promise<APIGatewayProxyStructuredResultV2 | QaSeamAnswer> {
  if (isQaSeamEvent(event)) return handleQaSeam(event, qaSignupStart);
  return http(event as APIGatewayProxyEventV2, context);
}
