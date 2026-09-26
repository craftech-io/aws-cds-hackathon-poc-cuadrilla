// `npm run leads:notify-test` (ADR-0026, docs/test-plan.md §2.1): the real send of the lead notice,
// which the scenarios never exercise (QA leads are suppressed). It sends ONE notice marked "PRUEBA",
// with fictitious data and no lead behind it, to the recipients of the `LeadConfig` in force, through
// the same fence, sender, configuration set and text as `LeadStream`. The operator's profile through
// `sst shell` (which exposes `LeadConfig` and `LeadNotifyChannel`), never CI; it prints the SES
// message id and how many mailboxes received it, never an address.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONSENTS_VERSION } from "@cuadrilla/shared/legal/consents";
import type { LeadNoticeInput } from "../../packages/bff/src/copy/lead-notify";
import { assertOperatorMachine } from "./operator-only";

/** Fictitious data of the test notice (nobody's: the reserved domain of RFC 2606). */
export function testNoticeInput(now: Date): LeadNoticeInput {
  return {
    leadId: "00000000000000000000000000",
    email: "persona.ficticia@example.com",
    name: "Persona Ficticia",
    company: "Empresa Ficticia",
    jobTitle: "Cargo ficticio",
    locale: "es-MX",
    contactAccepted: true,
    contactVersion: CONSENTS_VERSION,
    origin: "WEB",
    utm: { source: "prueba", medium: "operador" },
    signupAt: now.toISOString(),
    test: true,
  };
}

async function main(): Promise<void> {
  assertOperatorMachine();
  const [{ SESv2Client }, { sendLeadNotice }, { leadConfig, leadNotifyChannel }, { fencedNotifyRecipients }, { CLIENT_TIMEOUTS, awsClientConfig }, { currentStage }] = await Promise.all([
    import("@aws-sdk/client-sesv2"),
    import("../../packages/bff/src/leads/notify"),
    import("../../packages/bff/src/leads/config"),
    import("../../packages/bff/src/leads/notify-fence"),
    import("../../packages/bff/src/lib/clients"),
    import("../../packages/bff/src/lib/resource"),
  ]);
  const config = leadConfig();
  const recipients = fencedNotifyRecipients(config.notifyRecipients).length;
  const messageId = await sendLeadNotice(
    { ses: new SESv2Client(awsClientConfig(CLIENT_TIMEOUTS.ses)), channel: leadNotifyChannel, config: () => config, stage: currentStage() },
    testNoticeInput(new Date()),
  );
  console.log(`leads:notify-test: test notice sent to ${recipients} mailbox(es) (SES message ${messageId ?? "without id"}). Check that it arrived.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error: unknown) => {
    console.error(`leads:notify-test: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
