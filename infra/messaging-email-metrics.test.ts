// The authentication emails and the configuration set (ADR-0025 §4): the pool sends through the app's
// configuration set once the identity is verified, and Cognito's untagged emails never reach
// ChannelEvents. No CloudWatch destination and no alarm (P-07, logs only, ADR-0028).
import { describe, expect, it } from "vitest";
import { EMAIL_TAG_NAMES } from "../packages/bff/src/channels/email/tags";
import { emailSenderFor } from "./auth-email";
import { CONFIGURATION_SET_NAME, emailEventPattern } from "./messaging-email-spec";

const APP_DOMAIN = "cuadrilla.demo.craftech.io";
const IDENTITY = { domain: APP_DOMAIN, arn: `arn:aws:ses:us-east-1:776805327629:identity/${APP_DOMAIN}`, verified: true };

describe("the pool sends through the configuration set", () => {
  it("[FL-112] names the app's configuration set once Cognito sends with SES (DEVELOPER)", () => {
    const { configuration } = emailSenderFor(IDENTITY, APP_DOMAIN);
    expect(configuration).toMatchObject({ emailSendingAccount: "DEVELOPER", configurationSet: CONFIGURATION_SET_NAME });
    expect(CONFIGURATION_SET_NAME).toBe("aws-cds-hackathon-poc-cuadrilla-email-poc");
  });

  it("keeps Cognito's default sender, which takes no configuration set, until the identity is verified", () => {
    expect(emailSenderFor({ ...IDENTITY, verified: false }, APP_DOMAIN).configuration).toEqual({ emailSendingAccount: "COGNITO_DEFAULT" });
    expect(emailSenderFor(undefined, APP_DOMAIN).configuration).toEqual({ emailSendingAccount: "COGNITO_DEFAULT" });
  });

  it("keeps Cognito's emails, and the visitor's address, away from ChannelEvents", () => {
    const tags = emailEventPattern().detail.mail.tags;
    expect(tags.mailId).toEqual([{ exists: true }]);
    expect(EMAIL_TAG_NAMES).toContain("mailId");
  });
});
