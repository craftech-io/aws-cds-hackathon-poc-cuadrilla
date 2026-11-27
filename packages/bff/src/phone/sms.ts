// The one client of the SMS channel (ADR-0029): Amazon SNS `Publish` straight to a phone number, as a
// transactional SMS, with the SDK v3, a 5 s timeout and ONE attempt (lib/clients.ts `sms`): a retry
// could deliver a second code. Behind the `SmsSender` port, so the tests, the local flows and the UI
// server use `memorySmsSender` and nothing sends a real SMS. Never the WhatsApp simulator: this is the
// real phone of the person who signs in.
//
// SNS answers a number it cannot deliver to (a country that needs a registered sender, an invalid
// destination, an opted-out phone) with a client error: `SMS_NOT_DELIVERABLE`, which the screen turns
// into "we cannot send SMS to this number, write to Craftech". Anything else is `SMS_UNAVAILABLE`.
// The number and the text never reach a log.
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import { ToolError } from "@cuadrilla/shared";
import { CLIENT_TIMEOUTS, awsClientConfig } from "../lib/clients";

export interface SmsMessage {
  /** E.164. */
  readonly phone: string;
  readonly text: string;
}

export interface SmsSender {
  send(message: SmsMessage): Promise<void>;
}

/** SNS error names that mean "this destination does not take our SMS", not an outage. */
const UNDELIVERABLE = new Set(["InvalidParameterException", "InvalidParameterValueException", "OptedOutException", "InvalidParameter", "OptedOut"]);

export function snsSmsSender(client?: Pick<SNSClient, "send">): SmsSender {
  let sns = client;
  return {
    async send(message) {
      sns ??= new SNSClient(awsClientConfig(CLIENT_TIMEOUTS.sms));
      try {
        await sns.send(
          new PublishCommand({
            PhoneNumber: message.phone,
            Message: message.text,
            MessageAttributes: { "AWS.SNS.SMS.SMSType": { DataType: "String", StringValue: "Transactional" } },
          }),
        );
      } catch (error) {
        const name = error instanceof Error ? error.name : "";
        if (UNDELIVERABLE.has(name)) throw new ToolError("UNAVAILABLE", "SMS cannot be delivered to this number", "SMS_NOT_DELIVERABLE");
        throw new ToolError("UNAVAILABLE", "the code could not be sent right now", "SMS_UNAVAILABLE");
      }
    },
  };
}

export interface MemorySmsSender extends SmsSender {
  readonly sent: SmsMessage[];
  /** The next sends fail with this reason (`SMS_NOT_DELIVERABLE`, `SMS_UNAVAILABLE`). */
  failWith: string | undefined;
  /** The six digits of the last SMS to a number (the UI server's helper reads it). */
  lastCode(phone?: string): string | undefined;
}

/** The double of the tests, the local flows and the UI server: keeps every message, sends nothing. */
export function memorySmsSender(): MemorySmsSender {
  const sender: MemorySmsSender = {
    sent: [],
    failWith: undefined,
    async send(message) {
      if (sender.failWith !== undefined) throw new ToolError("UNAVAILABLE", "the code could not be sent", sender.failWith);
      sender.sent.push(message);
    },
    lastCode(phone) {
      const last = [...sender.sent].reverse().find((message) => phone === undefined || message.phone === phone);
      return last === undefined ? undefined : /\b(\d{6})\b/.exec(last.text)?.[1];
    },
  };
  return sender;
}
