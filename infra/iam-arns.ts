// The names and ARN helpers of the stage (docs/architecture.md §1 and §14), as plain data. No SST or
// Pulumi dependency; infra/iam-capabilities.ts re-exports every value, so modules keep importing them there.

export const REGION = "us-east-1";
export const ACCOUNT_ID = "776805327629";
export const APP = "aws-cds-hackathon-poc-cuadrilla";
export const STAGE = "poc";
export const APP_DOMAIN = "cuadrilla.demo.craftech.io";

/** Prefix of Transcribe jobs and of the vocabulary: short, unique in the account (docs/architecture.md §1). */
export const TRANSCRIBE_PREFIX = "cuadrilla-poc-";
export const SCHEDULE_GROUP = `${APP}-${STAGE}-schedules`;
export const EMAIL_CONFIGURATION_SET = `${APP}-email-${STAGE}`;
export const METRICS_NAMESPACE = "CuadrillaAgent";
export const SENDERS = [`actas@${APP_DOMAIN}`, `avisos@${APP_DOMAIN}`] as const;

// ---- ARN helpers ---------------------------------------------------------------------------------
/** Base foundation model of a model id (`global.anthropic.claude-opus-5` → `anthropic.claude-opus-5`). */
export function foundationModelOf(modelId: string): string {
  return modelId.replace(/^(global|us|eu|apac)\./, "");
}

/**
 * Everything `bedrock:InvokeModel` must name to call a model through the app's inference profile
 * (ADR-0028), which copies a global one: the app's profile when given, the global profile in this
 * region, plus its foundation model region-less (global routing) and in every region the profile may
 * route to. A profile alone gives AccessDenied; nothing else is named, never `*`.
 */
export function agentModelArns(modelId: string, region: string = REGION, account: string = ACCOUNT_ID, appProfileArn?: string): string[] {
  const foundation = foundationModelOf(modelId);
  const models = [`arn:aws:bedrock:::foundation-model/${foundation}`, `arn:aws:bedrock:*::foundation-model/${foundation}`];
  const profiles = foundation === modelId ? [] : [`arn:aws:bedrock:${region}:${account}:inference-profile/${modelId}`];
  return [...(appProfileArn === undefined ? [] : [appProfileArn]), ...profiles, ...models];
}

const AWS_PHONE_NUMBER_ID = /^phone-number-id-([0-9a-f]{32})$/;

/**
 * ARN of our WhatsApp number from its AWS id (`phone-number-id-<32 hex>`, secret WhatsAppPhoneNumberId):
 * `…:phone-number-id/<32 hex>`, without the `phone-number-id-` prefix. `undefined` while the secret
 * is `not-connected`: the statement is omitted, never widened to `phone-number-id/*`.
 */
export function whatsappPhoneArn(awsPhoneNumberId: string, region: string = REGION, account: string = ACCOUNT_ID): string | undefined {
  if (awsPhoneNumberId === "not-connected") return undefined;
  const hex = AWS_PHONE_NUMBER_ID.exec(awsPhoneNumberId)?.[1];
  if (!hex) throw new Error("WhatsAppPhoneNumberId must be `not-connected` or `phone-number-id-<32 hex>` (the AWS id, never the Meta id).");
  return `arn:aws:social-messaging:${region}:${account}:phone-number-id/${hex}`;
}
