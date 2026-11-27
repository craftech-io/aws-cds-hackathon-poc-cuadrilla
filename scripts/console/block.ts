// Blocks or unblocks one account, by the operator only (ADR-0029 §11, packages/bff/src/phone/block.ts).
// Runs inside `sst shell` with the operator's profile, one account at a time; never CI, never a request.
//
//   npm run console:block -- --stage poc --username <cognito user> --block
//   npm run console:block -- --stage poc --username <cognito user> --unblock
//   echo "<address>" | npm run console:block -- --stage poc --by-email --block
//   npm run console:block -- --stage poc --by-email --email-file <path outside the repository> --unblock
//
// The block marks the registry row (`blockedAt`: every procedure answers ACCOUNT_BLOCKED and no SMS goes
// out), disables the Cognito user, signs it out everywhere and deletes its passed SMS sessions; the
// unblock takes the mark away and enables the user. The address, when the account is found by it, comes
// from standard input or a file, never from an argument (scripts/leads/email-input.ts). Prints one line
// with the Cognito user and the outcome, never the address.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AdminDisableUserCommand, AdminEnableUserCommand, AdminGetUserCommand, AdminUserGlobalSignOutCommand, CognitoIdentityProviderClient, ListUsersCommand } from "@aws-sdk/client-cognito-identity-provider";
import type { TableClient } from "../../packages/bff/src/connector/table-client";
import { type BlockAction, type BlockOutcome, type BlockTarget, type CognitoAccounts, blockAccount } from "../../packages/bff/src/phone/block";
import { parseFlags } from "../channels/cli-args";
import { EMAIL_INPUT_USAGE, type EmailSource, processEmailSource, readEmailInput } from "../leads/email-input";

export const USAGE = "npm run console:block -- --stage poc (--username <cognito user> | --by-email) (--block | --unblock)";

export type BlockWho = { readonly username: string } | { readonly email: string };

export interface BlockRequest {
  readonly who: BlockWho;
  readonly action: BlockAction;
}

const USERNAME = /^[A-Za-z0-9_.+-]{1,128}$/;

export async function parseBlockArgs(argv: readonly string[], source: EmailSource): Promise<BlockRequest> {
  let stage: string | undefined;
  let username: string | undefined;
  let byEmail = false;
  const actions: BlockAction[] = [];
  const flags = {
    "--stage": (value: () => string) => void (stage = value()),
    "--username": (value: () => string) => void (username = value()),
    "--by-email": () => void (byEmail = true),
    "--block": () => void actions.push("BLOCK"),
    "--unblock": () => void actions.push("UNBLOCK"),
  };
  let email: string | undefined;
  if (argv.includes("--by-email")) email = await readEmailInput(argv, source, { flags });
  else parseFlags(argv, flags);
  if (stage !== "poc") throw new RangeError(`--stage poc is required (the only stage)\n${USAGE}`);
  const [action, ...extra] = actions;
  if (action === undefined || extra.length > 0) throw new RangeError(`choose exactly one of --block or --unblock\n${USAGE}`);
  if (byEmail === (username !== undefined)) throw new RangeError(`name the account by exactly one of --username or --by-email\n${USAGE}`);
  if (username !== undefined) {
    if (!USERNAME.test(username)) throw new RangeError(`--username takes a Cognito user name; an address goes by --by-email (${EMAIL_INPUT_USAGE})\n${USAGE}`);
    return { who: { username }, action };
  }
  if (email === undefined || /["\\]/.test(email)) throw new RangeError("that is not an email address");
  return { who: { email }, action };
}

type Cognito = Pick<CognitoIdentityProviderClient, "send">;

const subOf = (attributes: ReadonlyArray<{ readonly Name?: string; readonly Value?: string }> | undefined): string | undefined => attributes?.find((attribute) => attribute.Name === "sub")?.Value;

/** The Cognito user name and `sub` of the account, by its user name or by its one address. */
export async function findTarget(cognito: Cognito, userPoolId: string, who: BlockWho): Promise<BlockTarget> {
  if ("username" in who) {
    const user = await cognito.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: who.username }));
    const sub = subOf(user.UserAttributes);
    if (sub === undefined || user.Username === undefined) throw new Error("Cognito answered a user without sub");
    return { username: user.Username, sub };
  }
  const listed = await cognito.send(new ListUsersCommand({ UserPoolId: userPoolId, Filter: `email = "${who.email}"`, Limit: 2 }));
  const users = listed.Users ?? [];
  if (users.length !== 1) throw new Error(`expected exactly one Cognito user with that address, found ${users.length}`);
  const [user] = users;
  const sub = subOf(user?.Attributes);
  if (user?.Username === undefined || sub === undefined) throw new Error("Cognito answered a user without sub");
  return { username: user.Username, sub };
}

export function cognitoAccounts(cognito: Cognito, userPoolId: string): CognitoAccounts {
  return {
    disable: async (username) => void (await cognito.send(new AdminDisableUserCommand({ UserPoolId: userPoolId, Username: username }))),
    enable: async (username) => void (await cognito.send(new AdminEnableUserCommand({ UserPoolId: userPoolId, Username: username }))),
    signOutEverywhere: async (username) => void (await cognito.send(new AdminUserGlobalSignOutCommand({ UserPoolId: userPoolId, Username: username }))),
  };
}

export interface RunBlockDeps {
  readonly cognito: Cognito;
  readonly userPoolId: string;
  readonly client: TableClient;
  readonly now: () => Date;
  readonly wait?: (ms: number) => Promise<void>;
}

export async function runBlock(request: BlockRequest, deps: RunBlockDeps): Promise<{ readonly user: string } & BlockOutcome> {
  const target = await findTarget(deps.cognito, deps.userPoolId, request.who);
  const outcome = await blockAccount({ client: deps.client, cognito: cognitoAccounts(deps.cognito, deps.userPoolId), now: deps.now, ...(deps.wait === undefined ? {} : { wait: deps.wait }) }, target, request.action);
  return { user: target.username, ...outcome };
}

async function main(): Promise<void> {
  const request = await parseBlockArgs(process.argv.slice(2), processEmailSource);
  const { authConfig } = await import("../../packages/bff/src/auth/config");
  const { tableClient } = await import("../../packages/bff/src/connector/index");
  const { awsClientConfig, CLIENT_TIMEOUTS } = await import("../../packages/bff/src/lib/clients");
  const pool = authConfig();
  const client = new CognitoIdentityProviderClient({ region: pool.region, ...awsClientConfig(CLIENT_TIMEOUTS.cognito) });
  const result = await runBlock(request, { cognito: client, userPoolId: pool.userPoolId, client: tableClient(), now: () => new Date() });
  process.stdout.write(`console:block: ${JSON.stringify({ action: request.action, actor: "OPERATOR", at: new Date().toISOString(), ...result })}\n`);
  if (result.outcome === "NO_ROW") process.exit(2);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`console:block: ${error instanceof Error ? error.message : "failed"}\n`);
    process.exit(1);
  });
}
