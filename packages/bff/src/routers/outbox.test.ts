import { TRPCError } from "@trpc/server";
import { describe, expect, it } from "vitest";
import { DEMO, GUEST_07 } from "../services/people/testing";
import { type ConsoleTestWorld, consoleTestWorld } from "./console-testing";

async function sendCertificateMail(t: ConsoleTestWorld, mailId: string): Promise<void> {
  await t.memory.connector.conversations.appendMail({
    mailId,
    ispId: t.world.ispId,
    clockId: t.world.clockId,
    kind: "CERTIFICATE_EMAIL",
    toRole: "CUSTOMER",
    to: "success+c10421@simulator.amazonses.com",
    from: "Cuadrilla · Actas <actas@cuadrilla.demo.craftech.io>",
    subject: "Acta de instalación · Orden 24817",
    bodyText: "Hola Lucía,\nadjuntamos el acta de tu instalación.",
    workOrderId: t.world.ids.order,
    attachment: { s3Key: "certificates/wo-24817/acta-1.pdf", fileName: "acta-24817.pdf", contentType: "application/pdf", sha256: "3".repeat(64) },
    status: "DELIVERED",
    events: [
      { type: "SEND", atReal: "2026-11-02T18:00:01.000Z" },
      { type: "DELIVERY", atReal: "2026-11-02T18:00:03.000Z" },
    ],
    sentAtSim: "2026-10-13T10:05:00-06:00",
    sentAtReal: "2026-11-02T18:00:00.000Z",
  });
}

describe("outbox router [FL-090]", () => {
  it("[FL-090] lists every email as it left with its SES events, the address masked", async () => {
    const t = await consoleTestWorld(DEMO);
    await sendCertificateMail(t, "mail-0001");
    const list = await (await t.as("OPS", "usr-ops")).outbox.list();
    expect(list).toEqual([
      expect.objectContaining({ mailId: "mail-0001", kind: "CERTIFICATE_EMAIL", toRole: "CUSTOMER", status: "DELIVERED", hasAttachment: true, sentAtSim: "2026-10-13T10:05:00-06:00", events: [expect.objectContaining({ type: "SEND" }), expect.objectContaining({ type: "DELIVERY" })] }),
    ]);
    expect(list[0]?.to).not.toContain("success+c10421");
  });

  it("[FL-090] one email in plain text and its PDF by a 5-minute download link; another world's email is not found", async () => {
    const demo = await consoleTestWorld(DEMO);
    const guest = await consoleTestWorld(GUEST_07, demo);
    await sendCertificateMail(demo, "mail-0002");
    const mail = await (await demo.as()).outbox.get({ mailId: "mail-0002" });
    expect(mail.bodyText).toBe("Hola Lucía,\nadjuntamos el acta de tu instalación.");
    expect(mail.attachment).toMatchObject({ fileName: "acta-24817.pdf", sha256: "3".repeat(64) });
    expect(mail.attachment?.url).toContain("/s3/Evidence/certificates/wo-24817/acta-1.pdf");
    expect(mail.attachment?.url).toContain("response-content-disposition=attachment");
    const error = await (await guest.as()).outbox.get({ mailId: "mail-0002" }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect((error as TRPCError).code).toBe("NOT_FOUND");
    expect(await (await guest.as()).outbox.list()).toEqual([]);
  });
});
