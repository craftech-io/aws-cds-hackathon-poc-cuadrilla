import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ulidTime } from "@cuadrilla/shared";
import { createDispatchApi, type HttpRequest } from "./api";
import { dispatchEventId } from "./commands";
import { DISPATCH_ROUTES, DispatchCommandResult, DispatchErrorBody, DispatchHealth, DispatchOrderView, workOrderPath } from "./contract";
import { DISPATCH_EVENT_SOURCE, WorkOrderRescheduledDetail, parseDispatchBusEvent, toBusEvent, type DispatchEvent } from "./events";
import { fromFunctionUrlEvent, toFunctionUrlResult } from "./http";
import { DispatchOrderItem, dispatchEventSk } from "./items";
import { createLogger } from "./log";
import { putEventsEntry, recordingPublisher } from "./publisher";
import { memoryDispatchStore, type DispatchStore } from "./store";

const NOW = new Date("2026-10-13T16:40:05.000Z");
const AT_SIM = "2026-10-13T10:40:00-06:00";
const WINDOW = { start: "2026-10-13T11:30:00-06:00", end: "2026-10-13T13:30:00-06:00" };
const NEW_WINDOW = { start: "2026-10-14T09:00:00-06:00", end: "2026-10-14T11:00:00-06:00" };

function order(overrides: Partial<Record<string, unknown>> = {}): DispatchOrderItem {
  const ispId = (overrides.ispId as string | undefined) ?? "isp-demo";
  const clockId = ispId === "isp-demo" ? "GLOBAL#isp-demo" : ispId.startsWith("isp-judge-") ? `JUDGE#${ispId}` : ispId.slice(4);
  return DispatchOrderItem.parse({
    PK: `DWO#${ispId}#24818`,
    SK: "META",
    entity: "DispatchOrder",
    ispId,
    workOrderNumber: "24818",
    workOrderId: "wo-24818",
    installerId: "inst-rogelio",
    customerId: "cust-10422",
    plan: "Fibra 200",
    appointmentWindow: WINDOW,
    status: "SCHEDULED",
    createdAt: "2026-10-12T12:00:00.000Z",
    updatedAt: "2026-10-12T12:00:00.000Z",
    version: 1,
    clockId,
    synthetic: true,
    ...overrides,
  });
}

function world(orders: DispatchOrderItem[] = [order()], store?: DispatchStore) {
  const memory = memoryDispatchStore(orders);
  const publisher = recordingPublisher();
  const logs: string[] = [];
  const api = createDispatchApi({ store: store ?? memory, publisher, now: () => NOW, log: createLogger((line) => logs.push(line), () => NOW) });
  const send = async (request: HttpRequest) => {
    const response = await api.handle(request);
    return { ...response, json: JSON.parse(response.body) as unknown };
  };
  const post = (path: string, body: unknown) => send({ method: "POST", path, query: {}, body: typeof body === "string" ? body : JSON.stringify(body), requestId: "req-1" });
  const get = (path: string, query: Record<string, string> = {}) => send({ method: "GET", path, query, requestId: "req-1" });
  return { memory, publisher, logs, api, post, get };
}

const reschedule = (key = "run-1/SC-01/7", extra: Record<string, unknown> = {}) => ({
  ispId: "isp-demo",
  newWindow: NEW_WINDOW,
  reason: "CUSTOMER_REQUEST",
  occurredAtSim: AT_SIM,
  idempotencyKey: key,
  ...extra,
});
const cancel = (key = "run-1/SC-01/9") => ({ ispId: "isp-demo", reason: "CUSTOMER_REQUEST", occurredAtSim: AT_SIM, idempotencyKey: key });

function section7(): string {
  const doc = readFileSync(fileURLToPath(new URL("../../../docs/architecture-integrations.md", import.meta.url)), "utf8");
  const from = doc.indexOf("## 7.");
  return doc.slice(from, doc.indexOf("## 8.", from));
}

describe("[FL-014] dispatch mock routes (docs/architecture-integrations.md §7)", () => {
  it("serves exactly the routes of the §7 table", () => {
    const documented = section7()
      .split("\n")
      .filter((line) => line.startsWith("| `"))
      .map((line) => /`([A-Z]+) ([^`?]+)/.exec(line)?.slice(1, 3).join(" "));
    expect(documented).toEqual(DISPATCH_ROUTES.map((route) => `${route.method} ${route.path}`));
  });

  it("answers health on GET only", async () => {
    const { get, post } = world();
    const health = await get("/v1/health");
    expect(health.statusCode).toBe(200);
    expect(DispatchHealth.parse(health.json)).toEqual({ ok: true, service: "dispatch-mock" });
    expect((await post("/v1/health", {})).statusCode).toBe(405);
  });

  it("returns the master data of an order by operator and number", async () => {
    const { get } = world([order(), order({ ispId: "isp-judge-03", workOrderId: "wo-24818-j03", installerId: "inst-karina" })]);
    const demo = await get(workOrderPath("24818"), { isp: "isp-demo" });
    expect(demo.statusCode).toBe(200);
    expect(DispatchOrderView.parse(demo.json)).toMatchObject({ workOrderId: "wo-24818", installerId: "inst-rogelio", status: "SCHEDULED", events: [] });
    // Numbers repeat across judge worlds; the operator tells them apart.
    expect(DispatchOrderView.parse((await get(workOrderPath("24818"), { isp: "isp-judge-03" })).json).workOrderId).toBe("wo-24818-j03");
  });

  it("rejects what is not a route, an operator or a work order number", async () => {
    const { get, post, api } = world();
    expect((await get(workOrderPath("24818"))).statusCode).toBe(400);
    expect((await get(workOrderPath("24818"), { isp: "demo" })).statusCode).toBe(400);
    expect((await get(workOrderPath("24899"), { isp: "isp-demo" })).statusCode).toBe(404);
    expect((await get(workOrderPath("24818"), { isp: "isp-judge-07" })).statusCode).toBe(404);
    expect((await get("/v1/work-orders/2481", { isp: "isp-demo" })).statusCode).toBe(400);
    expect((await post("/v1/work-orders/24818/close", cancel())).statusCode).toBe(404);
    expect((await get("/v1/orders/24818", { isp: "isp-demo" })).statusCode).toBe(404);
    expect((await post(workOrderPath("24818"), cancel())).statusCode).toBe(405);
    expect((await get(workOrderPath("24818", "cancel"), { isp: "isp-demo" })).statusCode).toBe(405);
    const put = await api.handle({ method: "PUT", path: "/v1/health", query: {} });
    expect(put.statusCode).toBe(405);
    expect(DispatchErrorBody.parse(JSON.parse(put.body)).error.code).toBe("INVALID");
  });
});

describe("[FL-014] reschedule publishes WorkOrderRescheduled on the Feeds bus", () => {
  it("moves the order, stores the event and publishes it through the port", async () => {
    const { post, publisher, memory } = world();
    const response = await post(workOrderPath("24818", "reschedule"), reschedule());
    expect(response.statusCode).toBe(200);
    const result = DispatchCommandResult.parse(response.json);
    expect(result).toMatchObject({ type: "WorkOrderRescheduled", replayed: false, order: { status: "RESCHEDULED", appointmentWindow: NEW_WINDOW, version: 2 } });
    expect(publisher.published).toEqual([
      {
        type: "WorkOrderRescheduled",
        detail: {
          eventId: result.eventId,
          ispId: "isp-demo",
          workOrderNumber: "24818",
          previousWindow: WINDOW,
          newWindow: NEW_WINDOW,
          reason: "CUSTOMER_REQUEST",
          occurredAtSim: AT_SIM,
        },
      },
    ]);
    const [meta, event, ...rest] = memory.rows("isp-demo", "24818");
    expect(rest).toEqual([]);
    expect(meta).toMatchObject({ status: "RESCHEDULED", lastEventId: result.eventId, version: 2, updatedAt: NOW.toISOString(), customerId: "cust-10422" });
    expect(event).toMatchObject({ SK: `EVT#2026-10-13T16:40:00.000Z#${result.eventId}`, idempotencyKey: "run-1/SC-01/7", clockId: "GLOBAL#isp-demo" });
    expect(result.order.events).toEqual([{ eventId: result.eventId, type: "WorkOrderRescheduled", reason: "CUSTOMER_REQUEST", occurredAtSim: AT_SIM }]);
  });

  it("puts the entry with the source, detail type and detail of the §7 example", async () => {
    const { post, publisher } = world();
    await post(workOrderPath("24818", "reschedule"), reschedule());
    const [published] = publisher.published as [DispatchEvent];
    const section = section7();
    const example = JSON.parse(section.slice(section.indexOf("```json") + 7, section.indexOf("```", section.indexOf("```json") + 7))) as {
      Source: string;
      DetailType: string;
      Detail: Record<string, unknown>;
    };
    const entry = putEventsEntry(published, "feeds-bus");
    expect(entry).toMatchObject({ EventBusName: "feeds-bus", Source: example.Source, DetailType: example.DetailType });
    expect(DISPATCH_EVENT_SOURCE).toBe(example.Source);
    expect(Object.keys(JSON.parse(entry.Detail ?? "{}") as object).sort()).toEqual(Object.keys(example.Detail).sort());
    expect(WorkOrderRescheduledDetail.safeParse({ ...example.Detail, eventId: published.detail.eventId }).success).toBe(true);
  });

  it("publishes what the consumer of the bus parses back to the same event", async () => {
    const { post, publisher } = world();
    await post(workOrderPath("24818", "reschedule"), reschedule());
    const [published] = publisher.published as [DispatchEvent];
    const delivered = toBusEvent(published, { id: "0f1e2d3c", time: NOW.toISOString(), account: "123456789012", region: "us-east-1" });
    expect(parseDispatchBusEvent(delivered)).toEqual(published);
    expect(() => parseDispatchBusEvent({ ...delivered, source: "other.source" })).toThrow();
    expect(() => parseDispatchBusEvent({ ...delivered, detail: { ...published.detail, extra: 1 } })).toThrow();
  });

  it("carries the world's clock, tag and TTL onto the event row of a QA world", async () => {
    const qa = order({ ispId: "isp-qa-812-1-sc-01", PK: "DWO#isp-qa-812-1-sc-01#24818", world: "qa", runId: "812-1", expiresAt: 1_760_500_000 });
    const { post, memory } = world([qa]);
    const response = await post(workOrderPath("24818", "reschedule"), reschedule("812-1/SC-01/7", { ispId: "isp-qa-812-1-sc-01" }));
    expect(response.statusCode).toBe(200);
    expect(memory.rows("isp-qa-812-1-sc-01", "24818")[1]).toMatchObject({ clockId: "qa-812-1-sc-01", world: "qa", runId: "812-1", expiresAt: 1_760_500_000 });
  });

  it("still reschedules an order the product already closed: the dispatcher does not know it", async () => {
    const { post, publisher } = world([order({ status: "RESCHEDULED" })]);
    expect((await post(workOrderPath("24818", "reschedule"), reschedule())).statusCode).toBe(200);
    expect(publisher.published).toHaveLength(1);
  });
});

describe("[FL-014] cancel, duplicate events and conflicts", () => {
  it("cancels once; the same idempotency key publishes the same event again without a second change", async () => {
    const { post, publisher, memory } = world();
    const first = DispatchCommandResult.parse((await post(workOrderPath("24818", "cancel"), cancel())).json);
    expect(first).toMatchObject({ type: "WorkOrderCancelled", replayed: false, order: { status: "CANCELLED", version: 2 } });
    const again = DispatchCommandResult.parse((await post(workOrderPath("24818", "cancel"), cancel())).json);
    expect(again).toMatchObject({ eventId: first.eventId, replayed: true, order: { status: "CANCELLED", version: 2 } });
    expect(publisher.published.map((event) => event.detail.eventId)).toEqual([first.eventId, first.eventId]);
    expect(memory.rows("isp-demo", "24818")).toHaveLength(2);
  });

  it("refuses to change a cancelled order and publishes nothing", async () => {
    const { post, publisher } = world([order({ status: "CANCELLED" })]);
    const response = await post(workOrderPath("24818", "reschedule"), reschedule());
    expect(response.statusCode).toBe(409);
    expect(DispatchErrorBody.parse(response.json).error).toMatchObject({ code: "CONFLICT", reason: "ORDER_CANCELLED" });
    expect(publisher.published).toEqual([]);
  });

  it("refuses a key reused for another action and a change that changes nothing", async () => {
    const { post } = world();
    await post(workOrderPath("24818", "cancel"), cancel("k-1"));
    const reused = await post(workOrderPath("24818", "reschedule"), reschedule("k-1"));
    expect(DispatchErrorBody.parse(reused.json).error.reason).toBe("IDEMPOTENCY_KEY_REUSED");
    const same = world();
    // The same instants written with another offset are the same window.
    const unchanged = await same.post(workOrderPath("24818", "reschedule"), reschedule("k-2", { newWindow: { start: "2026-10-13T17:30:00Z", end: "2026-10-13T19:30:00Z" } }));
    expect(DispatchErrorBody.parse(unchanged.json).error).toMatchObject({ code: "CONFLICT", reason: "UNCHANGED" });
  });

  // A rival call lands between the read and the write of the call under test.
  function racing(rivalKey: string) {
    const inner = memoryDispatchStore([order()]);
    const rival = createDispatchApi({ store: inner, publisher: recordingPublisher(), now: () => NOW, log: createLogger(() => undefined) });
    let raced = false;
    const store: DispatchStore = {
      async load(ispId, number) {
        const record = await inner.load(ispId, number);
        if (!raced) {
          raced = true;
          await rival.handle({ method: "POST", path: workOrderPath("24818", "cancel"), query: {}, body: JSON.stringify(cancel(rivalKey)) });
        }
        return record;
      },
      commit: (current, change, event) => inner.commit(current, change, event),
    };
    return { inner, store };
  }

  it("answers VERSION_CONFLICT when another change lands between read and write", async () => {
    const { inner, store } = racing("rival");
    const { post, publisher } = world([order()], store);
    const response = await post(workOrderPath("24818", "reschedule"), reschedule("late"));
    expect(DispatchErrorBody.parse(response.json).error).toMatchObject({ code: "CONFLICT", reason: "VERSION_CONFLICT" });
    expect(publisher.published).toEqual([]);
    expect(inner.rows("isp-demo", "24818")[0]).toMatchObject({ status: "CANCELLED", version: 2 });
  });

  it("replays the twin's event when the rival carried the same key", async () => {
    const { inner, store } = racing("twin");
    const { post, publisher } = world([order()], store);
    const result = DispatchCommandResult.parse((await post(workOrderPath("24818", "cancel"), cancel("twin"))).json);
    expect(result).toMatchObject({ replayed: true, order: { status: "CANCELLED", version: 2 } });
    expect(publisher.published.map((event) => event.detail.eventId)).toEqual([result.eventId]);
    expect(inner.rows("isp-demo", "24818")).toHaveLength(2);
  });

  it("applies two concurrent calls with the same key once", async () => {
    const { post, memory, publisher } = world();
    const [a, b] = await Promise.all([post(workOrderPath("24818", "cancel"), cancel("twin")), post(workOrderPath("24818", "cancel"), cancel("twin"))]);
    const results = [a, b].map((response) => DispatchCommandResult.parse(response.json));
    expect(new Set(results.map((result) => result.eventId)).size).toBe(1);
    expect(results.filter((result) => result.replayed)).toHaveLength(1);
    expect(memory.rows("isp-demo", "24818")).toHaveLength(2);
    expect(publisher.published).toHaveLength(2);
  });
});

describe("[FL-015] reassign publishes WorkOrderReassigned", () => {
  it("changes the installer and names both in the event", async () => {
    const { post, publisher } = world();
    const body = { ispId: "isp-demo", newInstallerId: "inst-karina", reason: "WORKLOAD_BALANCE", occurredAtSim: AT_SIM, idempotencyKey: "run-1/SC-01/8" };
    const result = DispatchCommandResult.parse((await post(workOrderPath("24818", "reassign"), body)).json);
    expect(result.order).toMatchObject({ installerId: "inst-karina", status: "REASSIGNED", appointmentWindow: WINDOW });
    expect(publisher.published[0]).toEqual({
      type: "WorkOrderReassigned",
      detail: { eventId: result.eventId, ispId: "isp-demo", workOrderNumber: "24818", previousInstallerId: "inst-rogelio", newInstallerId: "inst-karina", reason: "WORKLOAD_BALANCE", occurredAtSim: AT_SIM },
    });
    const same = await post(workOrderPath("24818", "reassign"), { ...body, newInstallerId: "inst-karina", idempotencyKey: "other" });
    expect(DispatchErrorBody.parse(same.json).error.reason).toBe("UNCHANGED");
  });
});

describe("[FL-014] request validation, bus outages and logs", () => {
  it("rejects invalid bodies with the failing fields and never echoes their values", async () => {
    const { post, publisher } = world();
    const cases: Array<[unknown, number]> = [
      [reschedule("k", { override: true }), 400],
      [reschedule("k", { newWindow: { start: NEW_WINDOW.end, end: NEW_WINDOW.start } }), 400],
      [reschedule("k", { newWindow: { start: "2026-10-14T06:00:00-06:00", end: "2026-10-14T19:00:00-06:00" } }), 400],
      [reschedule("k", { occurredAtSim: "2026-10-13T10:40:00" }), 400],
      [reschedule("bad key with spaces"), 400],
      ["{not json", 400],
      ["", 400],
      [reschedule("k", { reason: "x".repeat(20_000) }), 413],
    ];
    for (const [body, status] of cases) {
      const response = await post(workOrderPath("24818", "reschedule"), body);
      expect(response.statusCode).toBe(status);
      expect(response.body).not.toContain("bad key with spaces");
    }
    const extra = await post(workOrderPath("24818", "reschedule"), reschedule("k", { override: true }));
    expect(DispatchErrorBody.parse(extra.json).error).toMatchObject({ code: "INVALID", reason: "VALIDATION" });
    expect(publisher.published).toEqual([]);
  });

  it("keeps the event when the bus fails and publishes it on the retry with the same key", async () => {
    const { post, publisher, memory, logs } = world();
    publisher.failNext();
    const failed = await post(workOrderPath("24818", "cancel"), cancel("retry-me"));
    expect(failed.statusCode).toBe(503);
    expect(failed.headers["retry-after"]).toBe("1");
    expect(publisher.published).toEqual([]);
    expect(memory.rows("isp-demo", "24818")).toHaveLength(2);
    const retried = DispatchCommandResult.parse((await post(workOrderPath("24818", "cancel"), cancel("retry-me"))).json);
    expect(retried.replayed).toBe(true);
    expect(publisher.published.map((event) => event.detail.eventId)).toEqual([retried.eventId]);
    expect(logs.some((line) => (JSON.parse(line) as { errorName?: string }).errorName === "PublishError")).toBe(true);
  });

  it("logs one JSON line per request with ids and codes only", async () => {
    const { post, logs } = world();
    await post(workOrderPath("24818", "reschedule"), reschedule());
    const line = JSON.parse(logs.at(-1) ?? "{}") as Record<string, unknown>;
    expect(line).toMatchObject({ level: "info", service: "dispatch-mock", requestId: "req-1", route: "reschedule", statusCode: 200, ispId: "isp-demo", workOrderNumber: "24818" });
    expect(logs.join("\n")).not.toMatch(/inst-|2026-10-14T09|run-1/);
  });
});

describe("event ids and the Function URL adapter", () => {
  it("derives a stable evt_<ULID> from operator, number and key, timed at the simulated instant", async () => {
    const id = await dispatchEventId("isp-demo", "24818", "k", AT_SIM);
    expect(id).toMatch(/^evt_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(await dispatchEventId("isp-demo", "24818", "k", AT_SIM)).toBe(id);
    expect(await dispatchEventId("isp-judge-03", "24818", "k", AT_SIM)).not.toBe(id);
    expect(await dispatchEventId("isp-demo", "24818", "k2", AT_SIM)).not.toBe(id);
    expect(ulidTime(id.slice(4))).toBe(Date.parse(AT_SIM));
    expect(dispatchEventSk(AT_SIM, id)).toBe(`EVT#2026-10-13T16:40:00.000Z#${id}`);
  });

  it("maps a Function URL event and result, base64 bodies included", () => {
    const body = JSON.stringify(cancel());
    const request = fromFunctionUrlEvent({
      version: "2.0",
      routeKey: "$default",
      rawPath: "/v1/work-orders/24818/cancel",
      rawQueryString: "",
      headers: {},
      isBase64Encoded: true,
      body: Buffer.from(body).toString("base64"),
      requestContext: { http: { method: "POST", path: "/v1/work-orders/24818/cancel", protocol: "HTTP/1.1", sourceIp: "10.0.0.1", userAgent: "sdk" }, requestId: "abc" },
    } as Parameters<typeof fromFunctionUrlEvent>[0]);
    expect(request).toEqual({ method: "POST", path: "/v1/work-orders/24818/cancel", query: {}, body, requestId: "abc" });
    expect(toFunctionUrlResult({ statusCode: 200, headers: { "content-type": "application/json" }, body: "{}" })).toEqual({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: "{}",
      isBase64Encoded: false,
    });
  });
});
