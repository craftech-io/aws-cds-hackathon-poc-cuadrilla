import { describe, expect, it } from "vitest";
import { readSignupEnv } from "./env";

const URL_OF_ACL = "https://abc123.us-east-1.sdk.awswaf.com/abc123/def456/";

describe("the sign-up's build variables [FL-114]", () => {
  it("[FL-114] a deployed build behind the shared edge ACL has no integration URL and is configured; an http URL is refused", () => {
    expect(readSignupEnv({ PROD: true, VITE_COGNITO_SIGNUP_CLIENT_ID: "client", VITE_WAF_INTEGRATION_URL: "" })).toEqual({ ok: true, env: { signupClientId: "client" } });
    expect(readSignupEnv({ PROD: true, VITE_COGNITO_SIGNUP_CLIENT_ID: "client" })).toEqual({ ok: true, env: { signupClientId: "client" } });
    expect(readSignupEnv({ PROD: true, VITE_COGNITO_SIGNUP_CLIENT_ID: "client", VITE_WAF_INTEGRATION_URL: "http://abc.sdk.awswaf.com/a/b/" }).ok).toBe(false);
  });

  it("a build with an integration URL, for an edge ACL that challenges the sign-up, keeps it", () => {
    expect(readSignupEnv({ PROD: true, VITE_COGNITO_SIGNUP_CLIENT_ID: "client", VITE_WAF_INTEGRATION_URL: URL_OF_ACL })).toEqual({ ok: true, env: { signupClientId: "client", wafIntegrationUrl: URL_OF_ACL } });
    expect(readSignupEnv({ PROD: false, VITE_COGNITO_SIGNUP_CLIENT_ID: "client", VITE_WAF_INTEGRATION_URL: "" })).toEqual({ ok: true, env: { signupClientId: "client" } });
  });

  it("the sign-up client is always required", () => {
    expect(readSignupEnv({ PROD: false, VITE_WAF_INTEGRATION_URL: URL_OF_ACL })).toEqual({ ok: false, missing: ["VITE_COGNITO_SIGNUP_CLIENT_ID"] });
  });
});
