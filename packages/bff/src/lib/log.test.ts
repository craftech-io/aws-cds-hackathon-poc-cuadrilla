import { describe, expect, it } from "vitest";
import { ChannelError, ConnectorError } from "@cuadrilla/shared";
import { MASK, correlationIdFrom, createLogger, redactFields, redactText } from "./log";

function capture(level: "debug" | "info" = "debug") {
  const lines: string[] = [];
  const logger = createLogger({ correlationId: "corr-0001-test", level, sink: (line) => lines.push(line), now: () => new Date("2026-10-13T15:20:00Z"), bindings: { service: "inbound-whatsapp" } });
  return { logger, lines, last: (): Record<string, unknown> => JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown> };
}

describe("logger", () => {
  it("writes one JSON line with level, time, correlation id and bindings", () => {
    const { logger, lines, last } = capture();
    logger.info("turn finished", { turnId: "01J7TURN", durationMs: 1840, toolCalls: 3 });
    expect(lines).toHaveLength(1);
    expect(last()).toEqual({ level: "info", time: "2026-10-13T15:20:00.000Z", correlationId: "corr-0001-test", message: "turn finished", service: "inbound-whatsapp", turnId: "01J7TURN", durationMs: 1840, toolCalls: 3 });
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

  it("[FL-078] masks E.164 and national phones and emails wherever they appear", () => {
    const { logger, last, lines } = capture();
    logger.info("inbound from +52 55 0900 0101 and ops.lead@simulator.amazonses.com", {
      phoneE164: "+525509000101",
      email: "ops.lead@simulator.amazonses.com",
      address: "+525509000102",
      to: "success+c10421@simulator.amazonses.com",
      note: "llámale a la señora al 55 0900 0103 o al (55) 0900-0104",
    });
    expect(last()).toMatchObject({
      message: `inbound from ${MASK.phone} and ${MASK.email}`,
      phoneE164: MASK.phone,
      email: MASK.email,
      address: MASK.phone,
      to: MASK.email,
      note: `llámale a la señora al ${MASK.phone} o al ${MASK.phone}`,
    });
    expect(lines[0]).not.toMatch(/0900|ops\.lead|c10421/);
  });

  it("[FL-078] masks CURP, RFC, CLABE and cards with the markers of the normalizer", () => {
    const { logger, last, lines } = capture();
    logger.info("installer wrote sensitive data", {
      note: "El CURP de la señora es TAMR800101MDFMZS09 y su RFC TAMR800101AB3",
      detail: "CLABE 002180700123456789, tarjeta 4111 1111 1111 1111",
      curp: "TAMR800101MDFMZS09",
      clabe: "002 180 70012345678 9",
      card: "4111-1111-1111-1111",
      ine: "IDMEX1234567890",
    });
    expect(last()).toMatchObject({
      note: `El CURP de la señora es ${MASK.curp} y su RFC ${MASK.rfc}`,
      detail: `CLABE ${MASK.clabe}, tarjeta ${MASK.card}`,
      curp: MASK.curp,
      clabe: MASK.clabe,
      card: MASK.card,
      ine: MASK.document,
    });
    expect(lines[0]).not.toMatch(/TAMR800101|0021807|4111|IDMEX/);
  });

  it("[FL-078] masks names and amounts; transcripts, texts and charges are never logged", () => {
    const { logger, last, lines } = capture();
    logger.info("certificate built", {
      displayName: "Lucía Treviño",
      customerName: "Lucía Treviño",
      charge: { amount: 850, currency: "MXN", amountText: "$ 1,250.00" },
      totalPending: 1250,
      text: "El cargo de extensión es de $ 1,250.00",
      transcript: "ya estoy con la señora, su teléfono es 55 0900 0105",
      summary: "cargo $ 1,250.00 informado",
      workOrderId: "wo-24817",
    });
    expect(last()).toMatchObject({ displayName: MASK.name, customerName: MASK.name, charge: MASK.amount, totalPending: MASK.amount, text: MASK.omitted, transcript: MASK.omitted, summary: `cargo ${MASK.amount} informado`, workOrderId: "wo-24817" });
    expect(lines[0]).not.toMatch(/1,250|Treviño|0900/);
  });

  it("[FL-078] never logs session tokens, secrets, images or seed overrides", () => {
    const { logger, lines } = capture();
    logger.info("tool call", {
      sessionToken: "01J7SESSION.01J7TURN.1792000000.c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWduYXR1cmUtc2lnbmF0",
      subkey: "k",
      image: "iVBORw0KGgoAAAANSUhEUgAA",
      seedOverrides: { demoRecipients: { emails: ["team@corp.example"] } },
      brandConfig: { mode: "cobrand" },
    });
    expect(lines[0]).not.toMatch(/SESSION|c2lnbmF0|iVBORw0|team@corp|cobrand/);
  });

  it("truncates ONU serials to the prefix and the last four characters", () => {
    const { logger, last } = capture();
    logger.info("onu read for DEMO3F2C19A0", { serialInText: "ONU DEMO3F2C1A11 LOS", onu: "DEMO3F2C1B27" });
    expect(last()).toMatchObject({ message: "onu read for DEMO…19A0", serialInText: "ONU DEMO…1A11 LOS", onu: "DEMO…1B27" });
  });

  it("drops raw provider events and tool results, keeps hashes, ids, instants and counters", () => {
    const { logger, last } = capture();
    const phoneHash = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
    logger.debug("sns event", {
      event: { Records: [{ Sns: { Message: "{...}" } }] },
      toolResult: { ok: true, total: 1 },
      phoneHash,
      providerMessageId: "01J7ABCDEFGHJKMNPQRSTVWXYZ",
      receivedAt: "2026-10-13T09:20:00-06:00",
      expiresAt: 1788872400000,
      sizeBytes: 4_500_000,
      used: 1_500_000,
    });
    expect(last()).toMatchObject({ event: MASK.omitted, toolResult: MASK.omitted, phoneHash, providerMessageId: "01J7ABCDEFGHJKMNPQRSTVWXYZ", receivedAt: "2026-10-13T09:20:00-06:00", expiresAt: 1788872400000, sizeBytes: 4_500_000, used: 1_500_000 });
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
  it("leaves dates, ids, section ids and readings alone", () => {
    expect(redactText("2026-10-13T09:20:00-06:00")).toBe("2026-10-13T09:20:00-06:00");
    expect(redactText("ev-01J7ABCDEFGHJKMNPQRSTVWXYZ for ONU_LABEL_PHOTO on 2026-10-13")).toBe("ev-01J7ABCDEFGHJKMNPQRSTVWXYZ for ONU_LABEL_PHOTO on 2026-10-13");
    expect(redactText("orden 24817, sección SEG-01, −21,4 dBm a 1490 nm, 09:00-11:00, OLT-N3/1/4")).toBe("orden 24817, sección SEG-01, −21,4 dBm a 1490 nm, 09:00-11:00, OLT-N3/1/4");
  });

  it("masks long free-standing digit runs and formatted money", () => {
    expect(redactText("folio 12345678 pagó $850")).toBe(`folio ${MASK.number} pagó ${MASK.amount}`);
    expect(redactText("total $ 1,234,567.00")).toBe(`total ${MASK.amount}`);
    expect(redactFields({ nested: [{ email: "a@b.co" }], count: 12, price: 0.02 })).toEqual({ nested: [{ email: MASK.email }], count: 12, price: MASK.amount });
  });

  it("only reuses a correlation id that looks like one", () => {
    expect(correlationIdFrom("corr-0001-test")).toBe("corr-0001-test");
    expect(correlationIdFrom('x"}\n{"level":"error"')).toMatch(/^[0-9a-f-]{36}$/);
    expect(correlationIdFrom(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });
});
