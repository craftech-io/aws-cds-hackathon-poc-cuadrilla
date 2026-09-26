// tRPC v11 foundation of the console BFF: request context, principal and the procedure builders
// every feature router starts from (docs/architecture.md §10).
//
//   publicProcedure       no principal required (only the health probe)
//   ispProcedure          verified id token with operator and role; an inactive user is refused
//   supervisorProcedure   operator + role SUPERVISOR or JUDGE (a judge acts as supervisor in its own world)
//   recentLoginProcedure  supervisor + interactive sign-in at most 15 minutes old (manual validation)
//
// `ispId` and `role` come from the token, never from the input. WP-13 adds the cross-operator fence
// (every id of the input checked against the operator: 403 plus `AuditLog DENY CROSS_ISP`) once the
// connector exists (WP-07).
import { TRPCError, initTRPC } from "@trpc/server";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { z } from "zod";
import type { ConsoleRole } from "@cuadrilla/shared";
import { AUTH_REASON, AUTH_REFUSAL, AuthError, type AuthRefusal, describeError } from "../auth/errors";
import { bearerToken } from "../auth/jwt";
import { type Principal, isSignInFresh, principalFromClaims } from "../auth/principal";
import { type Logger, correlationIdFrom } from "../lib/log";
import { type ContextDeps, defaultDeps } from "./deps";
import { reasonOf, toTrpcError } from "./errors";

export interface Context {
  readonly correlationId: string;
  /** `null` when the request carries no acceptable token; `authFailure` says why. */
  readonly principal: Principal | null;
  readonly authFailure: AuthError | null;
  readonly deps: ContextDeps;
  readonly log: Logger;
}

export interface IspContext extends Context {
  readonly principal: Principal;
  readonly authFailure: null;
}

export interface CreateContextOptions {
  readonly event: Pick<APIGatewayProxyEventV2, "headers"> & { readonly requestContext?: { readonly requestId?: string } };
}

const CORRELATION_HEADER = "x-correlation-id";

function header(headers: APIGatewayProxyEventV2["headers"], name: string): string | undefined {
  const entry = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name);
  return entry?.[1];
}

// The id the console sent, else the Function URL request id, else a fresh one.
function correlationIdOf(event: CreateContextOptions["event"]): string {
  return correlationIdFrom(header(event.headers, CORRELATION_HEADER) ?? event.requestContext?.requestId);
}

/**
 * Builds `createContext` over explicit dependencies (tests, the QA driver). It never throws for a
 * bad token: the failure is kept in the context and `ispProcedure` turns it into the right HTTP
 * status, so public procedures keep working.
 */
export function createContextFactory(resolveDeps: () => ContextDeps) {
  return async ({ event }: CreateContextOptions): Promise<Context> => {
    const deps = resolveDeps();
    const correlationId = correlationIdOf(event);
    const log = deps.loggerFor(correlationId);
    try {
      const claims = await deps.verifier.verify(bearerToken(header(event.headers, "authorization")));
      return { correlationId, principal: principalFromClaims(claims), authFailure: null, deps, log };
    } catch (error) {
      const authFailure =
        error instanceof AuthError ? error : new AuthError(AUTH_REASON.AUTH_UNAVAILABLE, "authentication failed unexpectedly", { cause: error });
      return { correlationId, principal: null, authFailure, deps, log };
    }
  };
}

/** `createContext(event)` → `{ principal }` over the linked resources of the BFF Lambda. */
export const createContext = createContextFactory(defaultDeps);

const t = initTRPC.context<Context>().create({
  // Stack traces never travel to the browser, whatever NODE_ENV says inside the Lambda.
  isDev: false,
  errorFormatter({ shape, error, ctx }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        reason: error.cause instanceof AuthError ? error.cause.reason : reasonOf(error.cause),
        correlationId: ctx?.correlationId ?? null,
        zodError: error.cause instanceof z.ZodError ? z.flattenError(error.cause) : null,
      },
    };
  },
});

export const router = t.router;
export const mergeRouters = t.mergeRouters;
export const createCallerFactory = t.createCallerFactory;

// Procedures throw the domain's typed errors (ToolError, ConnectorError); here they become the HTTP
// answer their code stands for instead of a 500 (errors.ts).
const domainErrors = t.middleware(async ({ next }) => {
  const result = await next();
  if (!result.ok) {
    const mapped = toTrpcError(result.error.cause);
    if (mapped) throw mapped;
  }
  return result;
});

const baseProcedure = t.procedure.use(domainErrors);

export const publicProcedure = baseProcedure;

const TRPC_CODE: Readonly<Record<AuthRefusal, TRPCError["code"]>> = { UNAUTHENTICATED: "UNAUTHORIZED", FORBIDDEN: "FORBIDDEN", UNAVAILABLE: "SERVICE_UNAVAILABLE" };

function refuse(log: Logger, path: string, error: AuthError): never {
  const fields = { path, reason: error.reason, ...(error.unavailable ? describeError(error.cause) : {}) };
  if (error.unavailable) log.error("console.auth.unavailable", fields);
  else log.warn("console.auth.refused", fields);
  throw new TRPCError({ code: TRPC_CODE[AUTH_REFUSAL[error.reason]], message: error.message, cause: error });
}

export const ispProcedure = baseProcedure.use(async ({ ctx, next, path }) => {
  const { principal: claimed, authFailure } = ctx;
  if (!claimed) return refuse(ctx.log, path, authFailure ?? new AuthError(AUTH_REASON.TOKEN_MISSING, "missing bearer token"));

  const log = ctx.log.child({ sub: claimed.sub, ispId: claimed.ispId, role: claimed.role });
  let match;
  try {
    match = ctx.deps.users ? await ctx.deps.users.find(claimed.ispId, claimed.sub) : undefined;
  } catch (error) {
    return refuse(log, path, new AuthError(AUTH_REASON.AUTH_UNAVAILABLE, "could not read the user directory", { cause: error }));
  }
  if (match && !match.active) refuse(log, path, new AuthError(AUTH_REASON.USER_INACTIVE, "this console account is no longer active"));

  const principal: Principal = match ? { ...claimed, userId: match.userId } : claimed;
  const ispContext: IspContext = { ...ctx, principal, authFailure: null, log };
  return next({ ctx: ispContext });
});

function enforceRole(ctx: IspContext, path: string, roles: readonly ConsoleRole[]): void {
  if (roles.includes(ctx.principal.role)) return;
  refuse(ctx.log, path, new AuthError(AUTH_REASON.ROLE_NOT_ALLOWED, `this procedure needs one of: ${roles.join(", ")}`));
}

/** Operator + role SUPERVISOR or JUDGE. */
export const supervisorProcedure = ispProcedure.use(({ ctx, next, path }) => {
  enforceRole(ctx, path, ["SUPERVISOR", "JUDGE"]);
  return next();
});

/** Supervisor + a recent interactive sign-in (real clock): the manual evidence validation (ADR-0011). */
export const recentLoginProcedure = supervisorProcedure.use(({ ctx, next, path }) => {
  if (!isSignInFresh(ctx.principal, ctx.deps.wallClock())) {
    refuse(ctx.log, path, new AuthError(AUTH_REASON.LOGIN_NOT_RECENT, "enter your password again to continue"));
  }
  return next();
});
