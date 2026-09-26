// SES outbound of the app (docs/architecture.md §1 and §14, docs/architecture-integrations.md §1-§3,
// docs/build-plan.md WP-20). Every value lives in infra/messaging-email-spec.ts as plain data, checked
// by infra/messaging-email-spec.test.ts; this module only turns it into resources.
//
// Outbound only (ADR-0003). The domain identity with Easy DKIM, the custom MAIL FROM `bounce.` (SES's
// feedback MX and SPF), DMARC `p=reject`, the configuration set and its events. No inbound MX, no
// receipt rule set, rule or filter, no inbound mail bucket: the only active rule set of the shared
// account belongs to another app, and the CI role has no receipt-rule action at all.
//
// Why raw `aws.sesv2.*` and not `sst.aws.Email`. That component (SST 4.17.1) always adds an
// `aws.ses.DomainIdentityVerification` for a domain sender, which polls `GetIdentityVerificationAttributes`
// (no resource type in IAM, so the tag-fenced CI role cannot call it) and blocks the deploy for up to
// 45 minutes on the first DKIM; it writes SPF `~all` instead of `-all`; and its link grants `ses:*` on
// the identity plus `ses:SendEmail` on `*`, which SEND_EMAIL forbids. The DNS records still go
// through SST's Route 53 adapter of infra/dns.ts, pinned to the delegated zone.
//
// Configuration set. Fixed name `aws-cds-hackathon-poc-cuadrilla-email-poc` (the CI role fences it by
// ARN). The app's SES client names it in every SendEmail; it is not the identity's default, so the
// Cognito emails of infra/auth.ts (`no-reply@`, sent by Cognito's service-linked role) never produce
// events for ChannelEvents. Events SEND, DELIVERY, BOUNCE, COMPLAINT, REJECT, DELIVERY_DELAY and
// RENDERING_FAILURE go to the default EventBridge bus (the only bus SES publishes to); one rule on it,
// filtered by the `ses:configuration-set` tag of our set (the other app shares the bus), invokes
// ChannelEvents. The Function belongs to infra/workers.ts (WP-27), which sst.config.ts evaluates after
// this module: it is read with a late link, and a workers module that does not export it fails the
// deploy instead of leaving the certificates without delivery events.
//
// Sending. The `EmailChannel` link hands a Lambda the identity domain, the configuration set and the
// two senders (packages/bff/src/channels/email/config.ts reads it), and grants SEND_EMAIL of
// infra/iam-capabilities.ts: `ses:SendEmail` on the identity and the configuration set only, From ∈
// {actas@, avisos@}, every recipient in the SES mailbox simulator or among the `demoRecipients.emails`
// of SeedOverrides (read on each deploy; a change reaches IAM on the next one).
// Every role with PIPELINE links it; nothing else does. The recipient fence of the SES client, per
// world, stays the first line (docs/architecture.md §13).
//
// Tags: the `aws` provider stamps the default tags of sst.config.ts on the identity, the configuration
// set and the rule, which is what the CI role requires to create them. Cost: SES per message; nothing
// here bills by the hour.
//
// Verify (docs/architecture.md §15 step 6):
//   aws --profile craftech-demos sesv2 get-email-identity --email-identity cuadrilla.demo.craftech.io
//     VerifiedForSendingStatus = true · DkimAttributes.Status = SUCCESS · NextSigningKeyLength = RSA_2048_BIT ·
//     MailFromAttributes = bounce.cuadrilla.demo.craftech.io, MailFromDomainStatus = SUCCESS, USE_DEFAULT_VALUE ·
//     no ConfigurationSetName
//   aws --profile craftech-demos sesv2 get-configuration-set-event-destinations \
//     --configuration-set-name aws-cds-hackathon-poc-cuadrilla-email-poc
//     one destination `channel-events`, EventBridge default bus, the seven types, no OPEN or CLICK
//   dig +short TXT _dmarc.cuadrilla.demo.craftech.io     "v=DMARC1; p=reject; adkim=r; aspf=r"
//   dig +short MX bounce.cuadrilla.demo.craftech.io      10 feedback-smtp.us-east-1.amazonses.com
//   dig +short MX cuadrilla.demo.craftech.io             (nothing: no inbound MX)
//   aws --profile craftech-demos events list-rule-names-by-target --event-bus-name default --target-arn <ChannelEvents ARN>
//     exactly one rule, whose pattern names this configuration set

import { appDomain, dns, mailFromDomain } from "./dns";
import { lateLinks } from "./late-links";
import {
  CHANNEL_EVENTS_EXPORT,
  CONFIGURATION_SET_NAME,
  DKIM_KEY_LENGTH,
  DMARC_RECORD,
  EASY_DKIM_TOKENS,
  EMAIL_DOMAIN,
  EMAIL_EVENT_TYPES,
  EMAIL_LINK_NAME,
  EVENT_DESTINATION_NAME,
  MAIL_FROM_BEHAVIOR_ON_MX_FAILURE,
  MAIL_FROM_DOMAIN,
  assertDeclaredArns,
  defaultEventBusArn,
  demoRecipients,
  dkimRecord,
  dkimTokens,
  emailEventPattern,
  emailLinkProperties,
  mailFromRecords,
  sendEmailGrant,
  type EmailDnsRecord,
} from "./messaging-email-spec";
import { SeedOverrides } from "./secrets";

if (appDomain !== EMAIL_DOMAIN || mailFromDomain !== MAIL_FROM_DOMAIN) {
  throw new Error(`infra/dns.ts names ${appDomain} and ${mailFromDomain}; infra/messaging-email-spec.ts sends from ${EMAIL_DOMAIN} with MAIL FROM ${MAIL_FROM_DOMAIN}.`);
}

const region = aws.getRegionOutput({}).region;
const accountId = aws.getCallerIdentityOutput({}).accountId;

// ---- Identity, MAIL FROM and configuration set -------------------------------------------------

export const emailConfigurationSet = new aws.sesv2.ConfigurationSet("EmailConfigurationSet", {
  configurationSetName: CONFIGURATION_SET_NAME,
  reputationOptions: { reputationMetricsEnabled: true },
});

/** The domain identity; infra/auth.ts reads it live to move Cognito's emails onto it once verified. */
export const emailIdentity = new aws.sesv2.EmailIdentity("EmailIdentity", {
  emailIdentity: EMAIL_DOMAIN,
  dkimSigningAttributes: { nextSigningKeyLength: DKIM_KEY_LENGTH },
});

export const emailMailFrom = new aws.sesv2.EmailIdentityMailFromAttributes("EmailMailFrom", {
  emailIdentity: emailIdentity.emailIdentity,
  mailFromDomain: MAIL_FROM_DOMAIN,
  behaviorOnMxFailure: MAIL_FROM_BEHAVIOR_ON_MX_FAILURE,
});

// ---- DNS (delegated zone demo.craftech.io, through SST's Route 53 adapter) ---------------------

function emailRecord(record: $util.Output<EmailDnsRecord>) {
  return dns.createRecord("Email", { type: record.apply((r) => r.type), name: record.apply((r) => r.name), value: record.apply((r) => r.value) }, {});
}

const tokens = emailIdentity.dkimSigningAttributes.apply((attributes) => dkimTokens(attributes.tokens));
const mailFrom = region.apply(mailFromRecords);

export const emailRecords = [
  ...Array.from({ length: EASY_DKIM_TOKENS }, (_, index) => emailRecord(tokens.apply((list) => dkimRecord(list[index] as string)))),
  emailRecord(mailFrom.apply(([mx]) => mx)),
  emailRecord(mailFrom.apply(([, spf]) => spf)),
  dns.createRecord("Email", DMARC_RECORD, {}),
];

// ---- Events → ChannelEvents --------------------------------------------------------------------

const eventBusArn = $util.all([region, accountId]).apply(([name, account]) => defaultEventBusArn(name, account));

export const emailEventDestination = new aws.sesv2.ConfigurationSetEventDestination("EmailEventDestination", {
  configurationSetName: emailConfigurationSet.configurationSetName,
  eventDestinationName: EVENT_DESTINATION_NAME,
  eventDestination: {
    enabled: true,
    matchingEventTypes: [...EMAIL_EVENT_TYPES],
    eventBridgeDestination: { eventBusArn },
  },
});

type FunctionArn = `arn:${string}`;

function channelEventsArn(fn: unknown): $util.Output<FunctionArn> {
  if (!(fn instanceof sst.aws.Function)) {
    throw new Error(`infra/workers.ts exports ${CHANNEL_EVENTS_EXPORT}, but it is not the ChannelEvents sst.aws.Function the SES events go to.`);
  }
  return fn.arn.apply((arn) => arn as FunctionArn);
}

const channelEvents = lateLinks("messaging-email", "workers", () => import("./workers"), [CHANNEL_EVENTS_EXPORT]).apply(([fn]) => channelEventsArn(fn));

/** Rule on the default bus, its target and the invoke permission (source ARN = the rule). */
export const emailEvents = sst.aws.Bus.subscribe("EmailEvents", eventBusArn, channelEvents, { pattern: emailEventPattern() });

// ---- Sending: the link of every role with PIPELINE ---------------------------------------------

const grant = SeedOverrides.value.apply((raw) => sendEmailGrant(demoRecipients(raw)));

const grantResources = $util.all([emailIdentity.arn, emailConfigurationSet.arn, grant]).apply(([identityArn, setArn, statement]) => {
  assertDeclaredArns(identityArn, setArn);
  return [...statement.resources];
});

/** `Resource.EmailChannel.{identityDomain, configurationSetName, senders}` and SEND_EMAIL, nothing more. */
export const EmailChannel = new sst.Linkable(EMAIL_LINK_NAME, {
  properties: emailLinkProperties(),
  include: [
    sst.aws.permission({
      actions: [...sendEmailGrant([]).actions],
      resources: grantResources,
      conditions: grant.apply((statement) => (statement.conditions ?? []).map((condition) => ({ test: condition.test, variable: condition.variable, values: [...condition.values] }))),
    }),
  ],
});
