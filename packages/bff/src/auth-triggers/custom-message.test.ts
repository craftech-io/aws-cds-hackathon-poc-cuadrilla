import type { CustomMessageTriggerEvent } from "aws-lambda";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../lib/log";
import { createKillSwitchReader, setKillSwitch } from "../ops/kill-switch";
import { type MemoryRuntimeStore, createMemoryRuntimeStore } from "../ops/memory-runtime-store";
import { findNeutralTerms } from "../../../../scripts/lint/neutral-terms";
import { createCustomMessageHandler } from "./custom-message";

// A stage in co-branding: the trigger must not care (it neither links nor reads BrandConfig).
const PARTNER = "Design Partner Demo";
vi.mock("sst", () => ({
  Resource: new Proxy(
    {},
    {
      get(_target, name) {
        if (name === "BrandConfig") return { value: JSON.stringify({ mode: "cobrand", signupMode: "cobrand", partnerDisplayName: "Design Partner Demo" }) };
        throw new Error(`${String(name)} is not linked to this function`);
      },
    },
  ),
}));

const ORIGIN = "https://cuadrilla.demo.craftech.io";
const HOSTILE_NAME = "Gana dinero en https://estafa.example/premio ahora";

function event(triggerSource: string, userAttributes: Record<string, string> = {}): CustomMessageTriggerEvent {
  return {
    version: "1",
    region: "us-east-1",
    userPoolId: "us-east-1_TESTPOOL1",
    userName: "gst-01K80000000000000000000001",
    callerContext: { awsSdkVersion: "3", clientId: "guest-signup-client" },
    triggerSource,
    request: { userAttributes: { email: "ana.prueba@example.com", name: HOSTILE_NAME, ...userAttributes }, codeParameter: "{####}", usernameParameter: "{username}", linkParameter: "{##Click##}" },
    response: { smsMessage: null, emailMessage: null, emailSubject: null },
  } as CustomMessageTriggerEvent;
}

describe("custom message trigger [FL-104] [FL-106] [FL-109] [FL-112]", () => {
  let kill: MemoryRuntimeStore;
  let lines: string[];
  const handler = () =>
    createCustomMessageHandler(
      (log) => ({ kill: createKillSwitchReader({ store: kill, ttlMs: 0 }), origin: ORIGIN, log }),
      () => createLogger({ sink: (line) => void lines.push(line) }),
    );
  const outcome = async (source: string, attributes: Record<string, string> = {}): Promise<string> => {
    try {
      const answer = await handler()(event(source, attributes));
      return `${answer.response.emailSubject}\n${answer.response.emailMessage}`;
    } catch (error) {
      return `REFUSED ${error instanceof Error ? error.message : String(error)}`;
    }
  };

  beforeEach(() => {
    kill = createMemoryRuntimeStore();
    lines = [];
  });

  it("[FL-104] sign-up, resend, recovery and invitation, in es-MX by default and en by locale, with the code and the neutral brand", async () => {
    for (const source of ["CustomMessage_SignUp", "CustomMessage_ResendCode", "CustomMessage_ForgotPassword", "CustomMessage_AdminCreateUser"]) {
      const spanish = await outcome(source);
      const english = await outcome(source, { locale: "en" });
      for (const email of [spanish, english]) {
        expect(email, source).toContain("{####}");
        expect(email).toContain("Cuadrilla");
        expect(email).not.toContain(PARTNER);
        expect(email).not.toContain("Cuadrilla for");
        expect(findNeutralTerms(source, email)).toEqual([]);
      }
      expect(spanish).toContain('lang="es-MX"');
      expect(english).toContain('lang="en"');
    }
    expect(await outcome("CustomMessage_AdminCreateUser")).toContain("{username}");
  });

  it("[FL-104] never interpolates an attribute the user wrote: a name with a link leaves no trace", async () => {
    for (const source of ["CustomMessage_SignUp", "CustomMessage_ResendCode", "CustomMessage_ForgotPassword", "CustomMessage_AdminCreateUser"]) {
      const email = await outcome(source, { name: HOSTILE_NAME, locale: "en" });
      expect(email).not.toContain("estafa");
      expect(email).not.toContain("Gana dinero");
      expect(email).not.toContain("ana.prueba@example.com");
    }
  });

  it("[FL-112] with KILL#SIGNUP or KILL#ALL, the sign-up code and its resend are not sent; the recovery and the invitation go on", async () => {
    for (const scope of ["SIGNUP", "ALL"] as const) {
      kill = createMemoryRuntimeStore();
      await setKillSwitch({ store: kill }, { scope, on: true, actor: "OPERATOR" });
      expect(await outcome("CustomMessage_SignUp")).toBe("REFUSED CAP_REACHED");
      expect(await outcome("CustomMessage_ResendCode")).toBe("REFUSED CAP_REACHED");
      expect(await outcome("CustomMessage_ForgotPassword")).toContain("{####}");
      expect(await outcome("CustomMessage_AdminCreateUser")).toContain("{####}");
    }
    expect(lines.join("\n")).toContain('"metric":"SignupCodeWithheld"');
  });

  it("[FL-104] refuses a change or a verification of an attribute, and anything it does not know", async () => {
    for (const source of ["CustomMessage_UpdateUserAttribute", "CustomMessage_VerifyUserAttribute", "CustomMessage_Authentication", "CustomMessage_Other"]) {
      expect(await outcome(source)).toBe("REFUSED SOURCE_NOT_ALLOWED");
    }
  });

  it("fails closed when the cut cannot be read: no sign-up code goes out", async () => {
    const broken = createCustomMessageHandler(
      (log) => ({ kill: { status: () => Promise.reject(new Error("Runtime down")) }, origin: ORIGIN, log }),
      () => createLogger({ sink: (line) => void lines.push(line) }),
    );
    await expect(broken(event("CustomMessage_SignUp"))).rejects.toThrow("Runtime down");
    await expect(broken(event("CustomMessage_ForgotPassword"))).resolves.toMatchObject({ response: { emailMessage: expect.stringContaining("{####}") } });
  });
});
