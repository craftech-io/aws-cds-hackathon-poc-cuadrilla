import { describe, expect, it } from "vitest";
import { CognitoError, createCognitoApi, regionOfPool } from "./cognito";
import { signupErrorCodeOf } from "./errors";
import { createSignupCognitoApi } from "./signup-cognito";
import type { FetchRetryOptions } from "../http";

interface Sent {
  readonly url: string;
  readonly init: RequestInit;
  readonly options: FetchRetryOptions | undefined;
}

/** Answers every call with `body`, or with `body[<operation>]` when it is keyed by operation. */
function fakeFetch(status: number, body: unknown, byOperation = false) {
  const sent: Sent[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit, options?: FetchRetryOptions) => {
    const request = { url: String(input), init: init ?? {}, options };
    sent.push(request);
    const operation = (headersOf(request).get("x-amz-target") ?? "").split(".")[1] ?? "";
    const answer = byOperation ? (body as Record<string, unknown>)[operation] : body;
    return new Response(JSON.stringify(answer), { status, headers: { "content-type": "application/x-amz-json-1.1" } });
  };
  return { sent, fetch };
}

function bodyOf(sent: Sent): Record<string, unknown> {
  return JSON.parse(String(sent.init.body)) as Record<string, unknown>;
}

function headersOf(sent: Sent): Headers {
  return new Headers(sent.init.headers);
}

describe("Cognito API over fetch", () => {
  it("starts USER_SRP_AUTH with the public client id and no credentials", async () => {
    const { sent, fetch } = fakeFetch(200, { ChallengeName: "PASSWORD_VERIFIER", ChallengeParameters: { SRP_B: "ab" } });
    const api = createCognitoApi({ region: "us-east-1", clientId: "client-1", fetch });
    const response = await api.initiateSrp("a@example.test", "AAAA");
    expect(response.ChallengeName).toBe("PASSWORD_VERIFIER");
    const [request] = sent;
    if (!request) throw new Error("no request");
    expect(request.url).toBe("https://cognito-idp.us-east-1.amazonaws.com/");
    expect(headersOf(request).get("x-amz-target")).toBe("AWSCognitoIdentityProviderService.InitiateAuth");
    expect(headersOf(request).get("content-type")).toBe("application/x-amz-json-1.1");
    expect(request.init.credentials).toBe("omit");
    expect(bodyOf(request)).toEqual({ AuthFlow: "USER_SRP_AUTH", ClientId: "client-1", AuthParameters: { USERNAME: "a@example.test", SRP_A: "AAAA" } });
    expect(request.options?.attempts).toBe(3);
  });

  it("sends a challenge answer once: a timeout must not replay a code or a password", async () => {
    const { sent, fetch } = fakeFetch(
      200,
      {
        RespondToAuthChallenge: { AuthenticationResult: { IdToken: "i", AccessToken: "a", RefreshToken: "r", ExpiresIn: 3600 } },
        VerifySoftwareToken: { Status: "SUCCESS" },
        ConfirmForgotPassword: {},
      },
      true,
    );
    const api = createCognitoApi({ region: "us-east-1", clientId: "client-1", fetch });
    await api.respondToChallenge("SOFTWARE_TOKEN_MFA", { USERNAME: "u", SOFTWARE_TOKEN_MFA_CODE: "123456" }, "s-1");
    await api.verifySoftwareToken({ accessToken: "a" }, "123456");
    await api.confirmForgotPassword("u", "123456", "x");
    for (const request of sent) expect(request.options?.attempts).toBe(1);
    expect(bodyOf(sent[0] as Sent)).toMatchObject({ ChallengeName: "SOFTWARE_TOKEN_MFA", Session: "s-1" });
    expect(bodyOf(sent[1] as Sent)).toMatchObject({ AccessToken: "a", UserCode: "123456", FriendlyDeviceName: "Cuadrilla" });
  });

  it("turns an error body into a CognitoError by type, namespaced or not", async () => {
    for (const type of ["NotAuthorizedException", "com.amazonaws.cognito.identity.idp.model#NotAuthorizedException"]) {
      const { fetch } = fakeFetch(400, { __type: type, message: "Incorrect username or password." });
      const api = createCognitoApi({ region: "us-east-1", clientId: "c", fetch });
      await expect(api.initiateSrp("a", "b")).rejects.toMatchObject({ name: "CognitoError", type: "NotAuthorizedException" });
    }
  });

  it("rejects an answer that does not have the expected shape", async () => {
    const { fetch } = fakeFetch(200, { SecretCode: 42 });
    const api = createCognitoApi({ region: "us-east-1", clientId: "c", fetch });
    await expect(api.associateSoftwareToken({ session: "s" })).rejects.toBeInstanceOf(CognitoError);
  });

  it("keeps the refresh token that REFRESH_TOKEN_AUTH does not return", async () => {
    const { sent, fetch } = fakeFetch(200, { AuthenticationResult: { IdToken: "i", AccessToken: "a", ExpiresIn: 3600 } });
    const api = createCognitoApi({ region: "us-east-1", clientId: "c", fetch });
    const result = await api.refresh("r-1");
    expect(result.RefreshToken).toBeUndefined();
    expect(bodyOf(sent[0] as Sent)).toEqual({ AuthFlow: "REFRESH_TOKEN_AUTH", ClientId: "c", AuthParameters: { REFRESH_TOKEN: "r-1" } });
  });

  it("revokes with RevokeToken and reads the MFA settings with GetUser", async () => {
    const { sent, fetch } = fakeFetch(200, { GetUser: { Username: "u", UserMFASettingList: ["SOFTWARE_TOKEN_MFA"] }, RevokeToken: {} }, true);
    const api = createCognitoApi({ region: "us-east-1", clientId: "c", fetch });
    expect(await api.mfaMethods("a")).toEqual(["SOFTWARE_TOKEN_MFA"]);
    await api.revoke("r");
    expect(sent.map((request) => headersOf(request).get("x-amz-target"))).toEqual([
      "AWSCognitoIdentityProviderService.GetUser",
      "AWSCognitoIdentityProviderService.RevokeToken",
    ]);
  });
});

describe("regionOfPool", () => {
  it("reads the region prefix of a user pool id", () => {
    expect(regionOfPool("us-east-1_AbC123xyz")).toBe("us-east-1");
    expect(regionOfPool("ap-southeast-2_x1")).toBe("ap-southeast-2");
    expect(regionOfPool("not-a-pool")).toBeUndefined();
  });
});

describe("the sign-up's Cognito calls (GuestSignup) [FL-104] [FL-105] [FL-106]", () => {
  it("[FL-104] SignUp names the ticket's user, the password, the email, the locale and the name, and carries the ticket as client metadata; sent once", async () => {
    const { sent, fetch } = fakeFetch(200, { UserConfirmed: false, UserSub: "sub-1" });
    const api = createSignupCognitoApi({ region: "us-east-1", clientId: "guest-signup-client", fetch });
    await api.signUp({ username: "gst-01K80000000000000000000001", password: "Fixture-Pass-1!", email: "ana@example.test", locale: "en", name: "Ana", ticket: "ticket-1" });
    const [request] = sent;
    if (!request) throw new Error("no request");
    expect(headersOf(request).get("x-amz-target")).toBe("AWSCognitoIdentityProviderService.SignUp");
    expect(bodyOf(request)).toEqual({
      ClientId: "guest-signup-client",
      Username: "gst-01K80000000000000000000001",
      Password: "Fixture-Pass-1!",
      UserAttributes: [
        { Name: "email", Value: "ana@example.test" },
        { Name: "locale", Value: "en" },
        { Name: "name", Value: "Ana" },
      ],
      ClientMetadata: { signupTicket: "ticket-1" },
    });
    expect(request.options?.attempts).toBe(1);
    expect(request.init.credentials).toBe("omit");
  });

  it("[FL-105] [FL-106] confirms with the code and resends it, once each, with the sign-up client", async () => {
    const { sent, fetch } = fakeFetch(200, {});
    const api = createSignupCognitoApi({ region: "us-east-1", clientId: "guest-signup-client", fetch });
    await api.confirmSignUp("gst-01K80000000000000000000001", "123456");
    await api.resendCode("gst-01K80000000000000000000001");
    expect(sent.map((request) => [headersOf(request).get("x-amz-target"), bodyOf(request), request.options?.attempts])).toEqual([
      ["AWSCognitoIdentityProviderService.ConfirmSignUp", { ClientId: "guest-signup-client", Username: "gst-01K80000000000000000000001", ConfirmationCode: "123456" }, 1],
      ["AWSCognitoIdentityProviderService.ResendConfirmationCode", { ClientId: "guest-signup-client", Username: "gst-01K80000000000000000000001" }, 1],
    ]);
  });

  it("[FL-104] reads a trigger's refusal by its code and never shows Cognito's raw text", async () => {
    const { fetch } = fakeFetch(400, { __type: "UserLambdaValidationException", message: "PreSignUp failed with error TICKET_INVALID." });
    const api = createSignupCognitoApi({ region: "us-east-1", clientId: "guest-signup-client", fetch });
    const error = await api.signUp({ username: "gst-01K80000000000000000000001", password: "p", email: "a@example.test", locale: "es-MX", ticket: "t" }).catch((caught: unknown) => caught);
    expect(signupErrorCodeOf(error, "signUp")).toBe("TICKET_INVALID");
    expect(signupErrorCodeOf(new CognitoError("UserLambdaValidationException", "PreSignUp failed with error EMAIL_TAKEN."), "signUp")).toBe("EMAIL_TAKEN");
    expect(signupErrorCodeOf(new CognitoError("UserLambdaValidationException", "CustomMessage failed with error CAP_REACHED."), "resend")).toBe("CAP_REACHED");
    // Two confirmed accounts of the same person already (ADR-0025 §3), read again by the pre sign-up.
    expect(signupErrorCodeOf(new CognitoError("UserLambdaValidationException", "PreSignUp failed with error RATE_LIMITED."), "signUp")).toBe("RATE_LIMITED");
    expect(signupErrorCodeOf(new CognitoError("UserLambdaValidationException", "PreSignUp failed with error SOURCE_NOT_ALLOWED."), "signUp")).toBe("UNAVAILABLE");
    expect(signupErrorCodeOf(new CognitoError("InvalidPasswordException", "x"), "signUp")).toBe("WEAK_PASSWORD");
    expect(signupErrorCodeOf(new CognitoError("CodeMismatchException", "x"), "confirm")).toBe("INVALID_CODE");
    expect(signupErrorCodeOf(new CognitoError("ExpiredCodeException", "x"), "confirm")).toBe("INVALID_CODE");
    expect(signupErrorCodeOf(new CognitoError("AliasExistsException", "x"), "confirm")).toBe("EMAIL_TAKEN");
    expect(signupErrorCodeOf(new CognitoError("LimitExceededException", "x"), "resend")).toBe("TOO_MANY_ATTEMPTS");
    expect(signupErrorCodeOf(new TypeError("Failed to fetch"), "signUp")).toBe("UNAVAILABLE");
  });
});
