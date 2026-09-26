// The notice to Craftech for a confirmed lead (ADR-0026, docs/architecture-integrations.md §9.3):
// exactly one per lead. `notifiedAt` is claimed with a condition BEFORE the send, so a retry of the
// stream never sends twice; a send that fails gives the claim back (`notifyOutcome FAILED`) and throws,
// so the stream retries and, after its retries, the record lands in `LeadStreamDlq` with its alarm.
//
//   origin QA           no send: `notifyOutcome SUPPRESSED_QA` (the QA seam's addresses, ADR-0025 §7)
//   recipients          `LeadConfig.notifyRecipients`, each checked again by leads/notify-fence.ts
//   sender              "Cuadrilla · Leads" <leads@…>, the app's configuration set, `kind LEAD_NOTIFY`
//   content             copy/lead-notify.ts (escaped, neutralized, "NO CONTACTAR" without consent)
//
// The lead's email reaches SES as part of the body only; it is never logged (`emailHash[0:8]`, `leadId`).
import { SendEmailCommand, type SESv2Client } from "@aws-sdk/client-sesv2";
import { formatMailbox } from "../channels/email/mime";
import { emailTags } from "../channels/email/tags";
import { LEAD_NOTICE_KIND, LEAD_NOTICE_SENDER_NAME, type LeadNoticeInput, renderLeadNotice } from "../copy/lead-notify";
import type { Logger } from "../lib/log";
import type { LeadConfigValue } from "../lib/secret-schemas";
import type { LeadNotifyChannel } from "./config";
import { hashPrefix } from "./keys";
import { type Lead, emailHashOfPartition } from "./model";
import { fencedNotifyRecipients } from "./notify-fence";
import type { LeadStore } from "./store";

export interface NotifyDeps {
  readonly store: LeadStore;
  readonly ses: Pick<SESv2Client, "send">;
  readonly channel: () => LeadNotifyChannel;
  readonly config: () => LeadConfigValue;
  /** Real clock (a notice is not business logic of a world). */
  readonly now: () => Date;
  readonly stage: string;
  readonly log: Logger;
}

export type NotifyResult = "SENT" | "SUPPRESSED_QA" | "ALREADY_NOTIFIED" | "NOT_CONFIRMED";

/** What the notice says about a lead: its reference, the contact, the consent in force and the attribution. */
export function noticeInputOf(lead: Lead): LeadNoticeInput {
  return {
    leadId: lead.leadId,
    email: lead.email,
    name: lead.name,
    company: lead.company,
    jobTitle: lead.jobTitle,
    locale: lead.locale,
    contactAccepted: lead.consents.CONTACT.accepted,
    contactVersion: lead.consents.CONTACT.textVersion,
    origin: lead.origin,
    utm: lead.utm,
    referrerOrigin: lead.referrerOrigin,
    signupAt: lead.confirmedAt ?? lead.signupStartedAt,
  };
}

/** Sends one notice to the fenced recipients; returns SES's message id. */
export async function sendLeadNotice(deps: Pick<NotifyDeps, "ses" | "channel" | "config" | "stage">, input: LeadNoticeInput): Promise<string | undefined> {
  const channel = deps.channel();
  const recipients = fencedNotifyRecipients(deps.config().notifyRecipients);
  const notice = renderLeadNotice(input);
  const output = await deps.ses.send(
    new SendEmailCommand({
      FromEmailAddress: formatMailbox(LEAD_NOTICE_SENDER_NAME, channel.sender),
      Destination: { ToAddresses: recipients },
      Content: {
        Simple: {
          Subject: { Data: notice.subject, Charset: "UTF-8" },
          Body: { Text: { Data: notice.text, Charset: "UTF-8" }, Html: { Data: notice.html, Charset: "UTF-8" } },
        },
      },
      ConfigurationSetName: channel.configurationSetName,
      EmailTags: emailTags({ kind: LEAD_NOTICE_KIND, stage: deps.stage }),
    }),
  );
  return output.MessageId;
}

/** The notice of one confirmed lead, at most once. */
export async function notifyConfirmedLead(deps: NotifyDeps, emailHash: string): Promise<NotifyResult> {
  const lead = await deps.store.get(emailHash);
  if (lead === undefined || lead.status !== "CONFIRMED") return "NOT_CONFIRMED";
  const fields = { leadId: lead.leadId, emailHashPrefix: hashPrefix(emailHashOfPartition(lead.PK)) };
  if (lead.notifiedAt !== undefined) return "ALREADY_NOTIFIED";

  if (lead.origin === "QA") {
    const claimed = await deps.store.claimNotice(emailHash, "SUPPRESSED_QA", deps.now());
    if (claimed) deps.log.info("lead.notice.suppressed", { ...fields, outcome: "SUPPRESSED_QA" });
    return claimed ? "SUPPRESSED_QA" : "ALREADY_NOTIFIED";
  }

  // A recipient outside the fence is a configuration error: it fails before anything is claimed.
  fencedNotifyRecipients(deps.config().notifyRecipients);
  if (!(await deps.store.claimNotice(emailHash, "SENT", deps.now()))) return "ALREADY_NOTIFIED";
  try {
    await sendLeadNotice(deps, noticeInputOf(lead));
  } catch (error) {
    await deps.store.releaseNotice(emailHash, deps.now());
    deps.log.error("lead.notice.failed", { ...fields, metric: "LeadNotifyFailures", value: 1, errorName: error instanceof Error ? error.name : "Unknown" });
    throw error;
  }
  deps.log.info("lead.notice.sent", { ...fields, outcome: "SENT" });
  return "SENT";
}
