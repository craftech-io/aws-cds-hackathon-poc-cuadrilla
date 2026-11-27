// The SMS client (ADR-0029): one transactional `Publish` straight to the number, one attempt only, and
// SNS's refusals mapped to what the screen says. A fake SNS client: nothing is texted.
import { PublishCommand } from "@aws-sdk/client-sns";
import { describe, expect, it } from "vitest";
import { CLIENT_TIMEOUTS } from "../lib/clients";
import { maskPhone, parseAccountPhone } from "./number";
import { memorySmsSender, snsSmsSender } from "./sms";

function fakeSns(fail?: string) {
  const sent: PublishCommand["input"][] = [];
  return {
    sent,
    client: {
      send: async (command: PublishCommand) => {
        sent.push(command.input);
        if (fail !== undefined) throw Object.assign(new Error("refused"), { name: fail });
        return { MessageId: "m-1" };
      },
    },
  };
}

describe("SMS of the code [FL-123]", () => {
  it("[FL-123] publishes one transactional SMS to the number itself, never to a topic", async () => {
    const sns = fakeSns();
    await snsSmsSender(sns.client as never).send({ phone: "+525512345678", text: "Tu código de Cuadrilla es 123456. Vence en 10 minutos." });
    expect(sns.sent).toEqual([
      { PhoneNumber: "+525512345678", Message: "Tu código de Cuadrilla es 123456. Vence en 10 minutos.", MessageAttributes: { "AWS.SNS.SMS.SMSType": { DataType: "String", StringValue: "Transactional" } } },
    ]);
    expect(sns.sent[0]).not.toHaveProperty("TopicArn");
  });

  it("[FL-123] has a timeout and a single attempt: a retry could deliver a second code", () => {
    expect(CLIENT_TIMEOUTS.sms).toMatchObject({ maxAttempts: 1, requestTimeoutMs: 5_000 });
  });

  it("[FL-123] a destination SNS will not take is SMS_NOT_DELIVERABLE; anything else SMS_UNAVAILABLE", async () => {
    await expect(snsSmsSender(fakeSns("InvalidParameterException").client as never).send({ phone: "+14155550100", text: "x" })).rejects.toMatchObject({ reason: "SMS_NOT_DELIVERABLE" });
    await expect(snsSmsSender(fakeSns("OptedOutException").client as never).send({ phone: "+14155550100", text: "x" })).rejects.toMatchObject({ reason: "SMS_NOT_DELIVERABLE" });
    await expect(snsSmsSender(fakeSns("ThrottlingException").client as never).send({ phone: "+14155550100", text: "x" })).rejects.toMatchObject({ reason: "SMS_UNAVAILABLE" });
  });

  it("[FL-123] the double keeps every message and hands back the last code", async () => {
    const sms = memorySmsSender();
    await sms.send({ phone: "+525512345678", text: "Tu código de Cuadrilla es 987654. Vence en 10 minutos." });
    expect(sms.lastCode()).toBe("987654");
    expect(sms.lastCode("+14155550100")).toBeUndefined();
  });

  it("[FL-123] the account's phone is E.164 of any country, typed with or without separators", () => {
    expect(parseAccountPhone(" +54 9 (11) 5555-0101 ")).toBe("+5491155550101");
    expect(parseAccountPhone("+81.3.1234.5678")).toBe("+81312345678");
    for (const bad of ["5491155550101", "+1234567", "+0123456789", "+1234567890123456", "+52 55 abc", 5491155550101]) expect(() => parseAccountPhone(bad)).toThrow();
    expect(maskPhone("+5491155550101")).toBe("•••• 0101");
  });
});
