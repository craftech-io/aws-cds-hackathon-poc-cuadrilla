import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueCertificateRequest } from "../agent-tools/common/ports";
import { type EmailEventRecord, applyEmailEvent } from "../channels/email/events";
import { CUSTOMER, OPS_MAILBOX, emailWorld } from "../channels/email/testing";
import { CLOCK, ISP, T0 } from "../connector/testing";
import type { Message } from "../domain/conversations";
import { certRetryTimerId, deliverCertificate, retryCertificateDelivery } from "./deliveries";
import { recordCertificateEmailEvent, recordCertificateMessageStatus } from "./delivery-events";
import { outcomeOf } from "./pipeline-sender";
import { createCertificatePort, inProcessCertificateWriter, lambdaCertificateWriter } from "./port";
import { CLOSED_AT, type CertWorld, memoryTimers, mx, policySender, scriptedG3, seedClosableOrder, testLogger, toolErrorOf, writerDeps } from "./testing";

const REQUEST: IssueCertificateRequest = { workOrderId: "wo-24817", ispId: ISP, clockId: CLOCK, closedBy: "CHANNEL", closedAtSim: CLOSED_AT, correlationId: "corr-certificate-0002" };
/** The installer's last message 25 h before the closing: his 24 h window is closed. */
const STALE_INBOUND = mx("2026-10-12 09:05");

let world: CertWorld;

function kit(options: { readonly g3?: ReturnType<typeof scriptedG3> } = {}) {
  const sender = policySender(world, T0);
  const timers = memoryTimers();
  const openBlockedCase = vi.fn(async () => undefined);
  const delivery = { connector: world.connector, sender, timers, brand: () => undefined, logger: testLogger(world.lines) };
  const port = createCertificatePort({ ...delivery, writer: inProcessCertificateWriter(writerDeps(world, options.g3 === undefined ? {} : { g3: options.g3 })), openBlockedCase });
  return { sender, timers, openBlockedCase, delivery, port };
}

async function deliveries() {
  return (await world.connector.workOrders.getCertificate("wo-24817"))?.deliveries ?? [];
}

function sesRecord(mailId: string, type: EmailEventRecord["type"], bounceType?: EmailEventRecord["bounceType"]): EmailEventRecord {
  return { type, providerMessageId: "0100019a2b3c4d5e-11111111-2222-3333-4444-555555555555-000000", atReal: "2026-10-13T13:00:05.000Z", ispId: ISP, clockId: CLOCK, mailId, kind: "CERTIFICATE_EMAIL", workOrderId: "wo-24817", ...(bounceType === undefined ? {} : { bounceType }) };
}

beforeEach(async () => {
  world = await emailWorld();
});

describe("certificate emails to the customer and the operations mailbox [FL-048]", () => {
  it("[FL-048] sends two CERTIFICATE_EMAIL with the PDF of WorkOrders/CERT attached and records both deliveries", async () => {
    await seedClosableOrder(world);
    const { port } = kit();
    const issued = await port.issue(REQUEST);

    expect(issued.deliveries).toEqual([
      { to: "CUSTOMER", channel: "EMAIL", status: "QUEUED" },
      { to: "OPS_MAILBOX", channel: "EMAIL", status: "QUEUED" },
      { to: "INSTALLER", channel: "WHATSAPP", status: "QUEUED" },
    ]);
    const outbox = await world.connector.conversations.listOutbox(ISP);
    expect(outbox.map((mail) => [mail.toRole, mail.to]).sort()).toEqual([["CUSTOMER", CUSTOMER], ["OPS_MAILBOX", OPS_MAILBOX]]);
    for (const mail of outbox) {
      expect(mail).toMatchObject({ kind: "CERTIFICATE_EMAIL", status: "SENT", from: "Cuadrilla · Actas <actas@cuadrilla.demo.craftech.io>", attachment: { fileName: "acta-24817.pdf", sha256: issued.sha256 } });
      expect(mail.subject).toContain("Orden 24817");
    }
    expect(world.sent()).toHaveLength(2);
    expect(world.sent()[0]?.Content?.Simple?.Attachments?.[0]).toMatchObject({ FileName: "acta-24817.pdf", ContentType: "application/pdf" });
    expect(await deliveries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ to: "CUSTOMER", channel: "EMAIL", status: "SENT", mailId: "mail-cert-wo-24817-1-customer" }),
        expect.objectContaining({ to: "OPS_MAILBOX", channel: "EMAIL", status: "SENT", mailId: "mail-cert-wo-24817-1-ops-mailbox" }),
      ]),
    );
  });

  it("[FL-048] moves a delivery to DELIVERED with its SES event, and never backwards", async () => {
    await seedClosableOrder(world);
    const { port, timers } = kit();
    await port.issue(REQUEST);
    const deps = { connector: world.connector, timers, simNow: async () => new Date(CLOSED_AT), logger: testLogger(world.lines) };
    const delivered = await recordCertificateEmailEvent(deps, await applyEmailEvent(world.connector, sesRecord("mail-cert-wo-24817-1-customer", "DELIVERY")));
    expect(delivered).toMatchObject({ recorded: true, effect: "NONE", delivery: { to: "CUSTOMER", status: "DELIVERED" } });
    const late = await recordCertificateEmailEvent(deps, await applyEmailEvent(world.connector, sesRecord("mail-cert-wo-24817-1-customer", "SEND")));
    expect(late.recorded).toBe(false);
    expect((await deliveries()).find((delivery) => delivery.to === "CUSTOMER")?.status).toBe("DELIVERED");
  });

  it("[FL-048] a transient bounce delays the delivery and arms one CERT_RETRY; a permanent one asks for CERTIFICATE_UNDELIVERED", async () => {
    await seedClosableOrder(world);
    const { port, timers } = kit();
    await port.issue(REQUEST);
    const deps = { connector: world.connector, timers, simNow: async () => new Date(mx("2026-10-13 10:10")), logger: testLogger(world.lines) };
    const delayed = await recordCertificateEmailEvent(deps, await applyEmailEvent(world.connector, sesRecord("mail-cert-wo-24817-1-customer", "BOUNCE", "Transient")));
    expect(delayed).toMatchObject({ effect: "CERT_RETRY_ARMED", delivery: { status: "DELAYED" } });
    expect(timers.armed).toEqual([expect.objectContaining({ kind: "CERT_RETRY", timerId: certRetryTimerId("wo-24817", "CUSTOMER"), dueAtSim: mx("2026-10-13 10:15"), payload: { to: "CUSTOMER" } })]);

    const bounced = await recordCertificateEmailEvent(deps, await applyEmailEvent(world.connector, sesRecord("mail-cert-wo-24817-1-ops-mailbox", "BOUNCE", "Permanent")));
    expect(bounced).toMatchObject({ effect: "CERTIFICATE_UNDELIVERED", delivery: { to: "OPS_MAILBOX", status: "BOUNCED" } });
  });

  it("[FL-048] the CERT_RETRY resends the delayed email once, with its own mail id", async () => {
    await seedClosableOrder(world);
    const { port, timers, delivery } = kit();
    await port.issue(REQUEST);
    const deps = { connector: world.connector, timers, simNow: async () => new Date(mx("2026-10-13 10:10")), logger: testLogger(world.lines) };
    await recordCertificateEmailEvent(deps, await applyEmailEvent(world.connector, sesRecord("mail-cert-wo-24817-1-customer", "BOUNCE", "Transient")));
    const timer = { home: { kind: "WORK_ORDER", id: "wo-24817" }, payload: timers.armed[0]?.payload };
    const resent = await retryCertificateDelivery(delivery, timer, { eventAtSim: mx("2026-10-13 10:15"), correlationId: "corr-retry-000001" });
    expect(resent).toEqual([expect.objectContaining({ attempted: true, retryArmed: false, delivery: expect.objectContaining({ to: "CUSTOMER", status: "SENT", mailId: "mail-cert-wo-24817-1-customer-r1" }) })]);
    expect(world.sent()).toHaveLength(3);
    // Nothing left to retry: a second firing sends nothing.
    expect(await retryCertificateDelivery(delivery, timer, { eventAtSim: mx("2026-10-13 10:20"), correlationId: "corr-retry-000002" })).toEqual([expect.objectContaining({ attempted: false })]);
    expect(world.sent()).toHaveLength(3);
  });

  it("records a missing operations mailbox as DENIED instead of guessing an address", async () => {
    await seedClosableOrder(world, { opsMailbox: null });
    const { port } = kit();
    await port.issue(REQUEST);
    expect((await deliveries()).find((delivery) => delivery.to === "OPS_MAILBOX")).toMatchObject({ status: "DENIED", detail: "NO_ADDRESS" });
    expect(world.sent()).toHaveLength(1);
  });
});

describe("certificate to the installer by WhatsApp [FL-049]", () => {
  it("[FL-049] the 'Cerrar instalación' tap is an inbound message: with the last one 25 h old, the certificate still goes as a document (ALLOW CP-WA-24H)", async () => {
    await seedClosableOrder(world, { lastInboundAtSim: STALE_INBOUND });
    // InboundWhatsApp records every inbound, the tap included, before it queues the BUTTON_ACTION.
    await world.connector.people.recordInbound("inst-rogelio", { atSim: CLOSED_AT });
    const { port, sender } = kit();
    await port.issue(REQUEST);
    const sends = sender.sent.filter((record) => record.send.channel === "WHATSAPP");
    expect(sends).toHaveLength(1);
    expect(sends[0]?.send).toMatchObject({ form: "DOCUMENT", document: { fileName: "acta-24817.pdf" }, inResponseToInbound: true });
    expect(sends[0]?.decision).toMatchObject({ outcome: "ALLOW" });
    expect(sends[0]?.decision?.ruleIds).toContain("CP-WA-24H");
    expect((await deliveries()).find((delivery) => delivery.to === "INSTALLER")).toMatchObject({ channel: "WHATSAPP", status: "SENT", detail: "DOCUMENT" });
  });

  it("[FL-049] closed by QA with no inbound in 25 h, the document is denied (CP-WA-24H) and the template acta_instalacion carries the PDF", async () => {
    await seedClosableOrder(world, { lastInboundAtSim: STALE_INBOUND });
    const { port, sender } = kit();
    await port.issue({ ...REQUEST, closedBy: "QA" });
    const sends = sender.sent.filter((record) => record.send.channel === "WHATSAPP");
    expect(sends.map((record) => [record.send.channel === "WHATSAPP" ? record.send.form : "", record.decision?.outcome])).toEqual([
      ["DOCUMENT", "DENY"],
      ["TEMPLATE", "ALLOW"],
    ]);
    expect(sends[0]?.decision?.deniedBy).toBe("CP-WA-24H");
    expect(sends[1]?.send).toMatchObject({ templateName: "acta_instalacion", templateParams: ["24817"], document: { fileName: "acta-24817.pdf" }, inResponseToInbound: false });
    expect((await deliveries()).find((delivery) => delivery.to === "INSTALLER")).toMatchObject({ status: "SENT", detail: "TEMPLATE acta_instalacion" });
  });

  it("[FL-049] a transient failure arms one CERT_RETRY; the retry that finds the window expired sends the template", async () => {
    await seedClosableOrder(world, { lastInboundAtSim: mx("2026-10-13 09:30") });
    const { port, sender, timers, delivery } = kit();
    sender.failNext = 3;
    await port.issue({ ...REQUEST, closedBy: "HARNESS" });
    expect((await deliveries()).every((entry) => entry.status === "FAILED")).toBe(true);
    expect(timers.armed.map((timer) => timer.timerId).sort()).toEqual(["cert-retry-wo-24817-customer", "cert-retry-wo-24817-installer", "cert-retry-wo-24817-ops-mailbox"]);
    const installerTimer = timers.armed.find((timer) => timer.timerId === "cert-retry-wo-24817-installer");
    const next = mx("2026-10-14 09:40");
    await retryCertificateDelivery(delivery, { home: { kind: "WORK_ORDER", id: "wo-24817" }, payload: installerTimer?.payload }, { eventAtSim: next, correlationId: "corr-retry-000003" });
    const retried = sender.sent.filter((record) => record.send.channel === "WHATSAPP").slice(-2);
    expect(retried.map((record) => [record.send.channel === "WHATSAPP" ? record.send.form : "", record.decision?.outcome])).toEqual([
      ["DOCUMENT", "DENY"],
      ["TEMPLATE", "ALLOW"],
    ]);
    expect(timers.armed).toHaveLength(3);
  });

  it("[FL-049] WhatsApp statuses of the certificate message move its delivery; a failure arms the retry", async () => {
    await seedClosableOrder(world);
    await world.connector.people.recordInbound("inst-rogelio", { atSim: CLOSED_AT });
    const { port, timers } = kit();
    await port.issue(REQUEST);
    const installer = (await deliveries()).find((entry) => entry.to === "INSTALLER");
    const message = { messageId: installer?.messageId ?? "", personId: "inst-rogelio", clockId: CLOCK, direction: "OUT", kind: "CERTIFICATE", workOrderId: "wo-24817", status: "DELIVERED" } as Message;
    const deps = { connector: world.connector, timers, simNow: async () => new Date(mx("2026-10-13 10:07")), logger: testLogger(world.lines) };
    expect(await recordCertificateMessageStatus(deps, message, "2026-10-13T13:00:09.000Z")).toMatchObject({ recorded: true, delivery: { status: "DELIVERED" } });
    expect(await recordCertificateMessageStatus(deps, { ...message, status: "SENT" }, "2026-10-13T13:00:10.000Z")).toMatchObject({ recorded: false });
    expect(await recordCertificateMessageStatus(deps, { ...message, kind: "REPLY" }, "2026-10-13T13:00:10.000Z")).toMatchObject({ recorded: false });
    expect(await recordCertificateMessageStatus(deps, { ...message, status: "FAILED" }, "2026-10-13T13:00:11.000Z")).toMatchObject({ recorded: true, effect: "CERT_RETRY_ARMED" });
    expect(timers.armed.map((timer) => timer.timerId)).toEqual(["cert-retry-wo-24817-installer"]);
  });

  it("[FL-049] never sends a delivery twice when the closing is retried", async () => {
    await seedClosableOrder(world);
    await world.connector.people.recordInbound("inst-rogelio", { atSim: CLOSED_AT });
    const { port, sender, delivery } = kit();
    await port.issue(REQUEST);
    const results = await deliverCertificate(delivery, { workOrderId: "wo-24817", atSim: CLOSED_AT, correlationId: "corr-again-000001", inResponseToInbound: true, attempt: "FIRST" });
    expect(results.every((result) => !result.attempted)).toBe(true);
    expect(sender.sent).toHaveLength(3);
  });
});

describe("the certificate port of close_installation [FL-047]", () => {
  it("[FL-053] a G3 block opens the OTHER case in the caller and answers POLICY_DENIED, with nothing delivered", async () => {
    await seedClosableOrder(world);
    const { port, openBlockedCase, sender } = kit({ g3: scriptedG3("BLOCK") });
    expect(await toolErrorOf(() => port.issue(REQUEST))).toMatchObject({ code: "POLICY_DENIED", reason: "G3_BLOCKED" });
    expect(openBlockedCase).toHaveBeenCalledWith(REQUEST);
    expect(sender.sent).toEqual([]);
  });

  it("[FL-047] invokes the linked CertificateWriter synchronously and maps its failures to UNAVAILABLE", async () => {
    const lambda = mockClient(LambdaClient);
    const client = new LambdaClient({ region: "us-east-1", credentials: { accessKeyId: "test", secretAccessKey: "test" } });
    const writer = lambdaCertificateWriter(client, () => "aws-cds-hackathon-poc-cuadrilla-poc-CertificateWriter");
    const ok = { ok: true, certificateId: "cert-wo-24817-1", n: 1, sha256: "a".repeat(64), s3Key: "certificates/wo-24817/acta-1.pdf", fileName: "acta-24817.pdf", issuedAtSim: CLOSED_AT, duplicate: false };
    lambda
      .on(InvokeCommand)
      .resolvesOnce({ StatusCode: 200, Payload: new TextEncoder().encode(JSON.stringify(ok)) as never })
      .resolvesOnce({ StatusCode: 200, FunctionError: "Unhandled", Payload: new TextEncoder().encode("{}") as never })
      .resolvesOnce({ StatusCode: 200, Payload: new TextEncoder().encode(JSON.stringify({ ok: true })) as never });
    expect(await writer.write(REQUEST)).toEqual(ok);
    const input = lambda.commandCalls(InvokeCommand)[0]?.args[0].input;
    expect(input).toMatchObject({ FunctionName: "aws-cds-hackathon-poc-cuadrilla-poc-CertificateWriter", InvocationType: "RequestResponse" });
    expect(JSON.parse(new TextDecoder().decode(input?.Payload as Uint8Array))).toEqual(REQUEST);
    expect(await toolErrorOf(() => writer.write(REQUEST))).toMatchObject({ code: "UNAVAILABLE", reason: "Unhandled" });
    expect(await toolErrorOf(() => writer.write(REQUEST))).toMatchObject({ code: "UNAVAILABLE", reason: "PAYLOAD" });
  });

  it("maps the pipeline's answers to delivery outcomes: only an unavailable channel is retried", () => {
    const email = { channel: "EMAIL", kind: "CERTIFICATE_EMAIL", clockId: CLOCK, ispId: ISP, workOrderId: "wo-24817", sentAtSim: CLOSED_AT, correlationId: "c-00000001", toRole: "CUSTOMER", to: CUSTOMER, subject: "s", bodyText: "b", attachment: { s3Key: "k", fileName: "acta-24817.pdf", sha256: "a".repeat(64) }, mailId: "mail-1" } as const;
    expect(outcomeOf(email, { status: "SENT", messageId: "mail-1" })).toEqual({ status: "SENT", mailId: "mail-1" });
    expect(outcomeOf(email, { status: "DEFERRED", messageId: "m", nextAllowedAt: CLOSED_AT, timerKey: "t" })).toEqual({ status: "DEFERRED", nextAllowedAt: CLOSED_AT });
    expect(outcomeOf(email, { status: "REFUSED", failure: { ok: false, error: { code: "UNAVAILABLE", message: "x", reason: "SEND_FAILED" } }, ruleIds: [] })).toEqual({ status: "FAILED", retryable: true, reason: "SEND_FAILED" });
    expect(outcomeOf(email, { status: "REFUSED", failure: { ok: false, error: { code: "RECIPIENT_NOT_ALLOWED", message: "x" } }, ruleIds: ["CP-RECIPIENT-FENCE"] })).toEqual({ status: "DENIED", ruleIds: ["CP-RECIPIENT-FENCE"], reason: "RECIPIENT_NOT_ALLOWED" });
  });
});
