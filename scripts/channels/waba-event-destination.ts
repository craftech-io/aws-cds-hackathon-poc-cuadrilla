// Points the WhatsApp Business Account's events at the stage's own topic
// `aws-cds-hackathon-poc-cuadrilla-wa-inbound` (docs/pending.md P-01 step 7, docs/architecture-integrations.md
// §4.4, option A: a WABA of its own). A WABA has a single event destination shared by all its numbers, and
// the account is shared with another app, so the script never replaces anything that is not ours:
//
//   the WABA has a number that is not ours        abort (OTHER_NUMBERS), also with --apply
//   the WABA sends its events somewhere else      abort (OTHER_DESTINATION), also with --apply
//   it already sends them to our topic            nothing to do (ALREADY_SET)
//   no destination yet                            WOULD_SET; with --apply, SET
//
// Runs inside `sst shell` with the operator's profile once the WABA is connected (no role of the app or of
// CI holds `PutWhatsAppBusinessAccountEventDestinations`). SDK commands, checked in the installed
// `@aws-sdk/client-socialmessaging` `.d.ts`: `GetLinkedWhatsAppBusinessAccountCommand {id}` →
// `account{arn, eventDestinations[{eventDestinationArn}], phoneNumbers[{phoneNumberId, metaPhoneNumberId, arn}]}`
// and `PutWhatsAppBusinessAccountEventDestinationsCommand {id, eventDestinations}`. The topic's account and
// region come from the linked WABA's ARN. Ids are never printed whole.
//
//   npm run channels:waba-event-destination -- --stage poc
//   npm run channels:waba-event-destination -- --stage poc --apply
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFlags } from "./cli-args";

export const STAGE = "poc";
/** `<app>-wa-inbound` (infra/messaging-whatsapp.ts `WA_INBOUND_TOPIC_NAME`). */
export const TOPIC_NAME = "aws-cds-hackathon-poc-cuadrilla-wa-inbound";

export interface DestinationArgs {
  readonly apply: boolean;
}

export function parseDestinationArgs(argv: readonly string[]): DestinationArgs {
  const args: { stage?: string; apply?: boolean } = {};
  parseFlags(argv, { "--stage": (value) => void (args.stage = value()), "--apply": () => void (args.apply = true) });
  if (args.stage !== STAGE) throw new RangeError(`--stage ${STAGE} is required (the only stage)`);
  return { apply: args.apply === true };
}

/** `arn:aws:sns:<region>:<account>:<topic>` from the WABA's own ARN (`arn:aws:social-messaging:<region>:<account>:waba/<id>`). */
export function topicArnFor(wabaArn: string): string {
  const [, partition, service, region, account] = wabaArn.split(":");
  if (service !== "social-messaging" || !region || !/^\d{12}$/.test(account ?? "")) throw new RangeError("unexpected ARN of the linked WABA");
  return `arn:${partition ?? "aws"}:sns:${region}:${account ?? ""}:${TOPIC_NAME}`;
}

export interface LinkedWaba {
  readonly arn: string;
  readonly eventDestinations: readonly string[];
  readonly phoneNumberIds: readonly string[];
}

export interface DestinationDeps {
  get(wabaId: string): Promise<LinkedWaba>;
  put(wabaId: string, topicArn: string): Promise<void>;
  /** WABA id and the AWS id of our number; `undefined` until P-01 connects them. */
  connection(): { readonly wabaId: string; readonly phoneNumberId: string } | undefined;
  report(line: string): void;
}

export type DestinationOutcome = "ALREADY_SET" | "WOULD_SET" | "SET";

export class DestinationRefused extends Error {
  override readonly name = "DestinationRefused";
  constructor(readonly reason: "OTHER_NUMBERS" | "OTHER_DESTINATION" | "NOT_CONNECTED", message: string) {
    super(message);
  }
}

export async function runDestination(args: DestinationArgs, deps: DestinationDeps): Promise<DestinationOutcome> {
  const connection = deps.connection();
  if (connection === undefined) throw new DestinationRefused("NOT_CONNECTED", "the WABA is not connected (secrets still not-connected): close docs/pending.md P-01 first");
  const waba = await deps.get(connection.wabaId);
  const topicArn = topicArnFor(waba.arn);
  const others = waba.phoneNumberIds.filter((id) => id !== connection.phoneNumberId);
  if (others.length > 0 || !waba.phoneNumberIds.includes(connection.phoneNumberId)) {
    throw new DestinationRefused("OTHER_NUMBERS", `the WABA has ${others.length} number(s) that are not ours: its single destination is not ours to set`);
  }
  const foreign = waba.eventDestinations.filter((arn) => arn !== topicArn);
  if (foreign.length > 0) throw new DestinationRefused("OTHER_DESTINATION", "the WABA sends its events to another destination: nothing is replaced");
  if (waba.eventDestinations.length === 1) {
    deps.report(`events already go to ${TOPIC_NAME}`);
    return "ALREADY_SET";
  }
  if (!args.apply) {
    deps.report(`would send the WABA's events to ${TOPIC_NAME} (run with --apply)`);
    return "WOULD_SET";
  }
  await deps.put(connection.wabaId, topicArn);
  deps.report(`events now go to ${TOPIC_NAME}`);
  return "SET";
}

async function stageDeps(): Promise<DestinationDeps> {
  const { GetLinkedWhatsAppBusinessAccountCommand, PutWhatsAppBusinessAccountEventDestinationsCommand, SocialMessagingClient } = await import("@aws-sdk/client-socialmessaging");
  const { whatsAppConnection } = await import("../../packages/bff/src/lib/secrets");
  const { CLIENT_TIMEOUTS, awsClientConfig } = await import("../../packages/bff/src/lib/clients");
  const { WHATSAPP_REGION } = await import("../../packages/bff/src/channels/whatsapp/config");
  const client = new SocialMessagingClient({ region: WHATSAPP_REGION, ...awsClientConfig(CLIENT_TIMEOUTS.socialMessaging) });
  return {
    async get(id) {
      const { account } = await client.send(new GetLinkedWhatsAppBusinessAccountCommand({ id }));
      if (account?.arn === undefined) throw new Error("the WABA is not linked to this account");
      return {
        arn: account.arn,
        eventDestinations: (account.eventDestinations ?? []).flatMap((destination) => (destination.eventDestinationArn ? [destination.eventDestinationArn] : [])),
        phoneNumberIds: (account.phoneNumbers ?? []).flatMap((phone) => (phone.phoneNumberId ? [phone.phoneNumberId] : [])),
      };
    },
    async put(id, topicArn) {
      await client.send(new PutWhatsAppBusinessAccountEventDestinationsCommand({ id, eventDestinations: [{ eventDestinationArn: topicArn }] }));
    },
    connection: () => {
      const connected = whatsAppConnection();
      return connected === undefined ? undefined : { wabaId: connected.wabaId, phoneNumberId: connected.phoneNumberId };
    },
    report: (line) => void process.stdout.write(`channels:waba-event-destination: ${line}\n`),
  };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseDestinationArgs(process.argv.slice(2));
  stageDeps()
    .then((deps) => runDestination(args, deps))
    .catch((error: unknown) => {
      process.stderr.write(`channels:waba-event-destination: ${error instanceof Error ? error.message : "failed"}\n`);
      process.exit(1);
    });
}
