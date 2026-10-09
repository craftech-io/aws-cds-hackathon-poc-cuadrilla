// Area F · Closing and the installation certificate (docs/flows-catalog.md FL-047 to FL-053), in process:
// the "Cerrar instalación" button through the installer queue (`close_installation` with `caller CHANNEL`)
// or the agent's call, the certificate writer in process (PDF, masking, `sha256`), its deliveries through
// the pipeline (SES with the simulator's events, WhatsApp document or template) and their outcomes.
import { describe, expect, it } from "vitest";
import { esMX } from "../../packages/bff/src/copy/es-MX";
import { readPdf } from "../../packages/bff/src/certificates/testing";
import { closeInstallation, outputOf, reply, search, citedReply } from "./support/agent";
import { createFlowWorld, type FlowWorld } from "./support/world";

const DONE = { status: "PASSED" } as const;
const ALL_PASSED = { ONU_ONLINE: DONE, POWER_READING_PHOTO: DONE, ONU_LABEL_PHOTO: DONE, ROSETTE_PHOTO: DONE, CUSTOMER_OK: DONE };

/** The installer on the order at `time`, its ONU online and the checklist as `checklist` says. */
async function ready(installerId: string, workOrderId: string, checklist: Record<string, { status: "PASSED" | "PENDING" }> = ALL_PASSED, time = "10:00"): Promise<FlowWorld> {
  const world = await createFlowWorld();
  await world.at(time);
  await world.data.worlds.setActiveWorkOrder(installerId, world.clockId, workOrderId, await world.simNow());
  await world.preset(workOrderId, { checklist, onu: { behaviour: "ONLINE_OK", fixed: true }, offer: { action: "CLOSE_INSTALLATION" } });
  return world;
}

async function certificatePdf(world: FlowWorld, workOrderId: string) {
  const certificate = await world.data.workOrders.getCertificate(workOrderId);
  const bytes = world.objects.bytesOf("Evidence", certificate?.s3Key ?? "");
  return { certificate, bytes, reading: bytes === undefined ? undefined : await readPdf(bytes) };
}

describe("closing flows", () => {
  it("[FL-047] the close button issues the certificate: PDF with the order, serial, power, five items and three photos; sha256 stored; order CLOSED", async () => {
    const world = await ready("inst-rogelio", "wo-24817");
    await world.tap("inst-rogelio", "CLOSE_INSTALLATION");
    expect(world.harness.turns).toHaveLength(0);
    expect((await world.data.workOrders.getWorkOrder("wo-24817"))?.status).toBe("CLOSED");
    const { certificate, bytes, reading } = await certificatePdf(world, "wo-24817");
    expect(bytes).toBeDefined();
    const { createHash } = await import("node:crypto");
    expect(createHash("sha256").update(bytes ?? new Uint8Array()).digest("hex")).toBe(certificate?.sha256);
    for (const fact of ["24817", "DEMO3F2C19A0", "dBm"]) expect(reading?.text).toContain(fact);
    expect(reading?.images).toBe(3);
    expect(world.network.requests.some((request) => request === "GET /v1/onus/DEMO3F2C19A0")).toBe(true);
  });

  it("[FL-048] the certificate goes by SES to the customer and to operations, inside the fence, and the deliveries are recorded", async () => {
    const world = await ready("inst-rogelio", "wo-24817");
    await world.tap("inst-rogelio", "CLOSE_INSTALLATION");
    const mails = world.ses.sent.filter((mail) => mail.tags.kind === "CERTIFICATE_EMAIL");
    expect(mails.map((mail) => mail.to).sort()).toEqual(["success+c10421@simulator.amazonses.com", "success+ops-demo@simulator.amazonses.com"]);
    expect(JSON.stringify(mails[0]?.input)).toContain("application/pdf");
    const outbox = (await world.data.conversations.listOutbox("isp-demo")).filter((mail) => mail.kind === "CERTIFICATE_EMAIL");
    expect(outbox.map((mail) => mail.status)).toEqual(mails.map(() => "DELIVERED"));
    const certificate = await world.data.workOrders.getCertificate("wo-24817");
    const emails = (certificate?.deliveries ?? []).filter((delivery) => delivery.channel === "EMAIL");
    expect(emails.map((delivery) => delivery.status)).toEqual(mails.map(() => "DELIVERED"));
  });

  it("[FL-049] (a) after the tap the window is open and the installer gets the PDF as a document", async () => {
    const world = await ready("inst-rogelio", "wo-24817");
    await world.tap("inst-rogelio", "CLOSE_INSTALLATION");
    const [document] = await world.delivered("inst-rogelio", "CERTIFICATE");
    expect(document?.content).toBe("DOCUMENT");
    expect(JSON.stringify(document)).toContain((await world.data.workOrders.getCertificate("wo-24817"))?.s3Key ?? "∅");
  });

  it("[FL-049] (b) closed without a recent inbound (25 h), the installer gets the acta_instalacion template with the document header", async () => {
    const world = await ready("inst-rogelio", "wo-24817", ALL_PASSED, "18:00");
    // Rogelio wrote last on 12/10 at 16:34 (the seed): at 13/10 18:00 his window closed 1 h 26 min ago.
    expect((await world.data.people.getPerson("inst-rogelio"))?.lastInboundAtSim).toBe("2026-10-12T16:34:00-06:00");
    const order = await world.data.workOrders.requireWorkOrder("wo-24817");
    const closed = await world.targets.cases.invoke("close_installation", { caller: { kind: "CHANNEL", ispId: "isp-demo", clockId: world.clockId, eventId: "qa-fl049b" }, outcome: "INSTALLED" }, { subject: { installerId: order.installerId, workOrderId: order.workOrderId } });
    await world.settle();
    expect(closed).toMatchObject({ ok: true, status: "CLOSED" });
    const [template] = await world.delivered("inst-rogelio", "CERTIFICATE");
    expect(template).toMatchObject({ content: "TEMPLATE", templateName: "acta_instalacion" });
  });

  it("[FL-050] (a) the close button with the rosette pending answers the fixed notice with what is missing, no certificate and no turn", async () => {
    const world = await ready("inst-rogelio", "wo-24817", { ...ALL_PASSED, ROSETTE_PHOTO: { status: "PENDING" } });
    await world.tap("inst-rogelio", "CLOSE_INSTALLATION");
    const notice = (await world.delivered("inst-rogelio", "SYSTEM_NOTICE")).at(-1);
    expect(notice?.refs?.items).toContain("ROSETTE_PHOTO");
    expect(notice?.text).toBe(esMX.closeNotComplete(["ROSETTE_PHOTO"]));
    expect(world.harness.turns).toHaveLength(0);
    expect(await world.data.workOrders.getCertificate("wo-24817")).toBeUndefined();
    expect((await world.data.workOrders.getWorkOrder("wo-24817"))?.status).not.toBe("CLOSED");
    expect(await world.data.conversations.listTurnNotes("inst-rogelio")).toEqual([]);
  });

  it("[FL-050] (b) asked in free text, close_installation answers NOT_COMPLETE and the agent says what is missing", async () => {
    const world = await ready("inst-rogelio", "wo-24817", { ...ALL_PASSED, ROSETTE_PHOTO: { status: "PENDING" } });
    world.plan({
      steps: [
        closeInstallation("INSTALLED"),
        reply("Todavía no se puede cerrar: falta la foto de la roseta.", { refs: (context) => ({ items: ((outputOf(context, "close_installation").missing ?? []) as string[]) }) }),
      ],
    });
    await world.text("inst-rogelio", "Ya terminé, cierra la instalación");
    expect(world.harness.turns[0]?.calls[0]?.output).toMatchObject({ ok: false, error: { code: "NOT_COMPLETE" }, missing: ["ROSETTE_PHOTO"] });
    expect((await world.delivered("inst-rogelio", "REPLY")).at(-1)?.refs?.items).toContain("ROSETTE_PHOTO");
    expect(await world.data.workOrders.getCertificate("wo-24817")).toBeUndefined();
  });

  it("[FL-051] a bounced certificate email opens one CERTIFICATE_UNDELIVERED case in the console only, with no resend", async () => {
    const world = await ready("inst-beatriz", "wo-24831", ALL_PASSED, "14:00");
    await world.tap("inst-beatriz", "CLOSE_INSTALLATION");
    const outbox = (await world.data.conversations.listOutbox("isp-demo")).filter((mail) => mail.kind === "CERTIFICATE_EMAIL" && mail.workOrderId === "wo-24831");
    expect(outbox.map((mail) => mail.status)).toContain("BOUNCED");
    const cases = await world.data.cases.listCasesOfWorkOrder("wo-24831");
    expect(cases.map((caseItem) => caseItem.reason)).toEqual(["CERTIFICATE_UNDELIVERED"]);
    expect(await world.delivered("sup-paola", "CASE_REQUEST")).toEqual([]);
    const bounced = world.ses.sent.filter((mail) => mail.to.startsWith("bounce+"));
    expect(bounced).toHaveLength(1);
    await world.advance({ byMinutes: 30 });
    expect(world.ses.sent.filter((mail) => mail.to.startsWith("bounce+"))).toHaveLength(1);
  });

  it("[FL-052] the customer is absent 15 minutes into the window: §COM-05 and a failed visit without certificate", async () => {
    const world = await ready("inst-karina", "wo-24822", { ONU_ONLINE: { status: "PENDING" } }, "15:15");
    world.plan({
      steps: [search("el cliente no está, nadie abre, visita fallida", "COM"), closeInstallation("FAILED_VISIT", "CUSTOMER_ABSENT"), citedReply(() => "Registré la visita fallida porque el cliente no está; la orden queda para reprogramar", "COM-05")],
    });
    await world.voice("inst-karina", "vn-11");
    expect(world.harness.turns[0]?.calls[1]?.output).toMatchObject({ ok: true, status: "FAILED_VISIT" });
    expect((await world.data.workOrders.getWorkOrder("wo-24822"))?.status).toBe("FAILED_VISIT");
    expect(await world.data.workOrders.getCertificate("wo-24822")).toBeUndefined();
    expect(world.ses.sent.filter((mail) => mail.tags.workOrderId === "wo-24822")).toEqual([]);
  });

  it("[FL-053] the certificate and the template parameters carry no full phone, email, CURP or RFC of the customer", async () => {
    const world = await ready("inst-karina", "wo-24821", ALL_PASSED, "12:00");
    await world.tap("inst-karina", "CLOSE_INSTALLATION");
    const { reading } = await certificatePdf(world, "wo-24821");
    const customer = await world.data.people.getCustomer("cust-10425");
    expect(reading?.text).toBeDefined();
    for (const secret of [customer?.phone, customer?.email].filter((value): value is string => value !== undefined)) expect(reading?.text).not.toContain(secret);
    expect(reading?.text).not.toMatch(/[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z0-9]\d/);
    expect(reading?.text).not.toMatch(/\+52\d{10}/);
    const params = (await world.thread("inst-karina")).flatMap((message) => message.templateParams ?? []);
    for (const param of params) expect(param).not.toMatch(/@|\+52\d{10}|[A-Z]{4}\d{6}[HM]/);
  });
});
