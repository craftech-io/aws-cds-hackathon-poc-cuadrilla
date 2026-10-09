// Checks the two ids of the WhatsApp number and its ARN against the linked WABA (docs/pending.md P-01
// step 6, docs/architecture-integrations.md §4, ADR-0002): the AWS id (`WhatsAppPhoneNumberId`, which
// sends, fetches media and builds the IAM ARN) and the Meta id (`WhatsAppMetaPhoneNumberId`, the only value
// an inbound event is compared with) must be the same number of `GetLinkedWhatsAppBusinessAccount`, and
// the ARN `phoneNumberArn()` builds must be the number's `arn`. Read only; ids are printed by their last 4
// characters. Exit 1 on any mismatch.
//
//   npm run channels:waba-check -- --stage poc
//
// SDK command, checked in the installed `@aws-sdk/client-socialmessaging` `.d.ts`:
// `GetLinkedWhatsAppBusinessAccountCommand {id}` → `account{phoneNumbers[{phoneNumberId, metaPhoneNumberId, arn}]}`.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFlags } from "./cli-args";

export const STAGE = "poc";

export interface LinkedNumber {
  readonly phoneNumberId: string;
  readonly metaPhoneNumberId: string;
  readonly arn: string;
}

export interface CheckInput {
  readonly phoneNumberId: string;
  readonly metaPhoneNumberId: string;
  readonly expectedArn: string;
  readonly numbers: readonly LinkedNumber[];
}

const tail = (value: string): string => `…${value.slice(-4)}`;

/** The problems of the configuration (empty when the two ids and the ARN are the WABA's number). */
export function checkNumber(input: CheckInput): string[] {
  const problems: string[] = [];
  const number = input.numbers.find((candidate) => candidate.phoneNumberId === input.phoneNumberId);
  if (number === undefined) return [`the WABA has no number with the AWS id ${tail(input.phoneNumberId)} (WhatsAppPhoneNumberId)`];
  if (number.metaPhoneNumberId !== input.metaPhoneNumberId) problems.push(`the Meta id of the number is ${tail(number.metaPhoneNumberId)}, not ${tail(input.metaPhoneNumberId)} (WhatsAppMetaPhoneNumberId)`);
  if (number.arn !== input.expectedArn) problems.push("the ARN phoneNumberArn() builds is not the number's ARN");
  if (input.numbers.length > 1) problems.push(`the WABA has ${input.numbers.length - 1} other number(s): a WABA of its own has only ours`);
  return problems;
}

async function main(): Promise<void> {
  const args: { stage?: string } = {};
  parseFlags(process.argv.slice(2), { "--stage": (value) => void (args.stage = value()) });
  if (args.stage !== STAGE) throw new RangeError(`--stage ${STAGE} is required (the only stage)`);
  const { GetLinkedWhatsAppBusinessAccountCommand, SocialMessagingClient } = await import("@aws-sdk/client-socialmessaging");
  const { whatsAppConnection } = await import("../../packages/bff/src/lib/secrets");
  const { CLIENT_TIMEOUTS, awsClientConfig } = await import("../../packages/bff/src/lib/clients");
  const { WHATSAPP_REGION, phoneNumberArn } = await import("../../packages/bff/src/channels/whatsapp/config");
  const connection = whatsAppConnection();
  if (connection === undefined) throw new RangeError("the WABA is not connected (secrets still not-connected): docs/pending.md P-01");
  const client = new SocialMessagingClient({ region: WHATSAPP_REGION, ...awsClientConfig(CLIENT_TIMEOUTS.socialMessaging) });
  const { account } = await client.send(new GetLinkedWhatsAppBusinessAccountCommand({ id: connection.wabaId }));
  const numbers = (account?.phoneNumbers ?? []).map((phone) => ({ phoneNumberId: phone.phoneNumberId ?? "", metaPhoneNumberId: phone.metaPhoneNumberId ?? "", arn: phone.arn ?? "" }));
  const problems = checkNumber({ phoneNumberId: connection.phoneNumberId, metaPhoneNumberId: connection.metaPhoneNumberId, expectedArn: phoneNumberArn(connection.phoneNumberId), numbers });
  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`channels:waba-check: ${problem}\n`);
    process.exit(1);
  }
  process.stdout.write(`channels:waba-check: AWS id ${tail(connection.phoneNumberId)}, Meta id ${tail(connection.metaPhoneNumberId)} and ARN match the WABA's number\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`channels:waba-check: ${error instanceof Error ? error.message : "failed"}\n`);
    process.exit(1);
  });
}
