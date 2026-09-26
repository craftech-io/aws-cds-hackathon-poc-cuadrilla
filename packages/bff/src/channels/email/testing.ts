// Test support for the SES client and its events (never imported by runtime code): a world over the
// in-memory connector with its settings, a mocked SES client per world, the certificate PDF in an
// in-memory `Evidence` bucket, the cap store and a movable real clock. Fixtures follow
// docs/seed-spec.md: order 24817 of Lucía (`success+c10421@…`), the operations mailbox, Marisol the
// zone chief, the bounce (`cust-10431`, order 24831) and the complaint (`cust-10432`).
import { createHash } from "node:crypto";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { mockClient } from "aws-sdk-client-mock";
import { ispIdOfClock } from "@cuadrilla/shared";
import { T0, testConnector } from "../../connector/testing";
import { type ResolvedBrand, resolveBrand } from "../../copy/brand";
import { certificateEmail, zoneChiefSafetyAlert } from "../../copy/es-MX-documents";
import { createLogger } from "../../lib/log";
import { createMemoryRuntimeStore } from "../../ops/memory-runtime-store";
import type { EmailChannelConfig } from "./config";
import { consoleCaseUrl } from "./content";
import { type EmailClient, createEmailClient } from "./outbound";
import type { EmailSendRequestInput } from "./request";

export const EMAIL_CONFIG: EmailChannelConfig = {
  identityDomain: "cuadrilla.demo.craftech.io",
  configurationSetName: "aws-cds-hackathon-poc-cuadrilla-email-poc",
  evidenceBucket: "aws-cds-hackathon-poc-cuadrilla-poc-evidence",
  stage: "poc",
};

export const CUSTOMER = "success+c10421@simulator.amazonses.com";
export const OPS_MAILBOX = "success+ops-demo@simulator.amazonses.com";
export const ZONE_CHIEF = "success+zc-marisol@simulator.amazonses.com";
export const BOUNCE_CUSTOMER = "bounce+c10431@simulator.amazonses.com";
export const COMPLAINT_CUSTOMER = "complaint+c10432@simulator.amazonses.com";
/** A registered demo mailbox (`SeedOverrides.demoRecipients`); the domain is invented. */
export const DEMO_MAILBOX = "bandeja@equipo-demo-ficticio.mx";
export const CASE_ID = "case-01J9ZQX0000000000000000000";

export const PDF_KEY = "certificates/wo-24817/acta-24817.pdf";
export const PDF = new TextEncoder().encode("%PDF-1.7\n% synthetic installation certificate of order 24817\n%%EOF\n");
export const PDF_SHA = createHash("sha256").update(PDF).digest("hex");

export const BRAND: ResolvedBrand = resolveBrand({ mode: "neutral" });

export function worldSettings(clockId: string, emailsPerDay = 20) {
  return {
    ispId: ispIdOfClock(clockId),
    clockId,
    quietHours: { start: "21:00", end: "07:00" },
    caseTimeoutSec: 600,
    demoMode: true,
    demoCaseTimeoutSec: 60,
    whatsappMode: "simulated" as const,
    turnCaps: { perHour: 200, perDay: 1000 },
    simulatorCaps: { turnsPerHour: 60, turnsPerDay: 300, validationsPerDay: 100, transcribeSecPerDay: 1800, emailsPerDay, messagesPerRealHourPerIdentity: 20 },
  };
}

/** `CERTIFICATE_EMAIL` of order 24817 (or another order of the world) to one recipient. */
export function certificateRequest(clockId: string, overrides: Partial<EmailSendRequestInput> = {}): EmailSendRequestInput {
  const text = certificateEmail({ brand: BRAND, workOrderNumber: "24817", recipient: "CUSTOMER", customerFirstName: "Lucía", closedAtText: "martes 13/10/2026, 10:05" });
  return {
    clockId,
    kind: "CERTIFICATE_EMAIL",
    toRole: "CUSTOMER",
    to: CUSTOMER,
    subject: text.subject,
    bodyText: text.body,
    workOrderId: "wo-24817",
    attachment: { s3Key: PDF_KEY, fileName: "acta-24817.pdf", sha256: PDF_SHA },
    sentAtSim: "2026-10-13T10:05:00-06:00",
    actor: "SYSTEM",
    ...overrides,
  };
}

/** `ZONE_CHIEF_ALERT` of the safety case of order 24819 (Marisol, Zona Norte). */
export function alertRequest(clockId: string, overrides: Partial<EmailSendRequestInput> = {}): EmailSendRequestInput {
  const text = zoneChiefSafetyAlert({
    brand: BRAND,
    workOrderNumber: "24819",
    zoneName: "Norte",
    zoneChiefFirstName: "Marisol",
    installerFirstName: "Rogelio",
    reasonText: "cable de energía dañado",
    summary: "Cable de energía caído junto a la roseta; el instalador ya se alejó.",
    caseUrl: consoleCaseUrl(EMAIL_CONFIG.identityDomain, CASE_ID),
    atText: "13/10 15:10",
  });
  return {
    clockId,
    kind: "ZONE_CHIEF_ALERT",
    toRole: "ZONE_CHIEF",
    to: ZONE_CHIEF,
    subject: text.subject,
    bodyText: text.body,
    workOrderId: "wo-24819",
    caseId: CASE_ID,
    sentAtSim: "2026-10-13T15:10:00-06:00",
    actor: "SYSTEM",
    ...overrides,
  };
}

export interface EmailWorldOptions {
  readonly clockId?: string;
  readonly emailsPerDay?: number;
  readonly messageIds?: readonly string[];
}

/** A world with its settings, a mocked SES that answers `messageIds` in order, and its client. */
export async function emailWorld(options: EmailWorldOptions = {}) {
  const clockId = options.clockId ?? "GLOBAL#isp-demo";
  const store = testConnector(T0);
  await store.connector.isps.putSettings(worldSettings(clockId, options.emailsPerDay));
  const sesClient = new SESv2Client({ region: "us-east-1", credentials: { accessKeyId: "test", secretAccessKey: "test" } });
  const ses = mockClient(sesClient);
  const queue = [...(options.messageIds ?? ["0100019a2b3c4d5e-11111111-2222-3333-4444-555555555555-000000"])];
  ses.on(SendEmailCommand).callsFake(() => ({ MessageId: queue.length > 1 ? queue.shift() : queue[0] }));
  const caps = createMemoryRuntimeStore();
  const objects = new Map<string, Uint8Array>([[PDF_KEY, PDF]]);
  const lines: string[] = [];
  let mailSeq = 0;
  const client: EmailClient = createEmailClient({
    connector: store.connector,
    ses: sesClient,
    attachments: {
      read: async (key) => {
        const bytes = objects.get(key);
        if (bytes === undefined) throw new Error(`no object ${key}`);
        return bytes;
      },
    },
    config: () => EMAIL_CONFIG,
    demoRecipients: () => [DEMO_MAILBOX],
    caps: { store: caps },
    realClock: { now: async () => store.now() },
    newMailId: () => `mail-test-${String((mailSeq += 1)).padStart(3, "0")}`,
    logger: createLogger({ level: "debug", sink: (line) => lines.push(line) }),
  });
  const sent = () => ses.commandCalls(SendEmailCommand).map((call) => call.args[0].input);
  const capUsed = (day = "2026-10-13") => Number(caps.items.get(`SIMCAP#${clockId}#emails#${day}`)?.used ?? 0);
  return { clockId, ispId: ispIdOfClock(clockId), store, connector: store.connector, ses, client, objects, caps, lines, sent, capUsed };
}
