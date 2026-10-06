import { describe, expect, it } from "vitest";
import { probeUsername, signUpRefused } from "./edge-probes";

describe("qa:edge-probes", () => {
  it("[FL-113] a SignUp without a ticket counts as refused only with the pre sign-up's error, or ConsoleWeb's attribute refusal", () => {
    expect(signUpRefused("GuestSignup", "UserLambdaValidationException")).toBe(true);
    expect(signUpRefused("ConsoleWeb", "UserLambdaValidationException")).toBe(true);
    expect(signUpRefused("ConsoleWeb", "NotAuthorizedException")).toBe(true);
    expect(signUpRefused("GuestSignup", "NotAuthorizedException")).toBe(false);
    expect(signUpRefused("GuestSignup", "")).toBe(false);
    expect(signUpRefused("ConsoleWeb", "InvalidParameterException")).toBe(false);
  });

  it("[FL-113] the probe's user name has the shape signup.start issues", () => {
    expect(probeUsername(Date.UTC(2026, 8, 27))).toMatch(/^gst-[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});
