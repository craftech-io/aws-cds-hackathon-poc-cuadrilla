// The account's phone, by the operator only (ADR-0029, packages/bff/src/phone/admin.ts). Runs inside
// `sst shell` with the operator's profile, one Cognito user at a time; never CI, never a request.
//
//   npm run console:phone -- --stage poc --username <cognito user> --automation   no SMS code: an account no
//                                                                                 person uses (the scenario
//                                                                                 and test runner's)
//   npm run console:phone -- --stage poc --username <cognito user> --human        the mark taken away
//   npm run console:phone -- --stage poc --username <cognito user> --reset-phone  the verified number
//                                                                                 forgotten: the next session
//                                                                                 enrols a new one
//
// The user is the Cognito user name (`guest-07`, `usr-adriana`, `gst-<ULID>`); its `sub` finds the row.
// Prints one line with the user and the operator, never a number.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PhoneAdminAction } from "../../packages/bff/src/phone/admin";
import { parseFlags } from "../channels/cli-args";

export const USAGE = "npm run console:phone -- --stage poc --username <cognito user> (--automation | --human | --reset-phone)";

export interface PhoneAdminRequest {
  readonly username: string;
  readonly action: PhoneAdminAction;
}

export function parsePhoneAdminArgs(argv: readonly string[]): PhoneAdminRequest {
  let stage: string | undefined;
  let username: string | undefined;
  const actions: PhoneAdminAction[] = [];
  parseFlags(argv, {
    "--stage": (value) => void (stage = value()),
    "--username": (value) => void (username = value()),
    "--automation": () => void actions.push("AUTOMATION"),
    "--human": () => void actions.push("HUMAN"),
    "--reset-phone": () => void actions.push("RESET"),
  });
  if (stage !== "poc") throw new RangeError(`--stage poc is required (the only stage)\n${USAGE}`);
  if (username === undefined || !/^[A-Za-z0-9_.+-]{1,128}$/.test(username)) throw new RangeError(`--username takes a Cognito user name, never an address\n${USAGE}`);
  const [action, ...extra] = actions;
  if (action === undefined || extra.length > 0) throw new RangeError(`choose exactly one of --automation, --human or --reset-phone\n${USAGE}`);
  return { username, action };
}

async function main(): Promise<void> {
  const request = parsePhoneAdminArgs(process.argv.slice(2));
  const cognito = await import("@aws-sdk/client-cognito-identity-provider");
  const { authConfig } = await import("../../packages/bff/src/auth/config");
  const { tableClient } = await import("../../packages/bff/src/connector/index");
  const { awsClientConfig, CLIENT_TIMEOUTS } = await import("../../packages/bff/src/lib/clients");
  const { subkey } = await import("../../packages/bff/src/lib/secrets");
  const { adminPhone } = await import("../../packages/bff/src/phone/admin");
  const pool = authConfig();
  const client = new cognito.CognitoIdentityProviderClient({ region: pool.region, ...awsClientConfig(CLIENT_TIMEOUTS.cognito) });
  const user = await client.send(new cognito.AdminGetUserCommand({ UserPoolId: pool.userPoolId, Username: request.username }));
  const sub = user.UserAttributes?.find((attribute) => attribute.Name === "sub")?.Value;
  if (sub === undefined) throw new Error("Cognito answered a user without sub");
  const outcome = await adminPhone({ client: tableClient(), phoneKey: () => subkey("account-phone"), now: () => new Date() }, sub, request.action);
  process.stdout.write(`console:phone: ${JSON.stringify({ user: request.username, action: request.action, actor: "OPERATOR", at: new Date().toISOString(), ...outcome })}\n`);
  if (outcome.outcome === "NO_ROW") process.exit(2);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`console:phone: ${error instanceof Error ? error.message : "failed"}\n`);
    process.exit(1);
  });
}
