import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { MessageRejected, SendEmailCommand, TooManyRequestsException } from "@aws-sdk/client-sesv2";
import { mockClient } from "aws-sdk-client-mock";
import { describe, expect, it } from "vitest";
import { EMAIL_SENDER_NAMES } from "../../copy/es-MX-documents";
import { toSendToolFailure } from "../adapter";
import { MAX_ATTACHMENT_BYTES, loadCertificatePdf, s3AttachmentReader } from "./attachments";
import { applyEmailEvent } from "./events";
import { encodeWords } from "./mime";
import { CASE_ID, CUSTOMER, DEMO_MAILBOX, OPS_MAILBOX, PDF, PDF_KEY, PDF_SHA, ZONE_CHIEF, alertRequest, certificateRequest, emailWorld } from "./testing";

const JUDGE = "JUDGE#isp-judge-07";
const QA = "qa-812-1-sc11-fence";

describe("certificate emails [FL-048]", () => {
  it("[FL-048] sends the certificate to the customer and the operations mailbox from actas@, with the PDF attached", async () => {
    const world = await emailWorld({ messageIds: ["ses-msg-customer", "ses-msg-ops"] });
    const customer = await world.client.send(certificateRequest(world.clockId));
    const ops = await world.client.send(certificateRequest(world.clockId, { to: OPS_MAILBOX, toRole: "OPS_MAILBOX" }));
    expect(customer).toMatchObject({ ok: true, mailId: "mail-test-001", providerMessageId: "ses-msg-customer", duplicate: false });
    expect(ops).toMatchObject({ ok: true, mailId: "mail-test-002", providerMessageId: "ses-msg-ops" });

    const [first, second] = world.sent();
    expect(first?.FromEmailAddress).toBe(`${encodeWords(EMAIL_SENDER_NAMES.certificates)} <actas@cuadrilla.demo.craftech.io>`);
    expect(first?.Destination).toEqual({ ToAddresses: [CUSTOMER] });
    expect(second?.Destination).toEqual({ ToAddresses: [OPS_MAILBOX] });
    expect(first?.ConfigurationSetName).toBe("aws-cds-hackathon-poc-cuadrilla-email-poc");
    expect(first?.Content?.Simple?.Headers).toEqual([{ Name: "X-Cuadrilla-Mail-Id", Value: "mail-test-001" }]);
    const attachment = first?.Content?.Simple?.Attachments?.[0];
    expect(attachment).toMatchObject({ FileName: "acta-24817.pdf", ContentType: "application/pdf", ContentDisposition: "ATTACHMENT", ContentTransferEncoding: "BASE64" });
    expect(Buffer.from(attachment?.RawContent ?? new Uint8Array()).equals(Buffer.from(PDF))).toBe(true);
    expect(first?.Content?.Simple?.Subject?.Data).toMatch(/^Acta de instalación · Orden 24817 · /);
    expect(first?.EmailTags).toEqual(expect.arrayContaining([{ Name: "workOrderId", Value: "wo-24817" }, { Name: "mailId", Value: "mail-test-001" }]));
  });

  it("[FL-048] records each email in the outbox as it left and keeps the world busy until SES answers", async () => {
    const world = await emailWorld();
    const request = certificateRequest(world.clockId);
    await world.client.send(request);
    const outbox = await world.connector.conversations.listOutbox(world.ispId);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      mailId: "mail-test-001",
      kind: "CERTIFICATE_EMAIL",
      toRole: "CUSTOMER",
      to: CUSTOMER,
      from: "Cuadrilla · Actas <actas@cuadrilla.demo.craftech.io>",
      subject: request.subject,
      bodyText: request.bodyText,
      attachment: { s3Key: PDF_KEY, fileName: "acta-24817.pdf", contentType: "application/pdf" },
      status: "SENT",
      // The connector stores every instant in UTC.
      sentAtSim: "2026-10-13T16:05:00.000Z",
    });
    expect((await world.connector.worlds.listPendingMail(world.clockId)).open.map((mail) => mail.mailId)).toEqual(["mail-test-001"]);
    expect(world.capUsed()).toBe(1);
    expect(world.lines.join("\n")).not.toContain(CUSTOMER);
  });

  it("[FL-048] never sends the same email twice for the same id, and never bytes other than the issued certificate", async () => {
    const world = await emailWorld();
    const first = await world.client.send(certificateRequest(world.clockId, { mailId: "mail-cert-24817-customer" }));
    const again = await world.client.send(certificateRequest(world.clockId, { mailId: "mail-cert-24817-customer" }));
    expect(again).toMatchObject({ ok: true, duplicate: true, mailId: "mail-cert-24817-customer" });
    expect(first.ok && again.ok && again.providerMessageId === first.providerMessageId).toBe(true);
    world.objects.set(PDF_KEY, new TextEncoder().encode("%PDF-1.7\n% another document\n"));
    expect(await world.client.send(certificateRequest(world.clockId))).toMatchObject({ ok: false, code: "INVALID", retryable: false });
    expect(world.sent()).toHaveLength(1);
    expect(world.capUsed()).toBe(1);
  });

  it("[FL-048] reports a throttled SES as retryable, marks the row FAILED, closes the pending mark and gives the cap back", async () => {
    const world = await emailWorld();
    world.ses.on(SendEmailCommand).rejects(new TooManyRequestsException({ message: "slow down", $metadata: {} }));
    const outcome = await world.client.send(certificateRequest(world.clockId));
    expect(outcome).toEqual({ ok: false, code: "UNAVAILABLE", reason: "TooManyRequestsException", retryable: true });
    expect((await world.connector.conversations.listOutbox(world.ispId))[0]?.status).toBe("FAILED");
    expect((await world.connector.worlds.listPendingMail(world.clockId)).open).toEqual([]);
    expect(world.capUsed()).toBe(0);
    world.ses.on(SendEmailCommand).rejects(new MessageRejected({ message: "rejected", $metadata: {} }));
    expect(await world.client.send(certificateRequest(world.clockId))).toMatchObject({ ok: false, code: "UNAVAILABLE", reason: "MessageRejected", retryable: false });
  });

  it("[FL-048] a resend of the same mailId after a throttled send starts over: QUEUED, SENT, the world busy again and SES's events apply", async () => {
    const world = await emailWorld();
    const mailId = "mail-cert-24817-customer";
    world.ses.on(SendEmailCommand).rejects(new TooManyRequestsException({ message: "slow down", $metadata: {} }));
    expect(await world.client.send(certificateRequest(world.clockId, { mailId }))).toMatchObject({ ok: false, retryable: true });
    expect((await world.connector.conversations.findMail(world.ispId, mailId))?.status).toBe("FAILED");
    world.ses.on(SendEmailCommand).resolves({ MessageId: "ses-ok" });
    const resent = await world.client.send(certificateRequest(world.clockId, { mailId }));
    expect(resent).toMatchObject({ ok: true, mailId, providerMessageId: "ses-ok", duplicate: false, mail: { status: "SENT" } });
    expect(await world.connector.conversations.listOutbox(world.ispId)).toHaveLength(1);
    expect((await world.connector.worlds.listPendingMail(world.clockId)).open.map((mail) => [mail.mailId, mail.status])).toEqual([[mailId, "OPEN"]]);
    expect(world.capUsed()).toBe(1);
    const delivery = await applyEmailEvent(world.connector, { type: "DELIVERY", providerMessageId: "ses-ok", atReal: "2026-10-13T16:05:03.000Z", ispId: world.ispId, clockId: world.clockId, mailId, kind: "CERTIFICATE_EMAIL", workOrderId: "wo-24817" });
    expect(delivery).toMatchObject({ applied: true, previous: "SENT", status: "DELIVERED", changed: true, deliveryStatus: "DELIVERED" });
    expect((await world.connector.worlds.listPendingMail(world.clockId)).open).toEqual([]);
    expect(await world.client.send(certificateRequest(world.clockId, { mailId }))).toMatchObject({ ok: true, duplicate: true, providerMessageId: "ses-ok" });
  });

  it("[FL-048] refuses a request that does not describe a certificate email", async () => {
    const world = await emailWorld();
    expect(await world.client.send(certificateRequest(world.clockId, { attachment: undefined }))).toMatchObject({ ok: false, code: "INVALID", reason: "REQUEST" });
    expect(await world.client.send(certificateRequest(world.clockId, { toRole: "ZONE_CHIEF" }))).toMatchObject({ ok: false, code: "INVALID" });
    expect(await world.client.send({ ...certificateRequest(world.clockId), extra: true } as never)).toMatchObject({ ok: false, code: "INVALID" });
    expect(await world.client.send(certificateRequest(world.clockId, { subject: "Acta\r\nBcc: otro@simulator.amazonses.com" }))).toMatchObject({ ok: false, code: "INVALID", reason: "CONTENT" });
    expect(world.sent()).toEqual([]);
  });
});

describe("zone chief alerts [FL-061]", () => {
  it("[FL-061] sends the alert from avisos@ with the console link of its case as the only link", async () => {
    const world = await emailWorld();
    const outcome = await world.client.send(alertRequest(world.clockId));
    expect(outcome).toMatchObject({ ok: true });
    const [input] = world.sent();
    expect(input?.FromEmailAddress).toBe(`${encodeWords(EMAIL_SENDER_NAMES.alerts)} <avisos@cuadrilla.demo.craftech.io>`);
    expect(input?.Destination).toEqual({ ToAddresses: [ZONE_CHIEF] });
    expect(input?.Content?.Simple?.Attachments).toBeUndefined();
    const url = `https://cuadrilla.demo.craftech.io/app/cases/${CASE_ID}`;
    expect(input?.Content?.Simple?.Body?.Text?.Data).toContain(url);
    expect(input?.Content?.Simple?.Body?.Html?.Data).toContain(`<a href="${url}">${url}</a>`);
    expect(input?.EmailTags).toEqual(expect.arrayContaining([{ Name: "kind", Value: "ZONE_CHIEF_ALERT" }, { Name: "workOrderId", Value: "wo-24819" }]));
  });

  it("[FL-061] never lets a summary carry another link, an address or markup", async () => {
    const world = await emailWorld();
    const base = alertRequest(world.clockId);
    for (const extra of ["Mira https://otro-sitio.mx/ayuda", "Escribe a soporte@correo-cualquiera.mx", `Otro caso: https://cuadrilla.demo.craftech.io/app/cases/case-01J9ZQX0000000000000000001`]) {
      expect(await world.client.send({ ...base, bodyText: `${base.bodyText}\n${extra}` })).toMatchObject({ ok: false, code: "INVALID", reason: "CONTENT" });
    }
    await world.client.send({ ...base, bodyText: `${base.bodyText}\n<script>alert(1)</script>` });
    expect(world.sent().at(-1)?.Content?.Simple?.Body?.Html?.Data).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(world.sent()).toHaveLength(1);
  });
});

describe("recipient fence inside the client [FL-076]", () => {
  it("[FL-076] denies a recipient outside the world's fence before SES, audited, with no outbox row or pending mark", async () => {
    const world = await emailWorld({ clockId: JUDGE });
    const outcome = await world.client.send(certificateRequest(world.clockId, { to: DEMO_MAILBOX, workOrderId: "wo-24817-j07" }));
    expect(outcome).toEqual({ ok: false, code: "RECIPIENT_NOT_ALLOWED", reason: "DEMO_RECIPIENT_OUTSIDE_DEMO_WORLD", retryable: false });
    expect(outcome.ok ? undefined : toSendToolFailure(outcome)).toEqual({ ok: false, error: { code: "RECIPIENT_NOT_ALLOWED", message: "the recipient is outside this world's fence", reason: "DEMO_RECIPIENT_OUTSIDE_DEMO_WORLD" } });
    expect(world.sent()).toEqual([]);
    expect(await world.connector.conversations.listOutbox(world.ispId)).toEqual([]);
    expect((await world.connector.worlds.listPendingMail(world.clockId)).open).toEqual([]);
    const denials = await world.connector.audit.listByDecision(world.ispId, "DENY");
    expect(denials).toHaveLength(1);
    expect(denials[0]).toMatchObject({ action: "SEND_EMAIL", ruleIds: ["CP-RECIPIENT-FENCE"], reason: "DEMO_RECIPIENT_OUTSIDE_DEMO_WORLD", refs: { workOrderId: "wo-24817-j07", mailId: "mail-test-001" } });
    expect(JSON.stringify(denials[0])).not.toContain(DEMO_MAILBOX);
  });

  it("[FL-076] admits the registered demo mailbox in the operator's demo world, and never our own domain", async () => {
    const world = await emailWorld();
    expect(await world.client.send(certificateRequest(world.clockId, { to: DEMO_MAILBOX, toRole: "OPS_MAILBOX" }))).toMatchObject({ ok: true });
    expect(await world.client.send(certificateRequest(world.clockId, { to: "actas@cuadrilla.demo.craftech.io" }))).toMatchObject({ ok: false, code: "RECIPIENT_NOT_ALLOWED", reason: "OWN_DOMAIN" });
    expect(world.sent().map((input) => input.Destination?.ToAddresses)).toEqual([[DEMO_MAILBOX]]);
  });

  it("[FL-076] respects the world's email cap per real day, audited, and frees it the next day", async () => {
    const world = await emailWorld({ clockId: JUDGE, emailsPerDay: 2 });
    const send = () => world.client.send(certificateRequest(world.clockId, { workOrderId: "wo-24817-j07" }));
    expect((await send()).ok).toBe(true);
    expect((await send()).ok).toBe(true);
    expect(await send()).toEqual({ ok: false, code: "CAP_REACHED", reason: "SIMULATOR", retryable: false, resetsAtReal: "2026-10-14T00:00:00.000Z" });
    expect(world.sent()).toHaveLength(2);
    expect(await world.connector.audit.listByDecision(world.ispId, "DENY")).toEqual([expect.objectContaining({ action: "SEND_EMAIL", reason: "CAP_REACHED", ruleIds: [] })]);
    world.store.advance(24 * 3_600_000);
    expect((await send()).ok).toBe(true);
  });

  it("[FL-076] probes the fence of a QA world without sending, auditing every denial", async () => {
    const world = await emailWorld({ clockId: QA });
    const decisions = await world.client.probe(world.clockId, [CUSTOMER, DEMO_MAILBOX, "avisos@cuadrilla.demo.craftech.io", "a@example.com", "success@simulator.amazonses.com.attacker.example"], "QA");
    expect(decisions.map((decision) => (decision.allowed ? decision.recipientClass : decision.reason))).toEqual(["SES_SIMULATOR", "DEMO_RECIPIENT_OUTSIDE_DEMO_WORLD", "OWN_DOMAIN", "RESERVED_DOMAIN", "RESERVED_DOMAIN"]);
    expect(world.sent()).toEqual([]);
    const denials = await world.connector.audit.listByDecision(world.ispId, "DENY");
    expect(denials.map((denial) => [denial.action, denial.reason])).toEqual([
      ["FENCE_PROBE", "DEMO_RECIPIENT_OUTSIDE_DEMO_WORLD"],
      ["FENCE_PROBE", "OWN_DOMAIN"],
      ["FENCE_PROBE", "RESERVED_DOMAIN"],
      ["FENCE_PROBE", "RESERVED_DOMAIN"],
    ]);
  });
});

describe("certificate attachment", () => {
  const s3Client = new S3Client({ region: "us-east-1", credentials: { accessKeyId: "test", secretAccessKey: "test" } });
  const s3 = mockClient(s3Client);
  const body = (bytes: Uint8Array) => ({ transformToByteArray: async () => bytes }) as never;
  const reader = s3AttachmentReader(s3Client, "evidence-bucket");

  it("reads the PDF of the Evidence bucket and checks it is the certificate that was issued", async () => {
    s3.reset();
    s3.on(GetObjectCommand, { Bucket: "evidence-bucket", Key: PDF_KEY }).resolves({ ContentLength: PDF.byteLength, Body: body(PDF) });
    expect(await loadCertificatePdf(reader, { s3Key: PDF_KEY, fileName: "acta-24817.pdf", sha256: PDF_SHA })).toEqual(PDF);
    await expect(loadCertificatePdf(reader, { s3Key: PDF_KEY, fileName: "acta-24817.pdf", sha256: "0".repeat(64) })).rejects.toMatchObject({ code: "INVALID" });
  });

  it("refuses an object that is too large or not a PDF, and reports an unreadable one as retryable", async () => {
    s3.reset();
    s3.on(GetObjectCommand, { Key: "big.pdf" }).resolves({ ContentLength: MAX_ATTACHMENT_BYTES + 1, Body: body(PDF) });
    s3.on(GetObjectCommand, { Key: "note.txt" }).resolves({ ContentLength: 4, Body: body(new TextEncoder().encode("hola")) });
    s3.on(GetObjectCommand, { Key: "missing.pdf" }).rejects(new Error("NoSuchKey"));
    await expect(loadCertificatePdf(reader, { s3Key: "big.pdf", fileName: "acta-24817.pdf" })).rejects.toMatchObject({ code: "INVALID", retryable: false });
    await expect(loadCertificatePdf(reader, { s3Key: "note.txt", fileName: "acta-24817.pdf" })).rejects.toMatchObject({ code: "INVALID" });
    await expect(loadCertificatePdf(reader, { s3Key: "missing.pdf", fileName: "acta-24817.pdf" })).rejects.toMatchObject({ code: "UNAVAILABLE", retryable: true });
  });
});
