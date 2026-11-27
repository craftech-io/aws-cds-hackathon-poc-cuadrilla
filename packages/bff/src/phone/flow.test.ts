// The SMS code as the second factor of every session (ADR-0029, docs/test-plan.md, FL-123 to FL-125):
// enrolment, sign-in, the code's life, the caps and the one-number-one-account index, over memory.
import { beforeEach, describe, expect, it } from "vitest";
import type { Principal } from "../auth/principal";
import { MemoryTableClient } from "../connector/memory/table-client";
import { createLogger } from "../lib/log";
import { type PhoneCaller, endPhoneSession, phoneStatusOf, sendPhoneCode, verifyPhoneCode } from "./flow";
import { PHONE_LIMITS, smsDayKey, smsForeignDayKey } from "./limits";
import { type MemoryPhone, memoryPhone } from "./testing";

const T0 = new Date("2026-11-27T15:00:00.000Z");
const IP = "203.0.113.10";
const PHONE = "+525512345678";
const lines: string[] = [];
const log = createLogger({ level: "debug", sink: (line) => void lines.push(line) });

interface Harness {
  readonly client: MemoryTableClient;
  readonly phone: MemoryPhone;
  readonly codes: string[];
  now: Date;
  advance(ms: number): void;
}

function harness(): Harness {
  const client = new MemoryTableClient();
  const codes: string[] = [];
  const h: Harness = {
    client,
    codes,
    now: T0,
    advance: (ms) => void (h.now = new Date(h.now.getTime() + ms)),
    phone: undefined as unknown as MemoryPhone,
  };
  let next = 0;
  Object.assign(h, { phone: memoryPhone({ client, now: () => h.now, codes: () => codes[next++] ?? "000000" }) });
  return h;
}

async function account(h: Harness, userId = "usr-guest-07", fields: Record<string, unknown> = {}): Promise<void> {
  const ispId = userId === "usr-adriana" ? "isp-demo" : "isp-guest-07";
  await h.client.put("Isps", {
    PK: `ISP#${ispId}`,
    SK: `USER#${userId}`,
    entity: "ConsoleUser",
    ispId,
    userId,
    role: ispId === "isp-demo" ? "SUPERVISOR" : "GUEST",
    name: "Persona",
    cognitoSub: `sub-${userId}`,
    cognitoSubKey: `SUB#sub-${userId}`,
    active: true,
    createdAt: T0.toISOString(),
    updatedAt: T0.toISOString(),
    version: 1,
    ...fields,
  });
}

function principal(userId = "usr-guest-07", sessionId = "jti-1"): Principal {
  const ispId = userId === "usr-adriana" ? "isp-demo" : "isp-guest-07";
  return {
    origin: "COGNITO",
    sub: `sub-${userId}`,
    username: userId,
    userId,
    ispId,
    clockId: ispId === "isp-demo" ? "GLOBAL#isp-demo" : `GUEST#${ispId}`,
    role: ispId === "isp-demo" ? "SUPERVISOR" : "GUEST",
    isGuest: ispId !== "isp-demo",
    authTime: Math.floor(T0.getTime() / 1000),
    sessionId,
  };
}

const caller = (who: Principal, viewerIp: string | undefined = IP): PhoneCaller => ({ principal: who, viewerIp, log });

async function enrol(h: Harness, who: Principal, phone = PHONE, code = "123456", ip = IP) {
  h.codes.push(code);
  await sendPhoneCode(h.phone.ports, caller(who, ip), { locale: "es-MX", phone });
  return verifyPhoneCode(h.phone.ports, caller(who, ip), code);
}

describe("enrolment: the first code of an account [FL-123]", () => {
  let h: Harness;
  beforeEach(async () => {
    h = harness();
    await account(h);
  });

  it("[FL-123] an account without a verified number is asked for one; the right code passes the session and the number becomes the account's", async () => {
    const who = principal();
    expect(await phoneStatusOf(h.phone.ports, caller(who))).toEqual({ state: "ENROL", codeSent: false });
    h.codes.push("482913");
    const sent = await sendPhoneCode(h.phone.ports, caller(who), { locale: "es-MX", phone: "+52 (55) 1234-5678" });
    expect(sent).toMatchObject({ state: "ENROL", phone: PHONE, codeSent: true, codeExpiresAt: new Date(T0.getTime() + 10 * 60_000).toISOString(), resendAt: new Date(T0.getTime() + 60_000).toISOString() });
    expect(h.phone.sms.sent).toEqual([{ phone: PHONE, text: "Tu código de Cuadrilla es 482913. Vence en 10 minutos." }]);
    // Only the digest of the code is stored.
    expect(JSON.stringify(h.client.dump("Runtime"))).not.toContain("482913");
    expect(await verifyPhoneCode(h.phone.ports, caller(who), "482913")).toEqual({ state: "PASSED", codeSent: false });
    expect(await h.client.get("Isps", { PK: "ISP#isp-guest-07", SK: "USER#usr-guest-07" })).toMatchObject({ phone: PHONE, phoneVerifiedAt: T0.toISOString() });
    expect(h.phone.afterPass).toEqual(["usr-guest-07"]);
    expect(await phoneStatusOf(h.phone.ports, caller(who))).toEqual({ state: "PASSED", codeSent: false });
    expect(lines.join("\n")).not.toContain("5512345678");
  });

  it("[FL-123] the SMS goes in the language of the screen", async () => {
    h.codes.push("111222");
    await sendPhoneCode(h.phone.ports, caller(principal()), { locale: "en", phone: PHONE });
    expect(h.phone.sms.sent[0]?.text).toBe("Your Cuadrilla code is 111222. It expires in 10 minutes.");
  });

  it("[FL-123] a number that is not international E.164, or none at all, is refused before any SMS", async () => {
    for (const phone of ["5512345678", "+1234567", "+0123456789", "+52 55 1234 5678 9999 1"]) {
      await expect(sendPhoneCode(h.phone.ports, caller(principal()), { locale: "es-MX", phone })).rejects.toMatchObject({ reason: "PHONE_INVALID" });
    }
    await expect(sendPhoneCode(h.phone.ports, caller(principal()), { locale: "es-MX" })).rejects.toMatchObject({ reason: "PHONE_REQUIRED" });
    expect(h.phone.sms.sent).toEqual([]);
  });

  it("[FL-123] a wrong code says so; the fifth wrong attempt invalidates the code, and even the right one no longer passes", async () => {
    const who = principal();
    h.codes.push("123456");
    await sendPhoneCode(h.phone.ports, caller(who), { locale: "es-MX", phone: PHONE });
    for (let attempt = 1; attempt < PHONE_LIMITS.maxAttempts; attempt += 1) {
      await expect(verifyPhoneCode(h.phone.ports, caller(who), "654321")).rejects.toMatchObject({ reason: "CODE_WRONG" });
    }
    await expect(verifyPhoneCode(h.phone.ports, caller(who), "654321")).rejects.toMatchObject({ reason: "CODE_EXHAUSTED" });
    await expect(verifyPhoneCode(h.phone.ports, caller(who), "123456")).rejects.toMatchObject({ reason: "CODE_EXPIRED" });
    expect(h.phone.afterPass).toEqual([]);
  });

  it("[FL-123] a code expires after 10 minutes (the date is compared, not only the TTL)", async () => {
    const who = principal();
    h.codes.push("123456");
    await sendPhoneCode(h.phone.ports, caller(who), { locale: "es-MX", phone: PHONE });
    h.advance(PHONE_LIMITS.codeTtlMs);
    await expect(verifyPhoneCode(h.phone.ports, caller(who), "123456")).rejects.toMatchObject({ reason: "CODE_EXPIRED" });
  });

  it("[FL-123] another code within the minute is RESEND_TOO_SOON; after it, the new code replaces the old one", async () => {
    const who = principal();
    h.codes.push("111111", "222222");
    await sendPhoneCode(h.phone.ports, caller(who), { locale: "es-MX", phone: PHONE });
    h.advance(59_000);
    await expect(sendPhoneCode(h.phone.ports, caller(who), { locale: "es-MX" })).rejects.toMatchObject({ reason: "RESEND_TOO_SOON" });
    h.advance(1_000);
    await sendPhoneCode(h.phone.ports, caller(who), { locale: "es-MX" });
    expect(h.phone.sms.sent.map((sms) => sms.phone)).toEqual([PHONE, PHONE]);
    await expect(verifyPhoneCode(h.phone.ports, caller(who), "111111")).rejects.toMatchObject({ reason: "CODE_WRONG" });
    expect(await verifyPhoneCode(h.phone.ports, caller(who), "222222")).toMatchObject({ state: "PASSED" });
  });

  it("[FL-123] a number another account verified is PHONE_IN_USE, before any SMS", async () => {
    await account(h, "usr-guest-08");
    await enrol(h, principal("usr-guest-08"));
    const sent = h.phone.sms.sent.length;
    await expect(sendPhoneCode(h.phone.ports, caller(principal()), { locale: "es-MX", phone: PHONE })).rejects.toMatchObject({ reason: "PHONE_IN_USE" });
    expect(h.phone.sms.sent).toHaveLength(sent);
  });

  it("[FL-123] two accounts racing for one number: only the first to check its code keeps it", async () => {
    await account(h, "usr-guest-08");
    h.codes.push("111111", "222222");
    await sendPhoneCode(h.phone.ports, caller(principal()), { locale: "es-MX", phone: PHONE });
    await sendPhoneCode(h.phone.ports, caller(principal("usr-guest-08")), { locale: "es-MX", phone: PHONE });
    await verifyPhoneCode(h.phone.ports, caller(principal()), "111111");
    await expect(verifyPhoneCode(h.phone.ports, caller(principal("usr-guest-08")), "222222")).rejects.toMatchObject({ reason: "PHONE_IN_USE" });
  });

  it("[FL-123] a number SNS cannot deliver to: SMS_NOT_DELIVERABLE and no code left behind", async () => {
    h.phone.sms.failWith = "SMS_NOT_DELIVERABLE";
    await expect(sendPhoneCode(h.phone.ports, caller(principal()), { locale: "es-MX", phone: "+14155550100" })).rejects.toMatchObject({ reason: "SMS_NOT_DELIVERABLE" });
    expect(await phoneStatusOf(h.phone.ports, caller(principal()))).toMatchObject({ state: "ENROL", codeSent: false });
  });

  it("[FL-123] off the edge (no viewer IP) no SMS is sent", async () => {
    await expect(sendPhoneCode(h.phone.ports, { principal: principal(), viewerIp: undefined, log }, { locale: "es-MX", phone: PHONE })).rejects.toMatchObject({ reason: "NO_VIEWER" });
    expect(h.phone.sms.sent).toEqual([]);
  });

  it("[FL-125] an account marked AUTOMATION by the operator is PASSED and never texted", async () => {
    await account(h, "usr-guest-08", { phoneCheck: "AUTOMATION" });
    const who = principal("usr-guest-08");
    expect(await phoneStatusOf(h.phone.ports, caller(who))).toEqual({ state: "PASSED", codeSent: false });
    expect(await sendPhoneCode(h.phone.ports, caller(who), { locale: "es-MX", phone: PHONE })).toMatchObject({ state: "PASSED" });
    expect(h.phone.sms.sent).toEqual([]);
  });
});

describe("sign-in: the code of every later session [FL-124]", () => {
  let h: Harness;
  beforeEach(async () => {
    h = harness();
    await account(h);
    await enrol(h, principal("usr-guest-07", "jti-1"));
  });

  it("[FL-124] a new session (another password typed) asks for its own code, to the verified number shown by its last digits", async () => {
    const second = principal("usr-guest-07", "jti-2");
    expect(await phoneStatusOf(h.phone.ports, caller(second))).toEqual({ state: "SIGN_IN", maskedPhone: "•••• 5678", codeSent: false });
    h.advance(60_000);
    h.codes.push("765432");
    await sendPhoneCode(h.phone.ports, caller(second), { locale: "es-MX" });
    expect(h.phone.sms.sent.at(-1)?.phone).toBe(PHONE);
    expect(await verifyPhoneCode(h.phone.ports, caller(second), "765432")).toMatchObject({ state: "PASSED" });
    // The first session stays passed; a refresh keeps the same session id and asks for nothing.
    expect(await phoneStatusOf(h.phone.ports, caller(principal("usr-guest-07", "jti-1")))).toMatchObject({ state: "PASSED" });
  });

  it("[FL-124] the verified number can never be changed by the user, passed or not", async () => {
    for (const session of ["jti-1", "jti-3"]) {
      const who = principal("usr-guest-07", session);
      const answer = sendPhoneCode(h.phone.ports, caller(who), { locale: "es-MX", phone: "+525599999999" });
      if (session === "jti-1") await expect(answer).resolves.toMatchObject({ state: "PASSED" });
      else await expect(answer).rejects.toMatchObject({ reason: "PHONE_LOCKED" });
    }
    expect(h.phone.sms.sent.map((sms) => sms.phone)).toEqual([PHONE]);
    expect(await h.client.get("Isps", { PK: "ISP#isp-guest-07", SK: "USER#usr-guest-07" })).toMatchObject({ phone: PHONE });
  });

  it("[FL-124] the sign-out deletes the session's mark: the same session id asks for a code again", async () => {
    const who = principal("usr-guest-07", "jti-1");
    expect(await endPhoneSession(h.phone.ports, caller(who))).toEqual({ ended: true });
    expect(await h.phone.gate.passed(who)).toBe(false);
    expect(await phoneStatusOf(h.phone.ports, caller(who))).toMatchObject({ state: "SIGN_IN" });
  });

  it("[FL-124] a passed session ends with its sign-in's life (12 hours)", async () => {
    h.advance(PHONE_LIMITS.sessionTtlMs);
    expect(await phoneStatusOf(h.phone.ports, caller(principal("usr-guest-07", "jti-1")))).toMatchObject({ state: "SIGN_IN" });
  });
});

describe("caps of the SMS [FL-123]", () => {
  let h: Harness;
  beforeEach(async () => {
    h = harness();
    await account(h);
  });

  const sendTo = (phone: string, ip: string, who = principal()) => sendPhoneCode(h.phone.ports, caller(who, ip), { locale: "es-MX", phone });

  it("[FL-123] 6 SMS per account per day, whatever the numbers and the connections", async () => {
    for (let n = 1; n <= PHONE_LIMITS.smsPerAccountPerDay; n += 1) {
      await sendTo(`+52550000000${n}`, `203.0.113.${n}`);
      h.advance(60_000);
    }
    await expect(sendTo("+525500000009", "203.0.113.99")).rejects.toMatchObject({ code: "CAP_REACHED", reason: "SMS_ACCOUNT_LIMIT" });
  });

  it("[FL-123] 3 SMS per number per day", async () => {
    for (let n = 1; n <= PHONE_LIMITS.smsPerNumberPerDay; n += 1) {
      await sendTo(PHONE, `203.0.113.${n}`);
      h.advance(60_000);
    }
    await expect(sendTo(PHONE, "203.0.113.99")).rejects.toMatchObject({ reason: "SMS_NUMBER_LIMIT" });
  });

  it("[FL-123] 5 SMS per IP per day", async () => {
    for (let n = 1; n <= PHONE_LIMITS.smsPerIpPerDay; n += 1) {
      await sendTo(`+52550000000${n}`, IP);
      h.advance(60_000);
    }
    await expect(sendTo("+525500000009", IP)).rejects.toMatchObject({ reason: "SMS_IP_LIMIT" });
  });

  it("[FL-123] 40 SMS per day in the whole demo; the next day starts over", async () => {
    expect(PHONE_LIMITS.smsPerDay).toBe(40);
    await h.client.put("Runtime", { PK: smsDayKey(T0), SK: "META", used: PHONE_LIMITS.smsPerDay });
    await expect(sendTo(PHONE, IP)).rejects.toMatchObject({ reason: "SMS_DAILY_LIMIT" });
    expect(h.phone.sms.sent).toEqual([]);
    h.advance(86_400_000);
    await expect(sendTo(PHONE, IP)).resolves.toMatchObject({ codeSent: true });
  });

  it("[FL-123] a number of the home region never takes the foreign quota", async () => {
    for (const [n, phone] of ["+5491123456781", "+56912345678", "+18095550123"].entries()) {
      await sendTo(phone, `203.0.113.${n + 1}`);
      h.advance(60_000);
    }
    expect(h.phone.sms.sent).toHaveLength(3);
    expect(await h.client.get("Runtime", { PK: smsForeignDayKey(T0), SK: "META" })).toBeUndefined();
    expect(await h.client.get("Runtime", { PK: smsDayKey(T0), SK: "META" })).toMatchObject({ used: 3 });
  });

  it("[FL-123] numbers of the Americas outside the home region share 5 SMS a day in the whole demo: the sixth is SMS_FOREIGN_LIMIT, a home number still goes out", async () => {
    expect(PHONE_LIMITS.smsForeignPerDay).toBe(5);
    const foreign = ["+14155550101", "+14165550123", "+5352345678", "+50937123456", "+13105550199"];
    for (const [n, phone] of foreign.entries()) {
      await sendTo(phone, `203.0.113.${n + 1}`);
      h.advance(60_000);
    }
    expect(await h.client.get("Runtime", { PK: smsForeignDayKey(T0), SK: "META" })).toMatchObject({ used: 5 });
    await expect(sendTo("+16465550142", "203.0.113.50")).rejects.toMatchObject({ code: "CAP_REACHED", reason: "SMS_FOREIGN_LIMIT" });
    expect(h.phone.sms.sent).toHaveLength(5);
    await account(h, "usr-guest-08");
    await expect(sendTo(PHONE, "203.0.113.51", principal("usr-guest-08"))).resolves.toMatchObject({ codeSent: true });
    expect(h.phone.sms.sent).toHaveLength(6);
  });

  it("[FL-123] a range that is no person's mobile is refused when the number is typed; filler is an invalid phone", async () => {
    for (const phone of ["+31970123456789", "+447012345678", "+882161234567", "+883510012345", "+870771234567", "+881612345678", "+88812345678", "+97912345678"]) {
      await expect(sendTo(phone, IP)).rejects.toMatchObject({ reason: "PHONE_NOT_PERSONAL" });
    }
    await expect(sendTo("+5491100000000", IP)).rejects.toMatchObject({ reason: "PHONE_INVALID" });
    expect(h.phone.sms.sent).toEqual([]);
  });

  it("[FL-123] a number outside the Americas is refused when typed or corrected, before any SMS or counter", async () => {
    for (const phone of ["+34612345678", "+447911123456", "+819012345678", "+8613812345678"]) {
      await expect(sendTo(phone, IP)).rejects.toMatchObject({ code: "INVALID", reason: "PHONE_COUNTRY_NOT_ALLOWED" });
    }
    expect(h.phone.sms.sent).toEqual([]);
    expect(h.client.dump("Runtime").filter((row) => String(row.PK).startsWith("PHONESMS#"))).toEqual([]);
    await expect(sendTo("+14155550101", IP)).resolves.toMatchObject({ codeSent: true });
  });

  it("[FL-124] the sign-in of an account verified with a number outside the Americas gets no SMS: PHONE_COUNTRY_NOT_ALLOWED", async () => {
    await account(h, "usr-guest-09", { phone: "+34612345678", phoneVerifiedAt: T0.toISOString() });
    const who = principal("usr-guest-09");
    expect(await phoneStatusOf(h.phone.ports, caller(who))).toMatchObject({ state: "SIGN_IN", maskedPhone: "•••• 5678" });
    await expect(sendPhoneCode(h.phone.ports, caller(who), { locale: "es-MX" })).rejects.toMatchObject({ reason: "PHONE_COUNTRY_NOT_ALLOWED" });
    expect(h.phone.sms.sent).toEqual([]);
    expect(h.client.dump("Runtime").filter((row) => String(row.PK).startsWith("PHONESMS#"))).toEqual([]);
  });
});
