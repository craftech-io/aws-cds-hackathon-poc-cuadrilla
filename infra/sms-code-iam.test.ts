// The SMS code of every sign-in (ADR-0029) in IAM: SNS `Publish` straight to a phone number takes no
// resource ARN, so only the Bff holds it on `*`, always next to a Deny of every topic ARN.
import { describe, expect, it } from "vitest";
import { LAMBDA_CAPABILITIES, type LambdaName, SMS_CODE_GRANTS, expectedGrants } from "./iam-capabilities";

describe("SMS code permissions [FL-123]", () => {
  it("[FL-123] gives sns:Publish on * only to the Bff, always next to the Deny of every topic ARN (direct SMS only)", () => {
    for (const [role, grant] of (Object.keys(LAMBDA_CAPABILITIES) as LambdaName[]).flatMap((role) => expectedGrants(role).map((grant) => [role, grant] as const))) {
      if (!grant.actions.includes("sns:Publish") || !grant.resources.includes("*")) continue;
      expect(role).toBe("Bff");
    }
    expect(expectedGrants("Bff")).toEqual(expect.arrayContaining([...SMS_CODE_GRANTS]));
    expect(SMS_CODE_GRANTS).toEqual([
      { sid: "SmsCodeToPhoneNumbers", actions: ["sns:Publish"], resources: ["*"] },
      { sid: "NoPublishToTopics", effect: "Deny", actions: ["sns:Publish"], resources: ["arn:aws:sns:*:*:*"] },
    ]);
  });
});
