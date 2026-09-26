// The SES outbound identity of the app as plain data and pure functions (docs/architecture.md §1 and
// §14, docs/architecture-integrations.md §1-§3, ADR-0003, docs/build-plan.md WP-20). No SST or Pulumi
// dependency: infra/messaging-email.ts builds the resources from this file, and
// infra/messaging-email-spec.test.ts checks every value without an AWS account.
//
// Outbound only. The domain gets Easy DKIM, a custom MAIL FROM (`bounce.`, with SES's FEEDBACK MX and
// SPF) and DMARC `p=reject`. It never gets an inbound MX, a receipt rule set, a receipt rule, a receipt
// filter or an inbound mail bucket: the only active rule set of the shared account belongs to another
// app, and nothing in this product reads email (ADR-0003).
//
//   cuadrilla.demo.craftech.io                  SES identity: actas@ (certificates), avisos@ (alerts),
//                                               no-reply@ (Cognito's console emails, infra/auth.ts)
//   <token>._domainkey.cuadrilla.demo.craftech.io   CNAME ×3 → <token>.dkim.amazonses.com
//   bounce.cuadrilla.demo.craftech.io           MX 10 feedback-smtp.<region>.amazonses.com
//                                               TXT v=spf1 include:amazonses.com -all
//   _dmarc.cuadrilla.demo.craftech.io           TXT v=DMARC1; p=reject; adkim=r; aspf=r
//
// Events. The configuration set publishes seven event types to the default EventBridge bus (SES
// publishes to no other bus); one rule on that bus, filtered by the configuration set's own tag
// (the bus is shared with the other app of the account), invokes ChannelEvents, which turns each
// event into an EMAIL_EVENT on the installer's queue (docs/architecture-integrations.md §2).
//
// Sending. SEND_EMAIL of infra/iam-capabilities.ts, verbatim, plus the registered demo recipients of
// SeedOverrides read at deploy time: `ses:SendEmail` on the identity and the configuration set only,
// `ses:FromAddress` ∈ {actas@, avisos@} and every recipient in the SES mailbox simulator or in
// `demoRecipients.emails`. The recipient fence of the SES client (per world, in code) is the first
// line; this is the second.
import { SeedOverridesValue } from "../packages/bff/src/lib/secret-schemas";
import { APP_DOMAIN, CAPABILITIES, EMAIL_CONFIGURATION_SET, IAM_ARNS, SENDERS, type Condition, type Grant } from "./iam-capabilities";

// ---- Identity ------------------------------------------------------------------------------------

/** The SES domain identity: every sender of the app is a mailbox of this domain. */
export const EMAIL_DOMAIN = APP_DOMAIN;

/** Custom MAIL FROM (envelope sender), so SPF aligns under DMARC as well as DKIM. */
export const MAIL_FROM_DOMAIN = `bounce.${EMAIL_DOMAIN}`;

/** Fixed name: the CI role and `ses:SendEmail` fence it by ARN (docs/architecture.md §1). */
export const CONFIGURATION_SET_NAME = EMAIL_CONFIGURATION_SET;

/** Easy DKIM with 2048-bit keys; SES hands back exactly three tokens. */
export const DKIM_KEY_LENGTH = "RSA_2048_BIT";
export const EASY_DKIM_TOKENS = 3;

/**
 * With the feedback MX missing, SES falls back to its own MAIL FROM instead of rejecting: DKIM still
 * aligns, so DMARC still passes, and a DNS hiccup never stops a certificate.
 */
export const MAIL_FROM_BEHAVIOR_ON_MX_FAILURE = "USE_DEFAULT_VALUE";

export const MAIL_FROM_MX_PRIORITY = 10;
/** Hard fail: nothing but SES sends as the MAIL FROM domain. */
export const MAIL_FROM_SPF = "v=spf1 include:amazonses.com -all";
/** Relaxed alignment, because MAIL FROM is a subdomain; reject everything that fails it. */
export const DMARC_POLICY = "v=DMARC1; p=reject; adkim=r; aspf=r";

export type SenderRole = "certificates" | "alerts";

const SENDER_LOCAL_PARTS: Readonly<Record<SenderRole, string>> = { certificates: "actas", alerts: "avisos" };

/** `actas@` sends certificates (CERTIFICATE_EMAIL), `avisos@` the zone chief alerts (ZONE_CHIEF_ALERT). */
export const SENDER_ADDRESSES: Readonly<Record<SenderRole, string>> = Object.fromEntries(
  (Object.entries(SENDER_LOCAL_PARTS) as Array<[SenderRole, string]>).map(([role, local]) => {
    const address = `${local}@${EMAIL_DOMAIN}`;
    if (!(SENDERS as readonly string[]).includes(address)) throw new Error(`${address} is not among the SENDERS of infra/iam-capabilities.ts.`);
    return [role, address];
  }),
) as Record<SenderRole, string>;

// ---- DNS -----------------------------------------------------------------------------------------

/** A record as Route 53 stores it: an MX value carries its priority (`10 host`). */
export interface EmailDnsRecord {
  readonly type: "CNAME" | "MX" | "TXT";
  readonly name: string;
  readonly value: string;
}

const DKIM_TOKEN = /^[a-z0-9]{16,64}$/;

/** The Easy DKIM tokens of the identity, checked: exactly three DNS labels, nothing else. */
export function dkimTokens(tokens: readonly string[] | undefined): readonly string[] {
  if (tokens === undefined || tokens.length !== EASY_DKIM_TOKENS) {
    throw new Error(`The SES identity ${EMAIL_DOMAIN} returned ${tokens?.length ?? 0} DKIM tokens; Easy DKIM hands back ${EASY_DKIM_TOKENS}.`);
  }
  for (const token of tokens) if (!DKIM_TOKEN.test(token)) throw new Error(`A DKIM token of ${EMAIL_DOMAIN} is not a lowercase DNS label.`);
  return tokens;
}

export function dkimRecord(token: string): EmailDnsRecord {
  return { type: "CNAME", name: `${token}._domainkey.${EMAIL_DOMAIN}`, value: `${token}.dkim.amazonses.com` };
}

/** SES's feedback endpoint of the region: bounces and complaints come back through it, never mail. */
export function feedbackMxHost(region: string): string {
  if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) throw new Error(`"${region}" is not an AWS region.`);
  return `feedback-smtp.${region}.amazonses.com`;
}

/** MX and SPF of the MAIL FROM domain; the app domain itself never gets an MX. */
export function mailFromRecords(region: string): [EmailDnsRecord, EmailDnsRecord] {
  return [
    { type: "MX", name: MAIL_FROM_DOMAIN, value: `${MAIL_FROM_MX_PRIORITY} ${feedbackMxHost(region)}` },
    { type: "TXT", name: MAIL_FROM_DOMAIN, value: MAIL_FROM_SPF },
  ];
}

export const DMARC_RECORD: EmailDnsRecord = { type: "TXT", name: `_dmarc.${EMAIL_DOMAIN}`, value: DMARC_POLICY };

/** Every record the app writes for email, in the delegated zone `demo.craftech.io`. */
export function emailDnsRecords(tokens: readonly string[], region: string): EmailDnsRecord[] {
  return [...dkimTokens(tokens).map(dkimRecord), ...mailFromRecords(region), DMARC_RECORD];
}

// ---- Events --------------------------------------------------------------------------------------

/** docs/architecture-integrations.md §2: no OPEN, CLICK nor SUBSCRIPTION (no tracking, no lists). */
export const EMAIL_EVENT_TYPES = ["SEND", "DELIVERY", "BOUNCE", "COMPLAINT", "REJECT", "DELIVERY_DELAY", "RENDERING_FAILURE"] as const;
export const UNPUBLISHED_EVENT_TYPES = ["OPEN", "CLICK", "SUBSCRIPTION"] as const;

export const EVENT_DESTINATION_NAME = "channel-events";
export const SES_EVENT_SOURCE = "aws.ses";

/** The name infra/workers.ts (WP-27) exports the ChannelEvents sst.aws.Function under. */
export const CHANNEL_EVENTS_EXPORT = "channelEvents";

/** SES publishes to the default bus of the account and region only. */
export function defaultEventBusArn(region: string, accountId: string): string {
  if (!/^\d{12}$/.test(accountId)) throw new Error("The account id of the default event bus must be 12 digits.");
  return `arn:aws:events:${region}:${accountId}:event-bus/default`;
}

/**
 * The rule of ChannelEvents on the default bus. SES stamps `ses:configuration-set` on every event it
 * publishes, so the other app's SES events (same bus) never match. The event types are chosen by the
 * event destination (EMAIL_EVENT_TYPES), so the rule does not repeat them as `detail-type`.
 */
export function emailEventPattern(configurationSetName: string = CONFIGURATION_SET_NAME) {
  return {
    source: [SES_EVENT_SOURCE],
    detail: { mail: { tags: { "ses:configuration-set": [configurationSetName] } } },
  };
}

// ---- Sending permission --------------------------------------------------------------------------

export const SIMULATOR_DOMAIN = "simulator.amazonses.com";
/** Keeps the sending policy small (every role with PIPELINE carries it inline). */
export const MAX_DEMO_RECIPIENTS = 20;

const RECIPIENTS_VARIABLE = "ses:Recipients";
/** Lowercase, and nothing IAM reads as a wildcard (`*`, `?`) or a policy variable (`${…}`). */
const PLAIN_MAILBOX = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/** RFC 2606 / RFC 6761: never a recipient (docs/architecture-integrations.md §1). */
const RESERVED_DOMAIN = /(^|\.)(test|example|invalid|localhost)$|(^|\.)example\.(com|net|org)$/;

function parseSeedOverrides(raw: string) {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("SeedOverrides is not valid JSON (value not shown).");
  }
  const parsed = SeedOverridesValue.safeParse(json);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"} ${issue.code}`);
    throw new Error(`SeedOverrides does not match packages/bff/src/lib/secret-schemas.ts (${fields.join("; ")}); value not shown.`);
  }
  return parsed.data;
}

/**
 * The registered demo recipients of the raw SeedOverrides secret that the sending policy adds to the
 * mailbox simulator: sorted, without duplicates or simulator addresses. Every error names the
 * position, never the address (PII in a deploy log).
 */
export function demoRecipients(rawSeedOverrides: string): string[] {
  const emails = parseSeedOverrides(rawSeedOverrides).demoRecipients?.emails ?? [];
  if (emails.length > MAX_DEMO_RECIPIENTS) {
    throw new Error(`SeedOverrides.demoRecipients.emails lists ${emails.length} addresses; the sending policy takes at most ${MAX_DEMO_RECIPIENTS}.`);
  }
  const accepted = new Set<string>();
  emails.forEach((email, index) => {
    const where = `SeedOverrides.demoRecipients.emails[${index}]`;
    if (!PLAIN_MAILBOX.test(email)) {
      throw new Error(`${where} must be a lowercase mailbox of letters, digits and . _ + - (no IAM wildcard or variable); value not shown.`);
    }
    const domain = email.slice(email.indexOf("@") + 1);
    if (domain === EMAIL_DOMAIN || domain.endsWith(`.${EMAIL_DOMAIN}`)) throw new Error(`${where} is on the app's own domain, which has no mailboxes (ADR-0003).`);
    if (RESERVED_DOMAIN.test(domain)) throw new Error(`${where} is on a reserved domain (RFC 2606/6761), which never receives email.`);
    if (domain !== SIMULATOR_DOMAIN) accepted.add(email);
  });
  return [...accepted].sort();
}

/** SEND_EMAIL of infra/iam-capabilities.ts with the demo recipients added to `ses:Recipients`. */
export function sendEmailGrant(recipients: readonly string[]): Grant {
  const grants = CAPABILITIES.SEND_EMAIL.grants;
  const [grant] = grants;
  const fence = grant?.conditions?.find((condition) => condition.variable === RECIPIENTS_VARIABLE);
  if (grants.length !== 1 || grant === undefined || fence === undefined || !grant.actions.includes("ses:SendEmail")) {
    throw new Error("SEND_EMAIL of infra/iam-capabilities.ts is no longer one ses:SendEmail grant fenced by ses:Recipients; update infra/messaging-email-spec.ts with it.");
  }
  const conditions = (grant.conditions ?? []).map(
    (condition): Condition => (condition === fence ? { ...condition, values: [...new Set([...condition.values, ...recipients])] } : condition),
  );
  return { ...grant, conditions };
}

/** Fails a deploy whose identity or configuration set is not the ARN SEND_EMAIL declares. */
export function assertDeclaredArns(identityArn: string, configurationSetArn: string): void {
  const declared = [IAM_ARNS.sesIdentity, IAM_ARNS.sesConfigurationSet];
  if (identityArn !== declared[0] || configurationSetArn !== declared[1]) {
    throw new Error(
      `The SES identity and configuration set of this deploy (${identityArn}, ${configurationSetArn}) are not the ARNs SEND_EMAIL declares ` +
        `(${declared.join(", ")}): update REGION and ACCOUNT_ID in infra/iam-capabilities.ts before deploying to another account.`,
    );
  }
}

/** Logical name of the link every sender reads (packages/bff/src/channels/email/config.ts). */
export const EMAIL_LINK_NAME = "EmailChannel";

/** What a sender Lambda reads with `readLinked("EmailChannel", …)`; the IAM grant rides on the same link. */
export function emailLinkProperties() {
  return { identityDomain: EMAIL_DOMAIN, configurationSetName: CONFIGURATION_SET_NAME, senders: { ...SENDER_ADDRESSES } };
}
