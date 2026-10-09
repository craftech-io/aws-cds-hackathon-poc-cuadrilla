// The certificate and the emails of the main story in a capture world (docs/landing-spec.md §6.2): when
// the story reaches "Cerrar instalación", order 24817 is closed by the product's own certificate writer
// (packages/bff/src/certificates/writer.ts: content from the order, the validated photos the scene
// seeded, the PDF in `Evidence`) and delivered by its own deliveries (deliveries.ts: the customer's and
// the operations mailbox's emails with the texts of copy/, the document to the installer), through a
// sender that stores what the pipeline would have sent instead of calling SES or WhatsApp; when it
// reaches the safety report, the zone chief's alert is stored with the texts of copy/ the same way. The
// guardrail of the certificate (G3) passes the content as it is: the world is synthetic, and the capture
// never reaches Bedrock.
import { renderDocument } from "../../packages/bff/src/channels/whatsapp/render";
import { storedPayload } from "../../packages/bff/src/channels/whatsapp/transport";
import { senderOf } from "../../packages/bff/src/channels/email/config";
import { deliverCertificate } from "../../packages/bff/src/certificates/deliveries";
import type { CertificateSend, CertificateSendOutcome, CertificateSender } from "../../packages/bff/src/certificates/sender";
import { writeCertificate } from "../../packages/bff/src/certificates/writer";
import { resolveBrand } from "../../packages/bff/src/copy/brand";
import { esMX } from "../../packages/bff/src/copy/es-MX";
import { zoneChiefSafetyAlert } from "../../packages/bff/src/copy/es-MX-documents";
import type { EmailKind } from "../../packages/bff/src/domain/conversations";
import { sha256Hex } from "../../packages/bff/src/lib/crypto";
import { createLogger } from "../../packages/bff/src/lib/log";
import type { MemoryObjects } from "../../packages/bff/src/routers/console-testing";
import { storyEntry } from "../../packages/bff/src/story/main-story";
import type { StoryEntry } from "../../packages/bff/src/story/types";
import { type StoryWorld, storyIds } from "./story-thread";

/** The product's own domain: the senders of its emails (`actas@`, `avisos@`), shown as they left. */
export const CAPTURE_EMAIL_DOMAIN = "cuadrilla.demo.craftech.io";

export interface MailWorld extends StoryWorld {
  readonly objects: Pick<MemoryObjects, "put" | "get">;
  /** Real clock of the capture world. */
  readonly now: () => Date;
}

const LOG = createLogger({ level: "warn", bindings: { service: "landing-capture" } });
const NEUTRAL = { mode: "neutral" } as const;
const CORRELATION = "landing-capture";

function fromOf(kind: EmailKind): string {
  const sender = senderOf(kind, CAPTURE_EMAIL_DOMAIN);
  return `${sender.name} <${sender.address}>`;
}

function delivered(world: MailWorld) {
  const atReal = world.now().toISOString();
  return { status: "DELIVERED" as const, events: [{ type: "SEND" as const, atReal }, { type: "DELIVERY" as const, atReal }], sentAtReal: atReal };
}

/** What the outbound pipeline would have stored for each send of the certificate, sent at once. */
function storingSender(world: MailWorld): CertificateSender {
  return {
    async send(request: CertificateSend): Promise<CertificateSendOutcome> {
      if (request.channel === "EMAIL") {
        await world.connector.conversations.appendMail({
          mailId: request.mailId,
          ispId: request.ispId,
          clockId: request.clockId,
          kind: request.kind,
          toRole: request.toRole,
          to: request.to,
          from: fromOf(request.kind),
          subject: request.subject,
          bodyText: request.bodyText,
          workOrderId: request.workOrderId,
          attachment: { ...request.attachment, contentType: "application/pdf" },
          sentAtSim: request.sentAtSim,
          ...delivered(world),
        });
        return { status: "SENT", mailId: request.mailId };
      }
      const person = await world.connector.people.requirePerson(request.personId);
      if (person.phone === undefined) throw new Error(`${request.personId} has no phone in the capture world`);
      const messageId = `msg-${request.idempotencyKey}`;
      const payload = renderDocument(person.phone, `sim-s3:Evidence:${request.document.s3Key}`, request.document.fileName);
      await world.connector.conversations.appendMessage({
        messageId,
        personId: request.personId,
        ispId: request.ispId,
        clockId: request.clockId,
        direction: "OUT",
        channel: "WHATSAPP",
        content: "DOCUMENT",
        kind: "CERTIFICATE",
        workOrderId: request.workOrderId,
        text: request.document.fileName,
        status: "READ",
        author: "SYSTEM",
        simulated: true,
        transport: "simulated",
        providerMessageId: `wamid.SIM.${sha256Hex(`${request.clockId}/${messageId}`).slice(0, 32)}`,
        sentAtSim: request.sentAtSim,
        refs: { seeded: true, story: "s4-certificate", whatsapp: storedPayload(payload) },
        seeded: true,
      });
      return { status: "SENT", messageId };
    },
  };
}

/** Closes order 24817 with its certificate and delivers it, as the installer's "Cerrar instalación" does. */
export async function issueStoryCertificate(world: MailWorld): Promise<void> {
  const entry = storyEntry("s4-certificate");
  const workOrderId = storyIds(world.ispId).order(entry.workOrderNumber);
  const objects = {
    async readPhoto(key: string) {
      const blob = await world.objects.get("Evidence", key);
      if (blob === undefined) throw new Error(`the scene did not seed the evidence photo ${key}`);
      return blob.bytes;
    },
    async putPdf(key: string, bytes: Uint8Array) {
      world.objects.put("Evidence", key, bytes, "application/pdf");
    },
  };
  const g3 = { apply: async (texts: readonly string[]) => ({ action: "NONE" as const, texts }) };
  await writeCertificate(
    { connector: world.connector, objects, g3, brand: () => NEUTRAL, logger: LOG },
    { workOrderId, ispId: world.ispId, clockId: world.clockId, closedBy: "CHANNEL", closedAtSim: entry.atSim, correlationId: CORRELATION },
  );
  await deliverCertificate(
    { connector: world.connector, sender: storingSender(world), timers: { arm: async () => Promise.reject(new Error("every send of a capture is stored at once: no delivery is retried")) }, brand: () => NEUTRAL, logger: LOG },
    { workOrderId, atSim: entry.atSim, correlationId: CORRELATION, inResponseToInbound: true, attempt: "FIRST" },
  );
}

/** The zone chief's email of the safety sequence (S6), with the texts of copy/ and the neutral brand. */
export async function sendStoryZoneChiefAlert(world: MailWorld): Promise<void> {
  const entry = storyEntry("s6-zone-chief-email");
  if (entry.kind !== "DOCUMENT" || entry.document.kind !== "ZONE_CHIEF_ALERT") throw new Error("s6-zone-chief-email is the zone chief's alert");
  const ref = entry.document;
  const ids = storyIds(world.ispId);
  const chief = await world.connector.people.requirePerson(ids.person("zc-marisol"));
  if (chief.email === undefined) throw new Error(`${chief.personId} has no mailbox in the capture world`);
  const hazard = esMX.hazard[ref.hazard];
  const text = zoneChiefSafetyAlert({
    brand: resolveBrand(NEUTRAL),
    workOrderNumber: ref.workOrderNumber,
    zoneName: ref.zoneName,
    zoneChiefFirstName: chief.firstName,
    installerFirstName: ref.installerFirstName,
    reasonText: hazard,
    summary: hazard,
    caseUrl: "/app/cases",
    atText: ref.atText,
  });
  await world.connector.conversations.appendMail({
    mailId: `mail-story-${entry.id}`,
    ispId: world.ispId,
    clockId: world.clockId,
    kind: "ZONE_CHIEF_ALERT",
    toRole: "ZONE_CHIEF",
    to: chief.email,
    from: fromOf("ZONE_CHIEF_ALERT"),
    subject: text.subject,
    bodyText: text.body,
    workOrderId: ids.order(ref.workOrderNumber),
    sentAtSim: entry.atSim,
    ...delivered(world),
  });
}

/** The certificate and the emails of `entries` (sceneStory). */
export async function seedStoryMail(world: MailWorld, entries: readonly StoryEntry[]): Promise<void> {
  const ids = new Set(entries.map((entry) => entry.id));
  if (ids.has("s4-certificate")) await issueStoryCertificate(world);
  if (ids.has("s6-zone-chief-email")) await sendStoryZoneChiefAlert(world);
}

