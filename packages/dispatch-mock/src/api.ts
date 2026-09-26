// Router of the dispatch mock over a plain request/response pair, so the Lambda (handler.ts), the unit
// tests and the in-process flows run the same code. Every answer is JSON; errors use the tools'
// `{ ok: false, error }` envelope with NOT_FOUND, INVALID, CONFLICT or UNAVAILABLE.
import { z } from "zod";
import { IspId, WorkOrderNumber, fail, type ErrorCode } from "@cuadrilla/shared";
import { runCommand, type CommandDeps, type CommandOutcome, type DispatchCommand } from "./commands";
import { CancelRequest, DispatchAction, ISP_QUERY_PARAM, ReassignRequest, RescheduleRequest, type DispatchCommandResult, type DispatchHealth } from "./contract";
import { orderView } from "./items";
import { createLogger, type MockLogFields, type MockLogger } from "./log";

export interface HttpRequest {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string | undefined>>;
  readonly body?: string;
  /** Correlation id of the request (the Function URL request id). */
  readonly requestId?: string;
}

export interface HttpResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface DispatchApi {
  handle(request: HttpRequest): Promise<HttpResponse>;
}

export interface ApiDeps extends CommandDeps {
  readonly log?: MockLogger;
}

/** Largest body a control route accepts. */
export const MAX_BODY_BYTES = 16 * 1024;

type LogFields = { -readonly [K in keyof MockLogFields]: MockLogFields[K] };

const STATUS_OF: Readonly<Partial<Record<ErrorCode, number>>> = { INVALID: 400, NOT_FOUND: 404, CONFLICT: 409, UNAVAILABLE: 503 };
const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } as const;
const WORK_ORDER_PATH = /^\/v1\/work-orders\/([^/]+)(?:\/([^/]+))?$/;

function json(statusCode: number, body: unknown, extra: Record<string, string> = {}): HttpResponse {
  return { statusCode, headers: { ...HEADERS, ...extra }, body: JSON.stringify(body) };
}

function failure(code: ErrorCode, message: string, reason?: string): HttpResponse {
  return json(STATUS_OF[code] ?? 400, fail(code, message, reason), code === "UNAVAILABLE" ? { "retry-after": "1" } : {});
}

function methodNotAllowed(allow: "GET" | "POST"): HttpResponse {
  return json(405, fail("INVALID", `method not allowed, use ${allow}`, "METHOD_NOT_ALLOWED"), { allow });
}

// Paths of the fields that failed, never their values (a body may carry anything).
function invalid(error: z.ZodError): HttpResponse {
  const fields = [...new Set(error.issues.map((issue) => issue.path.join(".") || "(body)"))].join(", ");
  return failure("INVALID", `invalid request: ${fields}`, "VALIDATION");
}

function parseBody(body: string | undefined): { ok: true; value: unknown } | { ok: false; response: HttpResponse } {
  if (body === undefined || body.trim() === "") return { ok: false, response: failure("INVALID", "a JSON body is required", "VALIDATION") };
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) return { ok: false, response: json(413, fail("INVALID", "body too large", "BODY_TOO_LARGE")) };
  try {
    return { ok: true, value: JSON.parse(body) as unknown };
  } catch {
    return { ok: false, response: failure("INVALID", "the body is not JSON", "VALIDATION") };
  }
}

function parseCommand(action: DispatchAction, workOrderNumber: string, body: unknown): { ok: true; command: DispatchCommand } | { ok: false; error: z.ZodError } {
  switch (action) {
    case "reschedule": {
      const request = RescheduleRequest.safeParse(body);
      return request.success ? { ok: true, command: { action, workOrderNumber, request: request.data } } : { ok: false, error: request.error };
    }
    case "reassign": {
      const request = ReassignRequest.safeParse(body);
      return request.success ? { ok: true, command: { action, workOrderNumber, request: request.data } } : { ok: false, error: request.error };
    }
    case "cancel": {
      const request = CancelRequest.safeParse(body);
      return request.success ? { ok: true, command: { action, workOrderNumber, request: request.data } } : { ok: false, error: request.error };
    }
  }
}

function commandResponse(outcome: CommandOutcome): HttpResponse {
  if (!outcome.ok) {
    return outcome.code === "NOT_FOUND" ? failure("NOT_FOUND", "unknown work order") : failure("CONFLICT", "the order cannot take this change", outcome.reason);
  }
  const result: DispatchCommandResult = {
    ok: true,
    eventId: outcome.event.detail.eventId,
    type: outcome.event.type,
    replayed: outcome.replayed,
    order: orderView(outcome.order, outcome.events),
  };
  return json(200, result);
}

export function createDispatchApi(deps: ApiDeps): DispatchApi {
  const log = deps.log ?? createLogger();

  async function getWorkOrder(workOrderNumber: string, request: HttpRequest, fields: LogFields): Promise<HttpResponse> {
    const ispId = IspId.safeParse(request.query[ISP_QUERY_PARAM]);
    if (!ispId.success) return failure("INVALID", `query parameter "${ISP_QUERY_PARAM}" must be an operator id`, "VALIDATION");
    fields.ispId = ispId.data;
    const record = await deps.store.load(ispId.data, workOrderNumber);
    return record === undefined ? failure("NOT_FOUND", "unknown work order") : json(200, orderView(record.order, record.events));
  }

  async function control(action: DispatchAction, workOrderNumber: string, request: HttpRequest, fields: LogFields): Promise<HttpResponse> {
    const body = parseBody(request.body);
    if (!body.ok) return body.response;
    const parsed = parseCommand(action, workOrderNumber, body.value);
    if (!parsed.ok) return invalid(parsed.error);
    fields.ispId = parsed.command.request.ispId;
    const outcome = await runCommand(deps, parsed.command);
    if (outcome.ok) {
      fields.eventId = outcome.event.detail.eventId;
      fields.replayed = outcome.replayed;
    } else {
      fields.code = outcome.code;
      if (outcome.code === "CONFLICT") fields.reason = outcome.reason;
    }
    return commandResponse(outcome);
  }

  async function route(request: HttpRequest, fields: LogFields): Promise<HttpResponse> {
    const method = request.method.toUpperCase();
    const path = request.path.length > 1 ? request.path.replace(/\/+$/, "") : request.path;
    if (path === "/v1/health") {
      fields.route = "health";
      if (method !== "GET") return methodNotAllowed("GET");
      const health: DispatchHealth = { ok: true, service: "dispatch-mock" };
      return json(200, health);
    }
    const match = WORK_ORDER_PATH.exec(path);
    if (match === null) return failure("NOT_FOUND", "unknown route");
    const [, rawNumber = "", rawAction] = match;
    const action = rawAction === undefined ? undefined : DispatchAction.safeParse(rawAction);
    if (action !== undefined && !action.success) return failure("NOT_FOUND", "unknown route");
    fields.route = action?.data ?? "getWorkOrder";
    const workOrderNumber = WorkOrderNumber.safeParse(rawNumber);
    if (!workOrderNumber.success) return failure("INVALID", "the work order number has 5 digits", "VALIDATION");
    fields.workOrderNumber = workOrderNumber.data;
    if (action === undefined) return method === "GET" ? getWorkOrder(workOrderNumber.data, request, fields) : methodNotAllowed("GET");
    return method === "POST" ? control(action.data, workOrderNumber.data, request, fields) : methodNotAllowed("POST");
  }

  return {
    async handle(request) {
      const started = deps.now().getTime();
      const fields: LogFields = { method: request.method.toUpperCase(), ...(request.requestId === undefined ? {} : { requestId: request.requestId }) };
      let response: HttpResponse;
      try {
        response = await route(request, fields);
      } catch (error) {
        // Storage or bus failure. The caller repeats with the same key: the change applies at most once
        // and a stored event that missed the bus is published then.
        log.error("dispatch mock request failed", { ...fields, errorName: error instanceof Error ? error.name : "Unknown" });
        response = failure("UNAVAILABLE", "the dispatcher is temporarily unavailable");
      }
      log.info("dispatch mock request", { ...fields, statusCode: response.statusCode, durationMs: deps.now().getTime() - started });
      return response;
    },
  };
}
