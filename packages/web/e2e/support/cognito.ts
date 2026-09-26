// Cognito as a Playwright route (docs/test-plan.md §2, level UI): every call the console makes to
// the user-pool endpoint is answered by the fake pool of the spec (and the own sign-up's calls by its
// fake sign-up pool), in the JSON 1.1 shape and with
// the error types the real service uses, so the browser runs the real sign-in code (SRP, challenges,
// TOTP, refresh, revocation) and nothing reaches AWS. Every request body is kept, so a spec can
// assert what crossed the wire (never the password).
import type { Page, Route } from "@playwright/test";
import { CognitoError } from "../../src/lib/auth/cognito";
import type { FakeCognito } from "../../src/lib/auth/testing/fake-cognito";
import type { FakeSignupPool } from "../../src/lib/auth/testing/fake-signup";

const ENDPOINT_ORIGIN = "https://cognito-idp.us-east-1.amazonaws.com";
const TARGET_PREFIX = "AWSCognitoIdentityProviderService.";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-amz-target, x-amz-user-agent",
};

export interface CognitoCall {
  readonly operation: string;
  readonly body: string;
}

type Body = Record<string, unknown>;

const text = (body: Body, key: string): string => {
  const value = body[key];
  return typeof value === "string" ? value : "";
};

const record = (body: Body, key: string): Record<string, string> => {
  const value = body[key];
  return value !== null && typeof value === "object" ? (value as Record<string, string>) : {};
};

function credentialOf(body: Body): { session: string } | { accessToken: string } {
  return typeof body.Session === "string" ? { session: body.Session } : { accessToken: text(body, "AccessToken") };
}

const attribute = (body: Body, name: string): string | undefined => {
  const list = Array.isArray(body.UserAttributes) ? (body.UserAttributes as Array<{ Name?: unknown; Value?: unknown }>) : [];
  const found = list.find((item) => item.Name === name)?.Value;
  return typeof found === "string" ? found : undefined;
};

// The own sign-up's calls (the `GuestSignup` client), answered by the spec's fake sign-up pool.
async function answerSignup(signup: FakeSignupPool, operation: string, body: Body): Promise<unknown> {
  const username = text(body, "Username");
  switch (operation) {
    case "SignUp": {
      const locale = attribute(body, "locale") === "en" ? "en" : "es-MX";
      const name = attribute(body, "name");
      await signup.signUp({ username, password: text(body, "Password"), email: attribute(body, "email") ?? "", locale, ticket: record(body, "ClientMetadata").signupTicket ?? "", ...(name === undefined ? {} : { name }) });
      return { UserConfirmed: false, UserSub: `sub-${username}`, CodeDeliveryDetails: { DeliveryMedium: "EMAIL", AttributeName: "email", Destination: "a***@e***" } };
    }
    case "ConfirmSignUp":
      await signup.confirmSignUp(username, text(body, "ConfirmationCode"));
      return {};
    case "ResendConfirmationCode":
      await signup.resendCode(username);
      return { CodeDeliveryDetails: { DeliveryMedium: "EMAIL", AttributeName: "email", Destination: "a***@e***" } };
    default:
      return undefined;
  }
}

async function answer(pool: FakeCognito, operation: string, body: Body, signup: FakeSignupPool | undefined): Promise<unknown> {
  if (signup !== undefined && ["SignUp", "ConfirmSignUp", "ResendConfirmationCode"].includes(operation)) return answerSignup(signup, operation, body);
  switch (operation) {
    case "InitiateAuth": {
      const parameters = record(body, "AuthParameters");
      if (body.AuthFlow === "REFRESH_TOKEN_AUTH") return { AuthenticationResult: await pool.refresh(parameters.REFRESH_TOKEN ?? "") };
      return pool.initiateSrp(parameters.USERNAME ?? "", parameters.SRP_A ?? "");
    }
    case "RespondToAuthChallenge":
      return pool.respondToChallenge(text(body, "ChallengeName"), record(body, "ChallengeResponses"), typeof body.Session === "string" ? body.Session : undefined);
    case "AssociateSoftwareToken": {
      const result = await pool.associateSoftwareToken(credentialOf(body));
      return { SecretCode: result.secretCode, ...(result.session !== undefined ? { Session: result.session } : {}) };
    }
    case "VerifySoftwareToken": {
      const result = await pool.verifySoftwareToken(credentialOf(body), text(body, "UserCode"));
      return { Status: result.ok ? "SUCCESS" : "ERROR", ...(result.session !== undefined ? { Session: result.session } : {}) };
    }
    case "SetUserMFAPreference":
      await pool.setTotpPreferred(text(body, "AccessToken"));
      return {};
    case "GetUser":
      return { Username: "user", UserMFASettingList: [...(await pool.mfaMethods(text(body, "AccessToken")))] };
    case "ForgotPassword":
      await pool.forgotPassword(text(body, "Username"));
      return { CodeDeliveryDetails: { DeliveryMedium: "EMAIL", AttributeName: "email", Destination: "u***@e***" } };
    case "ConfirmForgotPassword":
      await pool.confirmForgotPassword(text(body, "Username"), text(body, "ConfirmationCode"), text(body, "Password"));
      return {};
    case "RevokeToken":
      await pool.revoke(text(body, "Token"));
      return {};
    default:
      throw new CognitoError("InvalidAction", `the console does not call ${operation}`);
  }
}

async function handle(route: Route, pool: FakeCognito, calls: CognitoCall[], signup: FakeSignupPool | undefined): Promise<void> {
  const request = route.request();
  if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
  const operation = (request.headers()["x-amz-target"] ?? "").replace(TARGET_PREFIX, "");
  const raw = request.postData() ?? "{}";
  calls.push({ operation, body: raw });
  const headers = { ...CORS, "content-type": "application/x-amz-json-1.1" };
  try {
    const result = await answer(pool, operation, JSON.parse(raw) as Body, signup);
    return route.fulfill({ status: 200, headers, body: JSON.stringify(result) });
  } catch (error) {
    if (error instanceof CognitoError) return route.fulfill({ status: 400, headers, body: JSON.stringify({ __type: error.type, message: error.message }) });
    // What the fake throws to stand for a network failure: the request never gets an answer.
    return route.abort("failed");
  }
}

/** Routes the page's Cognito calls to `pool` (and the sign-up's to `signup`); the returned list fills up as the browser calls. */
export async function routeCognito(page: Page, pool: FakeCognito, signup?: FakeSignupPool): Promise<CognitoCall[]> {
  const calls: CognitoCall[] = [];
  await page.route((url) => url.origin === ENDPOINT_ORIGIN, (route) => handle(route, pool, calls, signup));
  return calls;
}
