// The Cognito user-pool API calls the console makes, straight over fetch (JSON 1.1 protocol, the
// same endpoint the AWS SDK uses). Every operation here is one Cognito allows without IAM
// credentials: it rides on the public client id, a challenge session or the user's own access
// token. Keeping the SDK out keeps the login bundle small; zod keeps the answers honest.
import { z } from "zod";
import { fetchWithRetry } from "../http";

export const TOTP_MFA = "SOFTWARE_TOKEN_MFA";

const AuthenticationResult = z.object({
  IdToken: z.string().min(1),
  AccessToken: z.string().min(1),
  RefreshToken: z.string().min(1).optional(),
  ExpiresIn: z.number().int().positive(),
});
export type AuthenticationResult = z.infer<typeof AuthenticationResult>;

const AuthResponse = z.object({
  AuthenticationResult: AuthenticationResult.optional(),
  ChallengeName: z.string().optional(),
  ChallengeParameters: z.record(z.string(), z.string()).optional(),
  Session: z.string().optional(),
});
export type AuthResponse = z.infer<typeof AuthResponse>;

const AssociateResponse = z.object({ SecretCode: z.string().min(16), Session: z.string().optional() });
const VerifyResponse = z.object({ Status: z.enum(["SUCCESS", "ERROR"]), Session: z.string().optional() });
const GetUserResponse = z.object({ Username: z.string(), UserMFASettingList: z.array(z.string()).optional() });
const Empty = z.object({});

/** A Cognito refusal, by its error type (`NotAuthorizedException`, `CodeMismatchException`, …). */
export class CognitoError extends Error {
  override readonly name = "CognitoError";
  constructor(
    readonly type: string,
    message: string,
  ) {
    super(message);
  }
}

/** Where a challenge or setup stands: the session Cognito handed out, or the signed-in user's token. */
export type Credential = { readonly session: string } | { readonly accessToken: string };

/** What the sign-in flow needs of Cognito. `createCognitoApi` talks to AWS; tests use a fake. */
export interface CognitoApi {
  initiateSrp(username: string, srpA: string): Promise<AuthResponse>;
  respondToChallenge(challengeName: string, responses: Readonly<Record<string, string>>, session?: string): Promise<AuthResponse>;
  associateSoftwareToken(credential: Credential): Promise<{ secretCode: string; session?: string }>;
  verifySoftwareToken(credential: Credential, code: string): Promise<{ ok: boolean; session?: string }>;
  setTotpPreferred(accessToken: string): Promise<void>;
  /** MFA methods the user has enabled (`SOFTWARE_TOKEN_MFA` once TOTP is on). */
  mfaMethods(accessToken: string): Promise<readonly string[]>;
  forgotPassword(username: string): Promise<void>;
  confirmForgotPassword(username: string, code: string, newPassword: string): Promise<void>;
  refresh(refreshToken: string): Promise<AuthenticationResult>;
  revoke(refreshToken: string): Promise<void>;
}

export interface CognitoApiConfig {
  readonly region: string;
  readonly clientId: string;
  /** Test seam; defaults to the browser's fetch with timeout and retry. */
  readonly fetch?: typeof fetchWithRetry;
}

const TARGET_PREFIX = "AWSCognitoIdentityProviderService.";
const TIMEOUT_MS = 10_000;
/** Shown to the authenticator app next to the account. */
export const TOTP_DEVICE_NAME = "Cuadrilla";

const ErrorBody = z.object({ __type: z.string().optional(), message: z.string().optional(), Message: z.string().optional() });

// Cognito names errors `NotAuthorizedException` or, on some paths, `<namespace>#NotAuthorizedException`.
function errorType(raw: string | undefined): string {
  if (!raw) return "UnknownError";
  const name = raw.slice(raw.lastIndexOf("#") + 1);
  return name.slice(0, name.indexOf(":") === -1 ? undefined : name.indexOf(":"));
}

/** One Cognito operation: the body, the zod shape of the answer, and whether a retry is harmless. */
export type CognitoCall = <T>(operation: string, body: Record<string, unknown>, schema: z.ZodType<T>, idempotent: boolean) => Promise<T>;

/**
 * The transport of every Cognito client of the console (the sign-in's `ConsoleWeb`, the sign-up's
 * `GuestSignup`): idempotent reads and the SRP start retry a network failure; a call that consumes a
 * code, a session or a password is sent once, so a timeout never replays it.
 */
export function createCognitoCaller(config: Pick<CognitoApiConfig, "region" | "fetch">): CognitoCall {
  const endpoint = `https://cognito-idp.${config.region}.amazonaws.com/`;
  const doFetch = config.fetch ?? fetchWithRetry;
  return async (operation, body, schema, idempotent) => {
    const response = await doFetch(
      endpoint,
      {
        method: "POST",
        headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": `${TARGET_PREFIX}${operation}` },
        body: JSON.stringify(body),
        credentials: "omit",
        referrerPolicy: "no-referrer",
      },
      { attempts: idempotent ? 3 : 1, timeoutMs: TIMEOUT_MS },
    );
    const payload: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const parsed = ErrorBody.safeParse(payload);
      const type = errorType((parsed.success ? parsed.data.__type : undefined) ?? response.headers.get("x-amzn-errortype") ?? undefined);
      throw new CognitoError(type, parsed.success ? (parsed.data.message ?? parsed.data.Message ?? type) : type);
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) throw new CognitoError("InvalidResponse", `unexpected ${operation} response`);
    return parsed.data;
  };
}

export function createCognitoApi(config: CognitoApiConfig): CognitoApi {
  const call = createCognitoCaller(config);
  const clientId = config.clientId;
  return {
    initiateSrp: (username, srpA) =>
      call("InitiateAuth", { AuthFlow: "USER_SRP_AUTH", ClientId: clientId, AuthParameters: { USERNAME: username, SRP_A: srpA } }, AuthResponse, true),
    respondToChallenge: (challengeName, responses, session) =>
      call(
        "RespondToAuthChallenge",
        { ChallengeName: challengeName, ClientId: clientId, ChallengeResponses: responses, ...(session !== undefined ? { Session: session } : {}) },
        AuthResponse,
        false,
      ),
    async associateSoftwareToken(credential) {
      const result = await call("AssociateSoftwareToken", { ...credentialBody(credential) }, AssociateResponse, false);
      return { secretCode: result.SecretCode, ...(result.Session !== undefined ? { session: result.Session } : {}) };
    },
    async verifySoftwareToken(credential, code) {
      const result = await call("VerifySoftwareToken", { ...credentialBody(credential), UserCode: code, FriendlyDeviceName: TOTP_DEVICE_NAME }, VerifyResponse, false);
      return { ok: result.Status === "SUCCESS", ...(result.Session !== undefined ? { session: result.Session } : {}) };
    },
    async setTotpPreferred(accessToken) {
      await call("SetUserMFAPreference", { AccessToken: accessToken, SoftwareTokenMfaSettings: { Enabled: true, PreferredMfa: true } }, Empty, true);
    },
    async mfaMethods(accessToken) {
      const user = await call("GetUser", { AccessToken: accessToken }, GetUserResponse, true);
      return user.UserMFASettingList ?? [];
    },
    async forgotPassword(username) {
      await call("ForgotPassword", { ClientId: clientId, Username: username }, z.looseObject({}), false);
    },
    async confirmForgotPassword(username, code, newPassword) {
      await call("ConfirmForgotPassword", { ClientId: clientId, Username: username, ConfirmationCode: code, Password: newPassword }, Empty, false);
    },
    async refresh(refreshToken) {
      const result = await call("InitiateAuth", { AuthFlow: "REFRESH_TOKEN_AUTH", ClientId: clientId, AuthParameters: { REFRESH_TOKEN: refreshToken } }, AuthResponse, true);
      if (!result.AuthenticationResult) throw new CognitoError("InvalidResponse", "refresh answered without tokens");
      return result.AuthenticationResult;
    },
    async revoke(refreshToken) {
      await call("RevokeToken", { ClientId: clientId, Token: refreshToken }, Empty, true);
    },
  };
}

function credentialBody(credential: Credential): Record<string, string> {
  return "session" in credential ? { Session: credential.session } : { AccessToken: credential.accessToken };
}

/** `us-east-1_AbC123` → `us-east-1`: the region is the prefix of every user pool id. */
export function regionOfPool(userPoolId: string): string | undefined {
  const match = /^([a-z]{2}(?:-[a-z]+)+-\d+)_[A-Za-z0-9]+$/.exec(userPoolId);
  return match?.[1];
}
