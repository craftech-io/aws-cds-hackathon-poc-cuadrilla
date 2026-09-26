// tRPC v11 foundation of the console BFF: request context, principal and the procedure builders
// every feature router starts from (docs/architecture.md §10).
//
//   publicProcedure       no principal: only `health.live` and `brand.get`, which carry no world's data
//   ispProcedure          a verified principal of an active registry user, bound to its operator's
//                         world; every id of the input is fenced to that operator (auth/fence.ts):
//                         an id of another one → 403 + `AuditLog DENY CROSS_ISP`
//   supervisorProcedure   + role SUPERVISOR or GUEST (a guest acts as supervisor in its own world)
//   recentLoginProcedure  + an interactive sign-in at most 15 minutes old (manual validation, ADR-0011)
//
// `ispId`, `role` and the world come from the principal, never from the input. A request's principal
// comes only from a verified id token (`createContextFactory`); the `QaDriver` builds its principals
// on the server (`createServerContext`, auth/qa-principal.ts) and the same middlewares run for both.
import { TRPCError, initTRPC } from "@trpc/server";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { z } from "zod";
import { type ConsoleRole, type IspKind, ToolError, ispKindOfClock } from "@cuadrilla/shared";
import { AUTH_REASON, AUTH_REFUSAL, AuthError, type AuthRefusal, describeError } from "../auth/errors";
import { type InputReference, connectorOwners, findTrespass } from "../auth/fence";
import { bearerToken } from "../auth/jwt";
import { type Principal, isSignInFresh, principalFromClaims } from "../auth/principal";
import { type QaPrincipalInput, qaPrincipal } from "../auth/qa-principal";
import type { UserMatch } from "../auth/staff";
import { userActor } from "../domain/common";
import { type WorldClock, worldClock } from "../lib/clock";
import { type LogFields, type Logger, correlationIdFrom } from "../lib/log";
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

/** The one world a principal acts on. */
export interface ConsoleWorld {
  readonly clockId: string;
  readonly ispId: string;
  readonly kind: IspKind;
  /** Simulated time of the world (ADR-0010), read from `Runtime/CLOCK#` on each call. */
  readonly clock: WorldClock;
}

export interface IspContext extends Context {
  readonly principal: Principal;
  readonly authFailure: null;
  readonly world: ConsoleWorld;
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
 * Builds `createContext` over explicit dependencies (the Lambda's defaults, the local UI server, the
 * tests). It never throws for a bad token: the failure is kept in the context and `ispProcedure`
 * turns it into the right HTTP status, so public procedures keep working.
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

export interface ServerCallOptions extends QaPrincipalInput {
  readonly correlationId?: string;
}

/**
 * Context of a principal built on the server (the `QaDriver`'s `console.*` actions): no token, bound
 * to the world the call names, through the same middlewares as a request. Throws `ROLE_NOT_ALLOWED`
 * when the role cannot act on that world.
 */
export function createServerContext(options: ServerCallOptions, deps: ContextDeps): Context {
  const correlationId = correlationIdFrom(options.correlationId);
  const principal = qaPrincipal(options, deps.wallClock());
  return { correlationId, principal, authFailure: null, deps, log: deps.loggerFor(correlationId) };
}

/** What the browser reads of an unexpected failure; the log keeps the rest under the correlation id. */
export const INTERNAL_ERROR_MESSAGE = "the request could not be completed";

const t = initTRPC.context<Context>().create({
  // Stack traces never travel to the browser, whatever NODE_ENV says inside the Lambda.
  isDev: false,
  errorFormatter({ shape, error, ctx }) {
    return {
      ...shape,
      // An unexpected error's message may quote internals (tables, keys, request data): never sent.
      message: error.code === "INTERNAL_SERVER_ERROR" ? INTERNAL_ERROR_MESSAGE : shape.message,
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

function refuse(log: Logger, path: string, error: AuthError, extra: LogFields = {}): never {
  const fields = { path, reason: error.reason, ...extra, ...(error.unavailable ? describeError(error.cause) : {}) };
  if (error.unavailable) log.error("console.auth.unavailable", fields);
  else log.warn("console.auth.refused", fields);
  throw new TRPCError({ code: TRPC_CODE[AUTH_REFUSAL[error.reason]], message: error.message, cause: error });
}

// A token lives 15 minutes and is verified offline: the registry row (read at most once a minute)
// says whether the user is still active and still the same user of this operator.
async function confirmRegistered(deps: ContextDeps, principal: Principal, log: Logger, path: string): Promise<void> {
  let match: UserMatch | undefined;
  try {
    match = await deps.users.find(principal.ispId, principal.sub);
  } catch (error) {
    refuse(log, path, new AuthError(AUTH_REASON.AUTH_UNAVAILABLE, "could not read the user directory", { cause: error }));
  }
  if (match === undefined || !match.active) refuse(log, path, new AuthError(AUTH_REASON.USER_INACTIVE, "this console account is no longer active"));
  if (match.userId !== principal.userId) refuse(log, path, new AuthError(AUTH_REASON.PRINCIPAL_INCOMPLETE, "sign in again to continue"));
}

function consoleWorld(principal: Principal, deps: ContextDeps): ConsoleWorld {
  return {
    clockId: principal.clockId,
    ispId: principal.ispId,
    kind: ispKindOfClock(principal.clockId),
    clock: worldClock(principal.clockId, { readClock: (clockId) => deps.connector.runtime.getClock(clockId), realClock: { now: async () => deps.wallClock() } }),
  };
}

const resolvePrincipal = t.middleware(async ({ ctx, next, path }) => {
  const { principal, authFailure } = ctx;
  if (!principal) return refuse(ctx.log, path, authFailure ?? new AuthError(AUTH_REASON.TOKEN_MISSING, "missing bearer token"));
  const log = ctx.log.child({ userId: principal.userId, ispId: principal.ispId, role: principal.role, origin: principal.origin });
  // A QA principal has no Cognito identity to look up: the QaDriver built it for this call.
  if (principal.origin === "COGNITO") await confirmRegistered(ctx.deps, principal, log, path);
  return next({ ctx: { principal, authFailure: null, log, world: consoleWorld(principal, ctx.deps) } });
});

// The row goes to the principal's own operator: who asked, for what, when (in the world's time if
// the world is readable). A failed write never lifts the refusal.
async function auditCrossIsp(ctx: IspContext, path: string, reference: InputReference): Promise<void> {
  const { principal } = ctx;
  try {
    const atSim = await ctx.world.clock.now().then((instant) => instant.toISOString(), () => undefined);
    await ctx.deps.connector.audit.append({
      ispId: principal.ispId,
      clockId: principal.clockId,
      ...(atSim === undefined ? {} : { atSim }),
      decision: "DENY",
      action: "CROSS_ISP",
      actor: userActor(principal.userId),
      reason: "the request names an id of another operator",
      refs: { procedure: path },
      detail: { targetKind: reference.kind, field: reference.field, requestedId: reference.value },
    });
  } catch (error) {
    ctx.log.error("console.audit.failed", { path, auditAction: "CROSS_ISP", ...describeError(error) });
  }
}

export const ispProcedure = baseProcedure.use(resolvePrincipal).use(async ({ ctx, next, path, getRawInput }) => {
  let trespass: InputReference | undefined;
  try {
    trespass = await findTrespass(await getRawInput(), ctx.principal, connectorOwners(ctx.deps.connector));
  } catch (error) {
    // A malformed or oversized input is the caller's (400); a failed owner read fails closed (503).
    if (error instanceof ToolError || error instanceof TRPCError) throw error;
    return refuse(ctx.log, path, new AuthError(AUTH_REASON.AUTH_UNAVAILABLE, "could not check the ids of the request", { cause: error }));
  }
  if (trespass !== undefined) {
    await auditCrossIsp(ctx, path, trespass);
    return refuse(ctx.log, path, new AuthError(AUTH_REASON.CROSS_ISP, "this belongs to another operator"), { targetKind: trespass.kind, field: trespass.field });
  }
  return next();
});

function enforceRole(ctx: IspContext, path: string, roles: readonly ConsoleRole[]): void {
  if (roles.includes(ctx.principal.role)) return;
  refuse(ctx.log, path, new AuthError(AUTH_REASON.ROLE_NOT_ALLOWED, `this procedure needs one of: ${roles.join(", ")}`));
}

/** Operator + role SUPERVISOR or GUEST. */
export const supervisorProcedure = ispProcedure.use(({ ctx, next, path }) => {
  enforceRole(ctx, path, ["SUPERVISOR", "GUEST"]);
  return next();
});

/** Supervisor + a recent interactive sign-in (real clock): the manual evidence validation (ADR-0011). */
export const recentLoginProcedure = supervisorProcedure.use(({ ctx, next, path }) => {
  if (!isSignInFresh(ctx.principal, ctx.deps.wallClock())) {
    refuse(ctx.log, path, new AuthError(AUTH_REASON.LOGIN_NOT_RECENT, "enter your password again to continue"));
  }
  return next();
});
