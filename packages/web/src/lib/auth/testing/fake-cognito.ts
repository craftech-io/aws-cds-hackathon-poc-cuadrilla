// Test-only Cognito user pool: the behaviour of the challenges the console handles, with real SRP
// verification (srp-server.ts) and real TOTP codes (totp.ts). Users are invited (temporary
// password, FORCE_CHANGE_PASSWORD) or confirmed, with or without TOTP; the pool's MFA is OPTIONAL
// like infra/auth.ts, or ON to exercise MFA_SETUP. Every request is recorded so a test can assert
// what crossed the wire. Tokens last 15 minutes like the pool's; the id token carries the claims the
// pre-token trigger stamps (`ispId`, `role`, `isGuest`) and is unsigned unless a signer is given (the
// Playwright specs sign it with an ephemeral RSA key, packages/web/e2e/support/tokens.ts).
import { type AuthResponse, type AuthenticationResult, type CognitoApi, CognitoError, TOTP_MFA } from "../cognito";
import { missingPasswordRules } from "../credentials";
import { type ServerSession, type SrpVerifier, createVerifier, startServerSession } from "./srp-server";
import { randomBase32Secret, totpCode } from "./totp";

export const FAKE_POOL_ID = "us-east-1_FakePool1";

/** Lifetime of the id and access tokens of the pool (infra/auth.ts): 15 minutes. */
export const FAKE_TOKEN_TTL_SECONDS = 15 * 60;

export interface FakeCognitoOptions {
  /** Signs the id token's claims; without it the token is unsigned (`alg: none`). */
  readonly signIdToken?: (claims: Readonly<Record<string, unknown>>) => string;
  readonly tokenTtlSeconds?: number;
}

export interface FakeUserInit {
  readonly email: string;
  readonly password: string;
  readonly role?: string;
  /** Operator stamped in the id token; `isp-demo` by default. */
  readonly ispId?: string;
  readonly name?: string;
  readonly status?: "FORCE_CHANGE_PASSWORD" | "CONFIRMED";
  /** Base32 TOTP secret; set = TOTP already enabled. */
  readonly totpSecret?: string;
}

interface FakeUser {
  readonly sub: string;
  readonly email: string;
  readonly role: string;
  readonly ispId: string;
  readonly name: string | undefined;
  status: "FORCE_CHANGE_PASSWORD" | "CONFIRMED";
  srp: SrpVerifier;
  password: string;
  totpSecret: string | undefined;
  totpEnabled: boolean;
  pendingSecret: string | undefined;
  resetCode: string | undefined;
}

interface PendingSession {
  readonly sub: string;
  readonly kind: "NEW_PASSWORD_REQUIRED" | "SOFTWARE_TOKEN_MFA" | "MFA_SETUP" | "SELECT_MFA_TYPE";
  used: boolean;
}

export interface RecordedCall {
  readonly operation: string;
  readonly payload: string;
}

function base64Url(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Cognito accepts the code of the previous 30-second window too; so does the fake, which also keeps
// a test from failing when the window turns between producing and checking a code.
async function codeMatches(secret: string | undefined, code: string | undefined): Promise<boolean> {
  if (!secret || !code) return false;
  const now = Date.now();
  return code === (await totpCode(secret, now)) || code === (await totpCode(secret, now - 30_000));
}

function fail(type: string, message: string): never {
  throw new CognitoError(type, message);
}

export class FakeCognito implements CognitoApi {
  readonly calls: RecordedCall[] = [];
  readonly revoked = new Set<string>();
  mfa: "OPTIONAL" | "ON" = "OPTIONAL";
  /** Makes the next request of this operation fail: as the network would, or with a Cognito error type. */
  failNext: { readonly operation: string; readonly type?: string } | undefined;
  private readonly users = new Map<string, FakeUser>();
  private readonly srpSessions = new Map<string, { sub: string | undefined; session: ServerSession; srpA: string }>();
  private readonly sessions = new Map<string, PendingSession>();
  private readonly accessTokens = new Map<string, string>();
  private readonly refreshTokens = new Map<string, string>();
  private counter = 0;

  constructor(
    readonly poolId: string = FAKE_POOL_ID,
    private readonly options: FakeCognitoOptions = {},
  ) {}

  async addUser(init: FakeUserInit): Promise<FakeUser> {
    this.counter += 1;
    const sub = `00000000-0000-4000-8000-${String(this.counter).padStart(12, "0")}`;
    const user: FakeUser = {
      sub,
      email: init.email.toLowerCase(),
      role: init.role ?? "SUPERVISOR",
      ispId: init.ispId ?? "isp-demo",
      name: init.name,
      status: init.status ?? "CONFIRMED",
      srp: await createVerifier(this.poolId, sub, init.password),
      password: init.password,
      totpSecret: init.totpSecret,
      totpEnabled: init.totpSecret !== undefined,
      pendingSecret: undefined,
      resetCode: undefined,
    };
    this.users.set(user.email, user);
    return user;
  }

  user(email: string): FakeUser {
    const user = this.users.get(email.toLowerCase());
    if (!user) throw new Error(`no fake user ${email}`);
    return user;
  }

  /** The code an authenticator app would show right now for this user's (pending or active) secret. */
  async currentCode(email: string): Promise<string> {
    const user = this.user(email);
    const secret = user.pendingSecret ?? user.totpSecret;
    if (!secret) throw new Error("no TOTP secret");
    return totpCode(secret);
  }

  expireSessions(): void {
    for (const session of this.sessions.values()) session.used = true;
  }

  sentResetCode(email: string): string | undefined {
    return this.user(email).resetCode;
  }

  private record(operation: string, payload: unknown): void {
    this.calls.push({ operation, payload: JSON.stringify(payload) });
    const failure = this.failNext;
    if (failure?.operation === operation) {
      this.failNext = undefined;
      if (failure.type) fail(failure.type, "injected failure");
      throw new TypeError("Failed to fetch");
    }
  }

  private newSession(sub: string, kind: PendingSession["kind"]): string {
    this.counter += 1;
    const id = `session-${this.counter}`;
    this.sessions.set(id, { sub, kind, used: false });
    return id;
  }

  private takeSession(id: string | undefined, kind: PendingSession["kind"]): FakeUser {
    const session = id === undefined ? undefined : this.sessions.get(id);
    if (!session || session.used || session.kind !== kind) fail("NotAuthorizedException", "Invalid session for the user, session is expired.");
    session.used = true;
    const user = [...this.users.values()].find((candidate) => candidate.sub === session.sub);
    if (!user) fail("NotAuthorizedException", "Invalid session");
    return user;
  }

  private tokensFor(user: FakeUser): AuthenticationResult {
    this.counter += 1;
    const now = Math.floor(Date.now() / 1000);
    const ttl = this.options.tokenTtlSeconds ?? FAKE_TOKEN_TTL_SECONDS;
    const claims = {
      sub: user.sub,
      email: user.email,
      ...(user.name !== undefined ? { name: user.name } : {}),
      "cognito:username": user.sub,
      "cognito:groups": [user.role],
      role: user.role,
      ispId: user.ispId,
      isGuest: user.role === "GUEST" ? "true" : "false",
      auth_time: now,
      exp: now + ttl,
      iat: now,
      iss: `https://cognito-idp.us-east-1.amazonaws.com/${this.poolId}`,
      aud: "fake-client",
      token_use: "id",
    };
    const idToken = this.options.signIdToken ? this.options.signIdToken(claims) : `${base64Url({ alg: "none" })}.${base64Url(claims)}.sig`;
    const accessToken = `access-${this.counter}`;
    const refreshToken = `refresh-${this.counter}`;
    this.accessTokens.set(accessToken, user.sub);
    this.refreshTokens.set(refreshToken, user.sub);
    return { IdToken: idToken, AccessToken: accessToken, RefreshToken: refreshToken, ExpiresIn: ttl };
  }

  private userOfAccessToken(token: string): FakeUser {
    const sub = this.accessTokens.get(token);
    const user = [...this.users.values()].find((candidate) => candidate.sub === sub);
    if (!user) fail("NotAuthorizedException", "Invalid Access Token");
    return user;
  }

  // What Cognito does once the password is proven (or changed): the next challenge or tokens.
  private afterPassword(user: FakeUser): AuthResponse {
    if (user.status === "FORCE_CHANGE_PASSWORD") {
      return { ChallengeName: "NEW_PASSWORD_REQUIRED", Session: this.newSession(user.sub, "NEW_PASSWORD_REQUIRED"), ChallengeParameters: { USER_ID_FOR_SRP: user.sub, requiredAttributes: "[]", userAttributes: "{}" } };
    }
    if (user.totpEnabled) return { ChallengeName: "SOFTWARE_TOKEN_MFA", Session: this.newSession(user.sub, "SOFTWARE_TOKEN_MFA"), ChallengeParameters: {} };
    if (this.mfa === "ON") {
      return { ChallengeName: "MFA_SETUP", Session: this.newSession(user.sub, "MFA_SETUP"), ChallengeParameters: { MFAS_CAN_SETUP: JSON.stringify([TOTP_MFA]) } };
    }
    return { AuthenticationResult: this.tokensFor(user) };
  }

  async initiateSrp(username: string, srpA: string): Promise<AuthResponse> {
    this.record("InitiateAuth", { username, srpA });
    const user = this.users.get(username.toLowerCase());
    // Unknown emails get a challenge too (preventUserExistenceErrors), which then fails.
    const userId = user?.sub ?? "00000000-0000-4000-8000-ffffffffffff";
    const record = user?.srp ?? (await createVerifier(this.poolId, userId, crypto.randomUUID()));
    const session = await startServerSession(this.poolId, record);
    this.srpSessions.set(session.secretBlock, { sub: user?.sub, session, srpA });
    return {
      ChallengeName: "PASSWORD_VERIFIER",
      ChallengeParameters: { SALT: record.saltHex, SECRET_BLOCK: session.secretBlock, SRP_B: session.srpBHex, USERNAME: userId, USER_ID_FOR_SRP: userId },
    };
  }

  async respondToChallenge(challengeName: string, responses: Readonly<Record<string, string>>, session?: string): Promise<AuthResponse> {
    this.record("RespondToAuthChallenge", { challengeName, responses, session });
    switch (challengeName) {
      case "PASSWORD_VERIFIER":
        return this.passwordVerifier(responses);
      case "NEW_PASSWORD_REQUIRED": {
        const password = responses.NEW_PASSWORD ?? "";
        const pending = session === undefined ? undefined : this.sessions.get(session);
        if (pending && !pending.used && missingPasswordRules(password).length > 0) fail("InvalidPasswordException", "Password does not conform to policy");
        const user = this.takeSession(session, "NEW_PASSWORD_REQUIRED");
        user.password = password;
        user.srp = await createVerifier(this.poolId, user.sub, password);
        user.status = "CONFIRMED";
        return this.afterPassword(user);
      }
      case "SOFTWARE_TOKEN_MFA": {
        const pending = session === undefined ? undefined : this.sessions.get(session);
        const user = this.takeSession(session, "SOFTWARE_TOKEN_MFA");
        if (!(await codeMatches(user.totpSecret, responses.SOFTWARE_TOKEN_MFA_CODE))) {
          // A wrong code leaves the session usable for another try.
          if (pending) pending.used = false;
          fail("CodeMismatchException", "Invalid code received for user");
        }
        return { AuthenticationResult: this.tokensFor(user) };
      }
      case "MFA_SETUP": {
        const user = this.takeSession(session, "MFA_SETUP");
        if (!user.totpEnabled) fail("NotAuthorizedException", "software token not verified");
        return { AuthenticationResult: this.tokensFor(user) };
      }
      default:
        return fail("InvalidParameterException", `unexpected challenge ${challengeName}`);
    }
  }

  private async passwordVerifier(responses: Readonly<Record<string, string>>): Promise<AuthResponse> {
    const secretBlock = responses.PASSWORD_CLAIM_SECRET_BLOCK ?? "";
    const pending = this.srpSessions.get(secretBlock);
    this.srpSessions.delete(secretBlock);
    const user = [...this.users.values()].find((candidate) => candidate.sub === pending?.sub);
    const ok =
      pending !== undefined &&
      user !== undefined &&
      responses.USERNAME === user.sub &&
      (await pending.session.verify({
        srpAHex: pending.srpA,
        userId: user.sub,
        timestamp: responses.TIMESTAMP ?? "",
        secretBlock,
        signature: responses.PASSWORD_CLAIM_SIGNATURE ?? "",
      }));
    if (!ok || !user) return fail("NotAuthorizedException", "Incorrect username or password.");
    return this.afterPassword(user);
  }

  async associateSoftwareToken(credential: { session: string } | { accessToken: string }) {
    this.record("AssociateSoftwareToken", credential);
    let user: FakeUser;
    let session: string | undefined;
    if ("session" in credential) {
      user = this.takeSession(credential.session, "MFA_SETUP");
      session = this.newSession(user.sub, "MFA_SETUP");
    } else user = this.userOfAccessToken(credential.accessToken);
    user.pendingSecret = randomBase32Secret();
    return { secretCode: user.pendingSecret, ...(session !== undefined ? { session } : {}) };
  }

  async verifySoftwareToken(credential: { session: string } | { accessToken: string }, code: string) {
    this.record("VerifySoftwareToken", { credential, code });
    let user: FakeUser;
    let session: string | undefined;
    if ("session" in credential) {
      user = this.takeSession(credential.session, "MFA_SETUP");
      session = this.newSession(user.sub, "MFA_SETUP");
    } else user = this.userOfAccessToken(credential.accessToken);
    if (!(await codeMatches(user.pendingSecret, code))) fail("EnableSoftwareTokenMFAException", "Code mismatch");
    user.totpSecret = user.pendingSecret;
    user.pendingSecret = undefined;
    // Through a challenge session, verifying enables TOTP; with an access token it waits for the preference.
    if (session !== undefined) user.totpEnabled = true;
    return { ok: true, ...(session !== undefined ? { session } : {}) };
  }

  async setTotpPreferred(accessToken: string): Promise<void> {
    this.record("SetUserMFAPreference", { accessToken });
    const user = this.userOfAccessToken(accessToken);
    if (!user.totpSecret) fail("InvalidParameterException", "software token not associated");
    user.totpEnabled = true;
  }

  async mfaMethods(accessToken: string): Promise<readonly string[]> {
    this.record("GetUser", { accessToken });
    return this.userOfAccessToken(accessToken).totpEnabled ? [TOTP_MFA] : [];
  }

  async forgotPassword(username: string): Promise<void> {
    this.record("ForgotPassword", { username });
    const user = this.users.get(username.toLowerCase());
    if (!user) return;
    if (user.status === "FORCE_CHANGE_PASSWORD") fail("NotAuthorizedException", "User password cannot be reset in the current state.");
    user.resetCode = String(100_000 + Math.floor(Math.random() * 900_000));
  }

  async confirmForgotPassword(username: string, code: string, newPassword: string): Promise<void> {
    this.record("ConfirmForgotPassword", { username, code, newPassword });
    const user = this.users.get(username.toLowerCase());
    if (!user || !user.resetCode || user.resetCode !== code) fail("CodeMismatchException", "Invalid verification code provided");
    if (missingPasswordRules(newPassword).length > 0) fail("InvalidPasswordException", "Password does not conform to policy");
    user.password = newPassword;
    user.srp = await createVerifier(this.poolId, user.sub, newPassword);
    user.resetCode = undefined;
  }

  async refresh(refreshToken: string): Promise<AuthenticationResult> {
    this.record("InitiateAuth", { refreshToken });
    const sub = this.refreshTokens.get(refreshToken);
    const user = [...this.users.values()].find((candidate) => candidate.sub === sub);
    if (!user || this.revoked.has(refreshToken)) fail("NotAuthorizedException", "Refresh Token has been revoked");
    // Cognito does not rotate the refresh token on this flow.
    const fresh = this.tokensFor(user);
    return { IdToken: fresh.IdToken, AccessToken: fresh.AccessToken, ExpiresIn: fresh.ExpiresIn };
  }

  async revoke(refreshToken: string): Promise<void> {
    this.record("RevokeToken", { refreshToken });
    this.revoked.add(refreshToken);
  }
}
