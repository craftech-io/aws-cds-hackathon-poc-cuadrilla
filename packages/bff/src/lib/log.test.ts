import { describe, expect, it } from "vitest";
import { ChannelError, ConnectorError } from "@cuadrilla/shared";
import { MASK, correlationIdFrom, createLogger, redactFields, redactText } from "./log";

function capture(level: "debug" | "info" = "debug") {
  const lines: string[] = [];
  const logger = createLogger({ correlationId: "corr-0001-test", level, sink: (line) => lines.push(line), now: () => new Date("2026-09-08T13:00:00Z"), bindings: { service: "inbound-whatsapp" } });
  return { logger, lines, last: (): Record<string, unknown> => JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown> };
}

describe("logger", () => {
  it("writes one JSON line with level, time, correlation id and bindings", () => {
    const { logger, lines, last } = capture();
    logger.info("turn finished", { turnId: "01J7TURN", durationMs: 1840, toolCalls: 3 });
    expect(lines).toHaveLength(1);
    expect(last()).toEqual({ level: "info", time: "2026-09-08T13:00:00.000Z", correlationId: "corr-0001-test", message: "turn finished", service: "inbound-whatsapp", turnId: "01J7TURN", durationMs: 1840, toolCalls: 3 });
  });

  it("carries the correlation id into child loggers and respects the level", () => {
    const { logger, lines, last } = capture("info");
    const child = logger.child({ tool: "get_work_orders" });
    child.debug("not written");
    child.warn("slow call");
    expect(lines).toHaveLength(1);
    expect(last()).toMatchObject({ level: "warn", correlationId: "corr-0001-test", service: "inbound-whatsapp", tool: "get_work_orders" });
    expect(child.correlationId).toBe(logger.correlationId);
  });

  it("[FL-078] masks E.164 numbers and emails wherever they appear", () => {
    const { logger, last, lines } = capture();
    logger.info("inbound from +52 55 0900 0101 and ops.lead@example.test", { phoneE164: "+525509000101", email: "ops.lead@example.test", address: "+525509000102", to: "success@simulator.amazonses.com", note: "llamar al +52 55 0900 0102" });
    expect(last()).toMatchObject({ message: `inbound from ${MASK.phone} and ${MASK.email}`, phoneE164: MASK.phone, email: MASK.email, address: MASK.phone, to: MASK.email, note: `llamar al ${MASK.phone}` });
    expect(lines[0]).not.toMatch(/0900|ops\.lead|simulator/);
  });

  it("[FL-078] masks CURP, RFC, names and amounts; charges are never logged", () => {
    const { logger, last, lines } = capture();
    logger.info("certificate built", {
      displayName: "Rosa Tamez", curp: "TAMR800101MDFMZS09", documentsInText: "CURP TAMR800101MDFMZS09 RFC TAMR800101AB3 CLABE 002180700123456789", charge: { amount: 850, currency: "MXN", amountText: "$ 1,250.00" },
      totalPending: 1250, text: "El cargo es de $ 1,250.00", summary: "cargo $ 1,250.00 informado", workOrderId: "wo-24817",
    });
    expect(last()).toMatchObject({ displayName: MASK.name, curp: MASK.document, documentsInText: `CURP ${MASK.document} RFC ${MASK.document} CLABE ${MASK.number}`, charge: MASK.amount, totalPending: MASK.amount, text: MASK.omitted, summary: `cargo ${MASK.amount} informado`, workOrderId: "wo-24817" });
    expect(lines[0]).not.toMatch(/1,250|Tamez|TAMR800101|0070012345/);
  });

  it("drops raw provider events and tool results, keeps hashes, ids and instants", () => {
    const { logger, last } = capture();
    const addressHash = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
    logger.debug("sns event", { event: { Records: [{ Sns: { Message: "{...}" } }] }, toolResult: { ok: true, total: 1 }, addressHash, providerMessageId: "01J7ABCDEFGHJKMNPQRSTVWXYZ", receivedAt: "2026-09-08T10:00:00-06:00", expiresAt: 1788872400000, sizeBytes: 4_500_000 });
    expect(last()).toMatchObject({ event: MASK.omitted, toolResult: MASK.omitted, addressHash, providerMessageId: "01J7ABCDEFGHJKMNPQRSTVWXYZ", receivedAt: "2026-09-08T10:00:00-06:00", expiresAt: 1788872400000, sizeBytes: 4_500_000 });
  });

  it("serialises typed errors with their code and a redacted message", () => {
    const { logger, last } = capture();
    const cause = new ConnectorError("THROTTLED", "table throttled", "People");
    logger.error("send failed", { error: new ChannelError("SEND_FAILED", "WHATSAPP", "cannot reach +525509000101", { cause }) });
    expect(last().error).toMatchObject({ name: "ChannelError", code: "SEND_FAILED", channel: "WHATSAPP", retryable: true, message: `cannot reach ${MASK.phone}`, cause: { name: "ConnectorError", code: "THROTTLED", table: "People" } });
  });

  it("survives circular structures, huge strings and deep nesting", () => {
    const { logger, last } = capture();
    const circular: Record<string, unknown> = { id: "a" };
    circular.self = circular;
    logger.info("odd input", { circular, long: "x".repeat(5_000), deep: { a: { b: { c: { d: { e: { f: { g: "too deep" } } } } } } } });
    const record = last();
    expect(JSON.stringify(record)).toContain("truncated 3000");
    expect(JSON.stringify(record.deep)).toContain(MASK.omitted);
    expect(record.message).toBe("odd input");
  });

  it("does not let a field overwrite the envelope", () => {
    const { logger, last } = capture();
    logger.info("real message", { level: "debug", correlationId: "spoofed" });
    expect(last()).toMatchObject({ level: "info", correlationId: "corr-0001-test", field_level: "debug", field_correlationId: "spoofed" });
  });
});

describe("redaction helpers", () => {
  it("leaves dates and ids alone", () => {
    expect(redactText("2026-09-08T10:00:00-06:00")).toBe("2026-09-08T10:00:00-06:00");
    expect(redactText("ev-wo-24817-ONU_LABEL_PHOTO-v2 on 2026-10-13")).toBe("ev-wo-24817-ONU_LABEL_PHOTO-v2 on 2026-10-13");
    expect(redactText("orden 24817, sección SEG-01")).toBe("orden 24817, sección SEG-01");
  });

  it("masks long free-standing digit runs and formatted money", () => {
    expect(redactText("tarjeta 4111111111111111 pagó $850")).toBe(`tarjeta ${MASK.number} pagó ${MASK.amount}`);
    expect(redactFields({ nested: [{ email: "a@b.co" }], count: 12, price: 0.02 })).toEqual({ nested: [{ email: MASK.email }], count: 12, price: MASK.amount });
  });

  it("only reuses a correlation id that looks like one", () => {
    expect(correlationIdFrom("corr-0001-test")).toBe("corr-0001-test");
    expect(correlationIdFrom('x"}\n{"level":"error"')).toMatch(/^[0-9a-f-]{36}$/);
    expect(correlationIdFrom(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });
});
