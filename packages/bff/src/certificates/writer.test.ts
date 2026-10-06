import { ApplyGuardrailCommand, BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { certificateObjectKey } from "@cuadrilla/shared/media/keys";
import type { IssueCertificateRequest } from "../agent-tools/common/ports";
import { CUSTOMER, emailWorld } from "../channels/email/testing";
import { CLOCK, ISP } from "../connector/testing";
import { resolveBrand } from "../copy/brand";
import { handleCertificateWriter } from "../handlers/certificate-writer";
import { sha256Hex } from "../lib/crypto";
import { G3_SEPARATOR, bedrockG3 } from "./g3";
import { CLOSED_AT, CURP, CUSTOMER_PHONE, type CertWorld, EV_3, readPdf, scriptedG3, seedClosableOrder, toolErrorOf, writerDeps } from "./testing";
import { renderStoredCertificate, writeCertificate, writeCertificateResult } from "./writer";

const REQUEST: IssueCertificateRequest = { workOrderId: "wo-24817", ispId: ISP, clockId: CLOCK, closedBy: "CHANNEL", closedAtSim: CLOSED_AT, correlationId: "corr-certificate-0001" };
const KEY = certificateObjectKey(CLOCK, 1, "wo-24817", 1);
const PARTNER = { mode: "cobrand", partnerDisplayName: "Operadora Socia Demo", partnerShortName: "Socia Demo", logoAssetKeys: { onLight: "brand/logo-on-light.svg", onDark: "brand/logo-on-dark.svg" }, disclaimer: { es: "aviso", en: "notice" } } as const;

let world: CertWorld;

beforeEach(async () => {
  world = await emailWorld();
});

describe("CertificateWriter [FL-047]", () => {
  it("[FL-047] writes the PDF from the order, its sha256 in WorkOrders/CERT and closes the order", async () => {
    await seedClosableOrder(world);
    const deps = writerDeps(world);
    const written = await writeCertificate(deps, REQUEST);

    expect(written).toMatchObject({ ok: true, certificateId: "cert-wo-24817-1", n: 1, s3Key: KEY, fileName: "acta-24817.pdf", issuedAtSim: CLOSED_AT, duplicate: false });
    const pdf = world.objects.get(KEY);
    if (pdf === undefined) throw new Error("no PDF written");
    expect(sha256Hex(pdf)).toBe(written.sha256);
    const certificate = await world.connector.workOrders.getCertificate("wo-24817");
    expect(certificate).toMatchObject({ sha256: written.sha256, s3Key: KEY, issuedAtSim: CLOSED_AT, deliveries: [] });
    expect(certificate?.content).toMatchObject({ workOrderNumber: "24817", onuSerial: "DEMO3F2C19A0", rxPowerDbm: -21.4 });
    const order = await world.connector.workOrders.requireWorkOrder("wo-24817");
    expect(order).toMatchObject({ status: "CLOSED", closedAtSim: CLOSED_AT });
    expect(order.history.at(-1)).toMatchObject({ field: "status", to: "CLOSED", actor: "CHANNEL", reason: "CERTIFICATE_ISSUED" });

    const reading = await readPdf(pdf);
    for (const expected of ["24817", "DEMO3F2C19A0", "-21,4 dBm", "B+", "Rogelio Méndez"]) expect(reading.text).toContain(expected);
    expect(reading.text.match(/Validado|validado/g)?.length).toBeGreaterThanOrEqual(5);
    expect(reading.images).toBe(3);
  });

  it("[FL-047] answers the certificate it already wrote when the closing is retried, without writing again", async () => {
    await seedClosableOrder(world);
    const deps = writerDeps(world);
    const first = await writeCertificate(deps, REQUEST);
    const again = await writeCertificate(deps, REQUEST);
    expect(again).toEqual({ ...first, duplicate: true });
    expect(deps.objects.puts).toEqual([KEY]);
  });

  it("[FL-047] never writes the certificate of an incomplete checklist (NOT_COMPLETE with the items)", async () => {
    await seedClosableOrder(world);
    await world.connector.workOrders.updateChecklistItem("wo-24817", "ROSETTE_PHOTO", { status: "PENDING", evidenceId: null, validationId: null }, { actor: "QA" });
    const deps = writerDeps(world);
    const result = await writeCertificateResult(deps, REQUEST);
    expect(result).toMatchObject({ ok: false, code: "NOT_COMPLETE", reason: "ROSETTE_PHOTO" });
    expect(deps.objects.puts).toEqual([]);
    expect(await world.connector.workOrders.getCertificate("wo-24817")).toBeUndefined();
    expect((await world.connector.workOrders.requireWorkOrder("wo-24817")).status).toBe("IN_PROGRESS");
  });

  it("refuses an order of another world or operator, and an order that cannot close", async () => {
    await seedClosableOrder(world);
    const deps = writerDeps(world);
    expect((await toolErrorOf(() => writeCertificate(deps, { ...REQUEST, clockId: "GUEST#isp-guest-01", ispId: "isp-guest-01" }))).code).toBe("FORBIDDEN");
    await world.connector.workOrders.setStatus("wo-24817", "CANCELLED", { actor: "QA" });
    expect((await toolErrorOf(() => writeCertificate(deps, REQUEST))).code).toBe("INVALID");
  });

  it("leaves out a photo whose bytes are not its evidence's, and logs it", async () => {
    await seedClosableOrder(world);
    const evidence = await world.connector.workOrders.getEvidence("wo-24817", EV_3);
    world.objects.set(evidence?.s3Key ?? "", new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    const written = await writeCertificate(writerDeps(world), REQUEST);
    const reading = await readPdf(world.objects.get(written.s3Key) ?? new Uint8Array());
    expect(reading.images).toBe(2);
    expect(world.lines.some((line) => line.includes("certificate.photo_mismatch"))).toBe(true);
    const content = (await world.connector.workOrders.getCertificate("wo-24817"))?.content as { photos: unknown[] };
    expect(content.photos).toHaveLength(2);
  });

  it("[FL-047] carries the partner's brand line and the synthetic-demo notice in a co-branded world", async () => {
    await seedClosableOrder(world, { displayName: PARTNER.partnerDisplayName });
    const written = await writeCertificate(writerDeps(world, { brand: () => PARTNER }), REQUEST);
    const text = (await readPdf(world.objects.get(written.s3Key) ?? new Uint8Array())).text;
    const brand = resolveBrand(PARTNER);
    expect(text).toContain(brand.brandLine);
    expect(text).toContain(brand.disclaimer?.es ?? "missing");
  });
});

describe("masker and G3 over every field of the certificate [FL-053]", () => {
  it("[FL-053] the PDF text has no full phone, email, CURP nor RFC of the customer or of a supervisor's reason", async () => {
    const reason = `Llamé al cliente al ${CUSTOMER_PHONE} y a ${CUSTOMER}; CURP ${CURP}, RFC TREL800101AB1, tel 55 1234 5678`;
    await seedClosableOrder(world, { overrideReason: reason, addressLine: "Calle Jacaranda 214 (avisos a lucia.trevino@correo-ficticio.mx)" });
    const g3 = scriptedG3();
    const written = await writeCertificate(writerDeps(world, { g3 }), REQUEST);
    const text = (await readPdf(world.objects.get(written.s3Key) ?? new Uint8Array())).text;

    for (const leaked of [CUSTOMER_PHONE, "5509010421", CUSTOMER, "lucia.trevino@correo-ficticio.mx", CURP, "TREL800101AB1", "55 1234 5678"]) expect(text).not.toContain(leaked);
    expect(text).toContain("[TELEFONO]");
    expect(text).toContain("[CURP]");
    expect(text).toContain("[RFC]");
    expect(text).toContain("[EMAIL]");
    // The masker runs first: G3 gets every free-text field once, already masked.
    expect(g3.calls).toHaveLength(1);
    expect(g3.calls[0]?.join(" ")).not.toContain(CURP);
    expect(g3.calls[0]?.join(" ")).toContain("Rogelio Méndez");
    expect(world.lines.some((line) => line.includes(CURP) || line.includes(CUSTOMER_PHONE))).toBe(false);
  });

  it("[FL-053] a G3 block writes nothing and answers POLICY_DENIED / G3_BLOCKED", async () => {
    await seedClosableOrder(world);
    const deps = writerDeps(world, { g3: scriptedG3("BLOCK") });
    expect(await writeCertificateResult(deps, REQUEST)).toMatchObject({ ok: false, code: "POLICY_DENIED", reason: "G3_BLOCKED" });
    expect(deps.objects.puts).toEqual([]);
    expect((await world.connector.workOrders.requireWorkOrder("wo-24817")).status).toBe("IN_PROGRESS");
  });

  it("[FL-053] calls ApplyGuardrail once with the joined fields and splits the anonymized answer back", async () => {
    const runtime = mockClient(BedrockRuntimeClient);
    const client = new BedrockRuntimeClient({ region: "us-east-1", credentials: { accessKeyId: "test", secretAccessKey: "test" } });
    const g3 = bedrockG3(client, () => ({ id: "g3id", version: "3" }));
    const anonymized = { sensitiveInformationPolicy: { piiEntities: [{ type: "PHONE" as const, match: "x", action: "ANONYMIZED" as const, detected: true }], regexes: [] } };
    const blocked = { sensitiveInformationPolicy: { piiEntities: [{ type: "CREDIT_DEBIT_CARD_NUMBER" as const, match: "x", action: "BLOCKED" as const, detected: true }], regexes: [] } };
    runtime
      .on(ApplyGuardrailCommand)
      .resolvesOnce({ action: "NONE", outputs: [], assessments: [], usage: undefined })
      .resolvesOnce({ action: "GUARDRAIL_INTERVENED", outputs: [{ text: `Rogelio${G3_SEPARATOR}{PHONE}` }], assessments: [anonymized], usage: undefined })
      .resolvesOnce({ action: "GUARDRAIL_INTERVENED", outputs: [], assessments: [blocked], usage: undefined })
      .resolvesOnce({ action: "GUARDRAIL_INTERVENED", outputs: [{ text: "{PHONE}" }], assessments: [anonymized], usage: undefined })
      .rejectsOnce(Object.assign(new Error("slow down"), { name: "ThrottlingException" }));

    expect(await g3.apply(["Rogelio", "Lucía"])).toEqual({ action: "NONE", texts: ["Rogelio", "Lucía"] });
    expect(runtime.commandCalls(ApplyGuardrailCommand)[0]?.args[0].input).toMatchObject({ guardrailIdentifier: "g3id", guardrailVersion: "3", source: "OUTPUT", content: [{ text: { text: `Rogelio${G3_SEPARATOR}Lucía` } }] });
    expect(await g3.apply(["Rogelio", "55 1234 5678"])).toEqual({ action: "ANONYMIZED", texts: ["Rogelio", "{PHONE}"] });
    expect(await g3.apply(["4111 1111 1111 1111"])).toEqual({ action: "BLOCKED", entities: ["CREDIT_DEBIT_CARD_NUMBER"] });
    expect((await toolErrorOf(() => g3.apply(["a", "b"]))).reason).toBe("G3_SHAPE");
    expect(await toolErrorOf(() => g3.apply(["a"]))).toMatchObject({ code: "UNAVAILABLE", reason: "ThrottlingException" });
    expect((await toolErrorOf(() => g3.apply([`a${G3_SEPARATOR}b`]))).code).toBe("INVALID");
  });
});

describe("the CertificateWriter Lambda [FL-047]", () => {
  it("[FL-047] takes an IssueCertificateRequest and nothing else", async () => {
    await seedClosableOrder(world);
    const deps = () => writerDeps(world);
    expect(await handleCertificateWriter(deps, { ...REQUEST, extra: true })).toMatchObject({ ok: false, code: "INVALID" });
    expect(await handleCertificateWriter(deps, REQUEST)).toMatchObject({ ok: true, certificateId: "cert-wo-24817-1" });
  });
});

describe("historical certificates rendered by the world factory [FL-047]", () => {
  it("[FL-047] renders a stored content with the world's brand, fills sha256 and keeps the deliveries", async () => {
    await seedClosableOrder(world);
    const deps = writerDeps(world);
    await writeCertificate(deps, REQUEST);
    const stored = await world.connector.workOrders.getCertificate("wo-24817");
    if (stored === undefined) throw new Error("no certificate");
    await world.connector.workOrders.putCertificate({ workOrderId: "wo-24817", clockId: CLOCK, certificateId: stored.certificateId, n: 1, issuedAtSim: stored.issuedAtSim, content: stored.content ?? {}, pdfPending: true, synthetic: true, deliveries: [{ to: "CUSTOMER", channel: "EMAIL", status: "DELIVERED" }] });
    const pending = await world.connector.workOrders.getCertificate("wo-24817");
    if (pending === undefined) throw new Error("no certificate");

    const cobrand = resolveBrand(PARTNER);
    const rendered = await renderStoredCertificate({ connector: world.connector, objects: deps.objects, photo: async (photo) => world.objects.get((await world.connector.workOrders.getEvidence("wo-24817", photo.evidenceId))?.s3Key ?? ""), brand: cobrand, logger: deps.logger }, pending);
    expect(rendered).toMatchObject({ s3Key: KEY, synthetic: true, deliveries: [{ to: "CUSTOMER", status: "DELIVERED" }] });
    expect(rendered.pdfPending).toBeUndefined();
    expect(rendered.sha256).not.toBe(stored.sha256);
    expect(sha256Hex(world.objects.get(KEY) ?? new Uint8Array())).toBe(rendered.sha256);
    expect((await readPdf(world.objects.get(KEY) ?? new Uint8Array())).text).toContain(cobrand.brandLine);
  });
});
