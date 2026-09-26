// WhatsApp of the app as resources (docs/architecture-integrations.md §4, docs/architecture.md §1, §13
// and §14, ADR-0002, docs/build-plan.md WP-24): the SNS topic End User Messaging Social publishes our
// WABA's events to, its resource policy, the `InboundWhatsApp` Lambda subscribed to it, and the IAM of
// our number (`whatsappPhoneArn()`).
//
// Topic. `aws-cds-hackathon-poc-cuadrilla-wa-inbound`: a fixed name (unique in the account, inside the
// `sns:<app>-*` fence of the CI deploy role), STANDARD, because EUM Social publishes to no FIFO topic.
// It is the only event destination of the app's own WABA (P-01, option A); the operator points the
// WABA at it (docs/pending.md P-01, scripts/channels/waba-event-destination.ts): no role of the app nor
// the CI role holds `PutWhatsAppBusinessAccountEventDestinations`. No SSE: EUM Social cannot publish to
// a topic under the AWS managed key.
//
// Who may publish (`waInboundTopicPolicy`): EUM Social (`social-messaging.amazonaws.com`, with
// `aws:SourceAccount` of this account) and the QaDriver's role, which publishes events with another
// number and `qa-foreign=1` to prove the discard without a WABA (FL-095). A Deny of `sns:Publish`
// reaches every other principal (`aws:PrincipalServiceName`, `aws:PrincipalArn`), so no other role of
// this shared account can inject "live" events with our number, whatever its own policy says. The
// QaDriver belongs to infra/bff.ts (WP-38), read late (infra/mocks.ts `lateFunction`); until that
// module exports it, only the service may publish. The QaDriver links `WaInbound` (the topic's ARN and
// `sns:Publish` on it); no other role links it.
//
// Subscriber. `InboundWhatsApp` (handler: WP-33) filters by the Meta id of the number before anything
// else and never throws on a foreign or invalid event, so the subscription keeps no body anywhere: no
// redrive policy, no on-failure destination, no filter policy (a `qa-foreign` event must reach the
// function, which records the `PROBE#foreign#` probe). The Bff and the QaDriver also invoke it with the
// simulator's envelope (their modules grant it). Reserved concurrency 10 (docs/architecture.md §12).
//
// Number. `WhatsAppPhoneNumberId` is the AWS id (`phone-number-id-<32 hex>`); its ARN drops the prefix
// (`…:phone-number-id/<32 hex>`), and every `social-messaging:*` statement is omitted while the secret
// is `not-connected`, never widened to `phone-number-id/*`: every role with SEND_WHATSAPP adds
// `whatsappPermissions(fn)`. The Meta id (`WhatsAppMetaPhoneNumberId`) is only compared with inbound
// events, never used in IAM.
//
// Verify:
//   aws --profile craftech-demos sns get-topic-attributes --topic-arn arn:aws:sns:us-east-1:776805327629:aws-cds-hackathon-poc-cuadrilla-wa-inbound
//     → no FifoTopic, no KmsMasterKeyId, Policy with the statements of `waInboundTopicPolicy`
//   aws --profile craftech-demos sns list-subscriptions-by-topic --topic-arn <same>   → one lambda subscription: InboundWhatsApp
//   aws --profile craftech-demos sns get-subscription-attributes --subscription-arn <arn>   → no RedrivePolicy, no FilterPolicy
//   aws --profile craftech-demos socialmessaging get-linked-whatsapp-business-account --id <WabaId>
//     → eventDestinations = this topic; phoneNumbers[].arn = whatsappPhoneArn(WhatsAppPhoneNumberId) (P-01 step 6)

import { ChannelModes } from "./channel-modes";
import { ACCOUNT_ID, APP, expectedGrants, whatsappPhoneArn, type RoleName } from "./iam-capabilities";
import { lateLinks, links } from "./late-links";
import { grantStatement, lateFunction, type Statement } from "./mocks";
import { BrandConfig, SeedOverrides, SessionTokenKey, WhatsAppMetaPhoneNumberId, WhatsAppPhoneNumberId } from "./secrets";
import { storageLinks, storagePermissions, storageResource } from "./storage";

export { whatsappPhoneArn } from "./iam-capabilities";

export const WA_INBOUND_TOPIC_NAME = `${APP}-wa-inbound`;
export const INBOUND_WHATSAPP_HANDLER = "packages/bff/src/handlers/inbound-whatsapp.handler";
export const EUM_SOCIAL_PRINCIPAL = "social-messaging.amazonaws.com";

/** Placeholder of iam-capabilities.ts for the ARN of our number. */
const WHATSAPP_PHONE = "{whatsappPhone}";

/** Resource policy of the topic: EUM Social and the QaDriver publish; every other principal is denied `sns:Publish`. */
export function waInboundTopicPolicy(topicArn: string, qaDriverRoleArn: string | undefined, account: string = ACCOUNT_ID) {
  const publish = { Action: "sns:Publish", Resource: topicArn };
  const notService = { StringNotEquals: { "aws:PrincipalServiceName": EUM_SOCIAL_PRINCIPAL } };
  return {
    Version: "2012-10-17",
    Id: WA_INBOUND_TOPIC_NAME,
    Statement: [
      { Sid: "EndUserMessagingSocialPublishes", Effect: "Allow", Principal: { Service: EUM_SOCIAL_PRINCIPAL }, ...publish, Condition: { StringEquals: { "aws:SourceAccount": account } } },
      ...(qaDriverRoleArn === undefined ? [] : [{ Sid: "QaDriverPublishesForeignEvents", Effect: "Allow", Principal: { AWS: qaDriverRoleArn }, ...publish }]),
      {
        Sid: "DenyEveryOtherPublisher",
        Effect: "Deny",
        Principal: "*",
        ...publish,
        Condition: qaDriverRoleArn === undefined ? notService : { ...notService, ArnNotEquals: { "aws:PrincipalArn": qaDriverRoleArn } },
      },
    ],
  };
}

/** ARN of our number for IAM, from the secret; `undefined` while it is `not-connected` (P-01). */
export const whatsappPhone: $util.Output<string | undefined> = WhatsAppPhoneNumberId.value.apply((id) => whatsappPhoneArn(id));

/** A role's grants on our number (SEND_WHATSAPP, GetWhatsAppMessageMedia), on its exact ARN; none while it is `not-connected`. */
export function whatsappPermissions(fn: RoleName): $util.Output<Statement[]> {
  const grants = expectedGrants(fn).filter((grant) => grant.resources.includes(WHATSAPP_PHONE));
  return whatsappPhone.apply((phoneArn) => (phoneArn === undefined ? [] : grants.map((grant) => grantStatement(grant, () => phoneArn))));
}

export const waInboundTopic = new sst.aws.SnsTopic("WaInboundTopic", {
  fifo: false,
  transform: {
    topic: (args) => {
      args.name = WA_INBOUND_TOPIC_NAME;
    },
  },
});

const qaDriverRoleArn = lateFunction("QaDriver", "only End User Messaging Social may publish on the WhatsApp topic").apply((fn) => fn?.nodes.role.arn);

export const waInboundTopicPolicyResource = new aws.sns.TopicPolicy("WaInboundTopicPolicy", {
  arn: waInboundTopic.arn,
  policy: $util.all([waInboundTopic.arn, qaDriverRoleArn]).apply(([arn, role]) => JSON.stringify(waInboundTopicPolicy(arn, role))),
});

/** What the QaDriver links: `Resource.WaInbound.{arn, name}` and `sns:Publish` on this topic only. */
export const WaInbound = new sst.Linkable("WaInbound", {
  properties: { arn: waInboundTopic.arn, name: waInboundTopic.name },
  include: [sst.aws.permission({ actions: ["sns:Publish"], resources: [waInboundTopic.arn] })],
});

/**
 * InboundWhatsApp's statements: its tables and Media, its grants on our number (none while it is not
 * connected), SEND_WHATSAPP's reads of certificates and photos and `cloudwatch:PutMetricData` in the
 * app's namespace. `sqs:SendMessage` comes with the linked `InstallerEvents` queue (infra/workers.ts
 * hands a linked queue its URL and that action only).
 */
function inboundPermissions(): $util.Output<Statement[]> {
  const rest = expectedGrants("InboundWhatsApp").filter((grant) => !grant.resources.includes(WHATSAPP_PHONE) && !grant.resources.includes("{InstallerEvents}"));
  const statements = rest.map((grant) =>
    grantStatement(grant, (resource) => {
      const resolved = storageResource(resource);
      if (resolved === undefined && resource !== "*") throw new Error(`infra/messaging-whatsapp.ts cannot resolve "${resource}" for InboundWhatsApp.`);
      return resolved ?? resource;
    }),
  );
  return whatsappPermissions("InboundWhatsApp").apply((number) => [...storagePermissions("InboundWhatsApp"), ...number, ...statements]);
}

export const InboundWhatsApp = new sst.aws.Function("InboundWhatsApp", {
  description: "WhatsApp inbound (our WABA's topic and the phone simulator): number filter first, then world, identity and the installer queue.",
  handler: INBOUND_WHATSAPP_HANDLER,
  link: links(
    [...storageLinks("InboundWhatsApp"), SessionTokenKey, WhatsAppPhoneNumberId, WhatsAppMetaPhoneNumberId, SeedOverrides, BrandConfig, ChannelModes],
    lateLinks("messaging-whatsapp", "workers", () => import("./workers"), ["InstallerEvents"], "optional"),
  ),
  permissions: inboundPermissions(),
  timeout: "30 seconds",
  memory: "512 MB",
  concurrency: { reserved: 10 },
});

/** The subscription and its `sns.amazonaws.com` invoke permission (SourceArn = the topic); no failure destination. */
export const inboundWhatsAppSubscription = waInboundTopic.subscribe("InboundWhatsApp", InboundWhatsApp.arn);
