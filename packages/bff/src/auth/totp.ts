// Tells whether a user signs in with TOTP (optional for supervisors and operations, off for judges,
// docs/architecture.md §10). Cognito's id token has no `amr` claim, so the console asks the BFF,
// which reads the MFA settings of the user; the settings screen shows the answer and judges never
// see the option.
import { AdminGetUserCommand, CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { type ClientTimeouts, awsClientConfig } from "../lib/clients";
import { AUTH_REASON, AuthError } from "./errors";

export interface TotpStatusReader {
  isTotpEnabled(username: string): Promise<boolean>;
}

const SOFTWARE_TOKEN_MFA = "SOFTWARE_TOKEN_MFA";

// A control-plane read that normally answers in tens of milliseconds; the BFF Lambda has seconds.
export const COGNITO_TIMEOUTS: ClientTimeouts = {
  requestTimeoutMs: 3_000,
  connectionTimeoutMs: 1_000,
  maxAttempts: 3,
};

export interface CognitoTotpReaderConfig {
  readonly userPoolId: string;
  readonly region: string;
}

export function createCognitoTotpReader(
  config: CognitoTotpReaderConfig,
  client: CognitoIdentityProviderClient = new CognitoIdentityProviderClient({ region: config.region, ...awsClientConfig(COGNITO_TIMEOUTS) }),
): TotpStatusReader {
  return {
    async isTotpEnabled(username) {
      try {
        const user = await client.send(new AdminGetUserCommand({ UserPoolId: config.userPoolId, Username: username }));
        return user.Enabled !== false && (user.UserMFASettingList ?? []).includes(SOFTWARE_TOKEN_MFA);
      } catch (error) {
        // Fails closed: without an answer the console cannot say whether TOTP is on.
        throw new AuthError(AUTH_REASON.AUTH_UNAVAILABLE, "could not read the MFA settings of the user", { cause: error });
      }
    },
  };
}
