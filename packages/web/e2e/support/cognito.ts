// Cognito as a Playwright route (docs/test-plan.md §2, level UI): every call the console makes to
// the user-pool endpoint is answered by the fake pool of the spec, in the JSON 1.1 shape and with
// the error types the real service uses, so the browser runs the real sign-in code (SRP, challenges,
// TOTP, refresh, revocation) and nothing reaches AWS. Every request body is kept, so a spec can
// assert what crossed the wire (never the password).
import type { Page, Route } from "@playwright/test";
import { CognitoError } from "../../src/lib/auth/cognito";
import type { FakeCognito } from "../../src/lib/auth/testing/fake-cognito";

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

async function answer(pool: FakeCognito, operation: string, body: Body): Promise<unknown> {
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

async function handle(route: Route, pool: FakeCognito, calls: CognitoCall[]): Promise<void> {
  const request = route.request();
  if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
  const operation = (request.headers()["x-amz-target"] ?? "").replace(TARGET_PREFIX, "");
  const raw = request.postData() ?? "{}";
  calls.push({ operation, body: raw });
  const headers = { ...CORS, "content-type": "application/x-amz-json-1.1" };
  try {
    const result = await answer(pool, operation, JSON.parse(raw) as Body);
    return route.fulfill({ status: 200, headers, body: JSON.stringify(result) });
  } catch (error) {
    if (error instanceof CognitoError) return route.fulfill({ status: 400, headers, body: JSON.stringify({ __type: error.type, message: error.message }) });
    // What the fake throws to stand for a network failure: the request never gets an answer.
    return route.abort("failed");
  }
}

/** Routes the page's Cognito calls to `pool`; the returned list fills up as the browser calls. */
export async function routeCognito(page: Page, pool: FakeCognito): Promise<CognitoCall[]> {
  const calls: CognitoCall[] = [];
  await page.route((url) => url.origin === ENDPOINT_ORIGIN, (route) => handle(route, pool, calls));
  return calls;
}
