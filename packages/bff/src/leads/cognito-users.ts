// The Cognito admin calls of the lead lifecycle (ADR-0025 §6, ADR-0026): delete a user of the own
// sign-up and list the users that never confirmed. One module, the SDK timeouts of lib/clients.ts and
// backoff on throttling. The pool comes from the `Auth` link (auth/config.ts).
//
// Only `gst-<ULID>` users are ever touched: a username of any other shape is refused before the SDK
// is called, so no path of this module can delete an invited guest, a supervisor or an operator. A
// call never carries an email: the username is the one stored in the registry or the lead.
import {
  AdminDeleteUserCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
  type ListUsersCommandOutput,
} from "@aws-sdk/client-cognito-identity-provider";
import { authConfig } from "../auth/config";
import { CLIENT_TIMEOUTS, awsClientConfig } from "../lib/clients";
import { withRetry } from "../lib/retry";
import { SIGNUP_USERNAME_PATTERN } from "./model";

export interface UnconfirmedUser {
  readonly username: string;
  readonly createdAt: Date;
}

export interface CognitoUsers {
  /** `NOT_FOUND` when the user was already gone (idempotent). Throws for a username that is not `gst-*`. */
  deleteUser(username: string): Promise<"DELETED" | "NOT_FOUND">;
  /** Every `UNCONFIRMED` user of the pool, page by page. */
  listUnconfirmed(): Promise<UnconfirmedUser[]>;
}

export function assertSignupUsername(username: string): string {
  if (!SIGNUP_USERNAME_PATTERN.test(username)) throw new RangeError("only users of the own sign-up (gst-<ULID>) are deleted here");
  return username;
}

const RETRYABLE = new Set(["TooManyRequestsException", "ThrottlingException", "InternalErrorException", "TimeoutError"]);
const LIST_PAGE = 60;
const MAX_PAGES = 100;

export interface CognitoUsersOptions {
  readonly client?: Pick<CognitoIdentityProviderClient, "send">;
  readonly userPoolId?: () => string;
  readonly sleep?: (ms: number) => Promise<void>;
}

let sharedClient: CognitoIdentityProviderClient | undefined;

export function createCognitoUsers(options: CognitoUsersOptions = {}): CognitoUsers {
  const client = (): Pick<CognitoIdentityProviderClient, "send"> => options.client ?? (sharedClient ??= new CognitoIdentityProviderClient(awsClientConfig(CLIENT_TIMEOUTS.cognito)));
  const userPoolId = options.userPoolId ?? (() => authConfig().userPoolId);
  const retry = <T>(operation: () => Promise<T>): Promise<T> =>
    withRetry(operation, {
      shouldRetry: (error) => error instanceof Error && RETRYABLE.has(error.name),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    });

  return {
    async deleteUser(username) {
      assertSignupUsername(username);
      try {
        await retry(() => client().send(new AdminDeleteUserCommand({ UserPoolId: userPoolId(), Username: username })));
        return "DELETED";
      } catch (error) {
        if (error instanceof Error && error.name === "UserNotFoundException") return "NOT_FOUND";
        throw error;
      }
    },

    async listUnconfirmed() {
      const users: UnconfirmedUser[] = [];
      let token: string | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const output: ListUsersCommandOutput = await retry(() =>
          client().send(new ListUsersCommand({ UserPoolId: userPoolId(), Filter: 'cognito:user_status = "UNCONFIRMED"', Limit: LIST_PAGE, ...(token === undefined ? {} : { PaginationToken: token }) })),
        );
        for (const user of output.Users ?? []) {
          if (user.Username !== undefined && user.UserCreateDate !== undefined) users.push({ username: user.Username, createdAt: user.UserCreateDate });
        }
        token = output.PaginationToken;
        if (token === undefined) break;
      }
      return users;
    },
  };
}
