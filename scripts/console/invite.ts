// Console accounts that do not come from the own sign-up (ADR-0024, ADR-0025, docs/pending.md P-03): the
// invited guests and the internal roles, which exist only by invitation. Runs inside `sst shell` (the
// pool and the `Isps` table arrive through the linked resources) and writes nothing unless every flag
// parsed.
//
//   npm run console:invite -- --stage poc --guest <01-98>          guest-NN, INVITED, world isp-guest-NN
//   npm run console:invite -- --stage poc --guest test             guest-test, TEST, world isp-guest-test
//   npm run console:invite -- --stage poc --role SUPERVISOR --user usr-adriana [--email <address>]
//   npm run console:invite -- --stage poc --role OPS --user usr-ops-lina [--email <address>]
//   add --reset-password to give an existing account a new password
//
// Every account gets a random password of 28 characters from a CSPRNG (permanent, no invitation email, MFA
// off for guests), its Cognito group and the binding of its `sub` to its registry row (`Isps/USER#`, the
// only source of the token's operator and role). A guest's world is built by `GuestWorlds` on its first
// sign-in. The password is never printed nor logged: it goes to `console-credentials.local.json`
// (git-ignored, mode 0600) for the operator to hand over privately (the private test instructions of
// P-03). An internal role is only bound to a seeded row of the demo operator with that same role.
import { randomInt } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONSOLE_GROUPS, ISP_ID_CLAIM, PASSWORD_POLICY } from "../../infra/auth-email";
import { parseFlags } from "../channels/cli-args";

export const STAGE = "poc";
export const CREDENTIALS_FILE = "console-credentials.local.json";
export const PASSWORD_LENGTH = 28;
export const DEMO_ISP = "isp-demo";

const CLASSES = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!#%+-=?@^_"] as const;
const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
const USER_ID = /^usr-[a-z0-9-]{2,60}$/;

export type InvitePlan =
  | { readonly kind: "GUEST"; readonly username: string; readonly userId: string; readonly ispId: string; readonly origin: "INVITED" | "TEST"; readonly resetPassword: boolean }
  | { readonly kind: "STAFF"; readonly username: string; readonly userId: string; readonly ispId: string; readonly role: "SUPERVISOR" | "OPS"; readonly email?: string; readonly resetPassword: boolean };

export interface InviteArgs {
  stage?: string;
  guest?: string;
  role?: string;
  user?: string;
  email?: string;
  resetPassword?: boolean;
}

export function parseInviteArgs(argv: readonly string[]): InviteArgs {
  const args: InviteArgs = {};
  parseFlags(argv, {
    "--stage": (value) => void (args.stage = value()),
    "--guest": (value) => void (args.guest = value()),
    "--role": (value) => void (args.role = value()),
    "--user": (value) => void (args.user = value()),
    "--email": (value) => void (args.email = value()),
    "--reset-password": () => void (args.resetPassword = true),
  });
  return args;
}

export function planInvite(args: InviteArgs): InvitePlan {
  if (args.stage !== STAGE) throw new RangeError(`--stage ${STAGE} is required (the only stage)`);
  const guest = args.guest !== undefined;
  const staff = args.role !== undefined || args.user !== undefined || args.email !== undefined;
  if (guest === staff) throw new RangeError("choose one of --guest <01-98|test> or --role SUPERVISOR|OPS with --user <userId>");
  const resetPassword = args.resetPassword === true;
  if (guest) {
    if (args.guest === "test") return { kind: "GUEST", username: "guest-test", userId: "usr-guest-test", ispId: "isp-guest-test", origin: "TEST", resetPassword };
    const number = Number(args.guest);
    if (!/^\d{1,2}$/.test(args.guest ?? "") || number < 1 || number > 98) throw new RangeError("--guest takes a slot from 01 to 98, or test");
    const nn = String(number).padStart(2, "0");
    return { kind: "GUEST", username: `guest-${nn}`, userId: `usr-guest-${nn}`, ispId: `isp-guest-${nn}`, origin: "INVITED", resetPassword };
  }
  if (args.role !== "SUPERVISOR" && args.role !== "OPS") throw new RangeError("--role takes SUPERVISOR or OPS (a guest is invited with --guest)");
  if (args.user === undefined || !USER_ID.test(args.user)) throw new RangeError("--user takes the id of a seeded console user, such as usr-adriana");
  const email = args.email?.trim().toLowerCase();
  if (email !== undefined && !EMAIL.test(email)) throw new RangeError("--email needs an address");
  return { kind: "STAFF", username: args.user, userId: args.user, ispId: DEMO_ISP, role: args.role, ...(email === undefined ? {} : { email }), resetPassword };
}

/** A password of every class the pool requires (infra/auth-email.ts `PASSWORD_POLICY`), from a CSPRNG. */
export function generatePassword(length: number = PASSWORD_LENGTH): string {
  if (length < Math.max(24, PASSWORD_POLICY.minimumLength)) throw new RangeError("a console password has at least 24 characters");
  const all = CLASSES.join("");
  const chars = [...CLASSES.map((set) => set[randomInt(set.length)] ?? ""), ...Array.from({ length: length - CLASSES.length }, () => all[randomInt(all.length)] ?? "")];
  for (let index = chars.length - 1; index > 0; index -= 1) {
    const other = randomInt(index + 1);
    [chars[index], chars[other]] = [chars[other] ?? "", chars[index] ?? ""];
  }
  return chars.join("");
}

export interface RegistryRow {
  readonly role: string;
  readonly cognitoSub: string;
  readonly guestOrigin?: string;
}

/** What the script needs of Cognito and of `Isps`; `cognitoInviteDeps` talks to the real ones. */
export interface InviteDeps {
  /** The user and its informative `custom:ispId`. */
  findUser(username: string): Promise<{ readonly sub: string; readonly ispId?: string } | undefined>;
  createUser(input: { readonly username: string; readonly ispId: string; readonly email?: string }): Promise<{ readonly sub: string }>;
  setPermanentPassword(username: string, password: string): Promise<void>;
  disableMfa(username: string): Promise<void>;
  addToGroup(username: string, group: keyof typeof CONSOLE_GROUPS): Promise<void>;
  getRow(ispId: string, userId: string): Promise<RegistryRow | undefined>;
  /** Writes (a guest) or binds (a seeded internal row) the registry row with the user's `sub`. */
  bindRow(plan: InvitePlan, sub: string): Promise<void>;
  /** Keeps a generated password for the operator; never printed. */
  saveCredential(username: string, ispId: string, password: string): void;
  report(line: string): void;
}

export interface InviteOutcome {
  readonly username: string;
  readonly created: boolean;
  readonly passwordSet: boolean;
}

async function checkRow(plan: InvitePlan, deps: InviteDeps, sub: string | undefined): Promise<void> {
  const row = await deps.getRow(plan.ispId, plan.userId);
  if (plan.kind === "STAFF") {
    if (row === undefined) throw new RangeError(`${plan.userId} is not a console user of ${plan.ispId}; internal roles are bound to seeded rows only`);
    if (row.role !== plan.role) throw new RangeError(`${plan.userId} is a ${row.role}, not a ${plan.role}`);
  } else if (row !== undefined && row.role !== "GUEST") {
    throw new RangeError(`${plan.userId} exists with another role; nothing was changed`);
  }
  if (row !== undefined && row.cognitoSub !== "" && row.cognitoSub !== sub) throw new RangeError(`${plan.userId} is bound to another Cognito user; nothing was changed`);
}

export async function runInvite(plan: InvitePlan, deps: InviteDeps): Promise<InviteOutcome> {
  const existing = await deps.findUser(plan.username);
  if (existing !== undefined && existing.ispId !== undefined && existing.ispId !== plan.ispId) throw new RangeError(`${plan.username} already exists for another operator; nothing was changed`);
  await checkRow(plan, deps, existing?.sub);
  const { sub } = existing ?? (await deps.createUser({ username: plan.username, ispId: plan.ispId, ...(plan.kind === "STAFF" && plan.email !== undefined ? { email: plan.email } : {}) }));
  const passwordSet = existing === undefined || plan.resetPassword;
  if (passwordSet) {
    const password = generatePassword();
    await deps.setPermanentPassword(plan.username, password);
    deps.saveCredential(plan.username, plan.ispId, password);
  }
  if (plan.kind === "GUEST") await deps.disableMfa(plan.username);
  await deps.addToGroup(plan.username, plan.kind === "GUEST" ? "GUEST" : plan.role);
  await deps.bindRow(plan, sub);
  const role = plan.kind === "GUEST" ? `GUEST ${plan.origin}` : plan.role;
  deps.report(`${existing === undefined ? "created" : "kept"} ${plan.username} (${role} of ${plan.ispId}; ${passwordSet ? `password in ${CREDENTIALS_FILE}` : "password unchanged"})`);
  return { username: plan.username, created: existing === undefined, passwordSet };
}

/**
 * Adds to the git-ignored credentials file, readable by the operator only: the new content goes to a
 * fresh file created 0600 next to it and replaces the old one by rename, so a password never sits in a
 * file with wider permissions, not even for an instant.
 */
export function saveCredentialTo(path: string, username: string, ispId: string, password: string, now: Date): void {
  const current: Record<string, unknown> = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : {};
  current[username] = { ispId, password, createdAt: now.toISOString(), login: "https://cuadrilla.demo.craftech.io/login" };
  const next = `${path}.${process.pid}.tmp`;
  writeFileSync(next, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(next, 0o600);
  renameSync(next, path);
}

/** Cognito's admin API on the pool of the `Auth` link and the registry rows through the connector. */
async function cognitoInviteDeps(saveCredential: InviteDeps["saveCredential"]): Promise<InviteDeps> {
  const cognito = await import("@aws-sdk/client-cognito-identity-provider");
  const { authConfig } = await import("../../packages/bff/src/auth/config");
  const { connector } = await import("../../packages/bff/src/connector/index");
  const { awsClientConfig, CLIENT_TIMEOUTS } = await import("../../packages/bff/src/lib/clients");
  const pool = authConfig();
  const client = new cognito.CognitoIdentityProviderClient({ region: pool.region, ...awsClientConfig(CLIENT_TIMEOUTS.cognito) });
  const isps = connector().isps;
  const UserPoolId = pool.userPoolId;
  const subOf = (attributes: ReadonlyArray<{ readonly Name?: string; readonly Value?: string }> | undefined): string => {
    const sub = attributes?.find((attribute) => attribute.Name === "sub")?.Value;
    if (!sub) throw new Error("Cognito answered a user without sub");
    return sub;
  };
  return {
    async findUser(username) {
      try {
        const user = await client.send(new cognito.AdminGetUserCommand({ UserPoolId, Username: username }));
        const ispId = user.UserAttributes?.find((attribute) => attribute.Name === ISP_ID_CLAIM)?.Value;
        return { sub: subOf(user.UserAttributes), ...(ispId === undefined ? {} : { ispId }) };
      } catch (error) {
        if (error instanceof cognito.UserNotFoundException) return undefined;
        throw error;
      }
    },
    async createUser({ username, ispId, email }) {
      const attributes = [{ Name: ISP_ID_CLAIM, Value: ispId }, ...(email === undefined ? [] : [{ Name: "email", Value: email }, { Name: "email_verified", Value: "true" }])];
      const created = await client.send(new cognito.AdminCreateUserCommand({ UserPoolId, Username: username, UserAttributes: attributes, MessageAction: "SUPPRESS" }));
      return { sub: subOf(created.User?.Attributes) };
    },
    async setPermanentPassword(username, password) {
      await client.send(new cognito.AdminSetUserPasswordCommand({ UserPoolId, Username: username, Password: password, Permanent: true }));
    },
    async disableMfa(username) {
      await client.send(new cognito.AdminSetUserMFAPreferenceCommand({ UserPoolId, Username: username, SoftwareTokenMfaSettings: { Enabled: false, PreferredMfa: false } }));
    },
    async addToGroup(username, group) {
      await client.send(new cognito.AdminAddUserToGroupCommand({ UserPoolId, Username: username, GroupName: group }));
    },
    async getRow(ispId, userId) {
      const user = await isps.getUser(ispId, userId);
      return user === undefined ? undefined : { role: user.role, cognitoSub: user.cognitoSub, ...(user.guestOrigin === undefined ? {} : { guestOrigin: user.guestOrigin }) };
    },
    async bindRow(plan, sub) {
      if (plan.kind === "STAFF") {
        await isps.setCognitoSub(plan.ispId, plan.userId, sub);
        return;
      }
      await isps.putUser({ ispId: plan.ispId, userId: plan.userId, role: "GUEST", name: "Invitado", cognitoSub: sub, active: true, guestOrigin: plan.origin, cognitoUsername: plan.username });
    },
    saveCredential,
    report: (line) => void process.stdout.write(`console:invite: ${line}\n`),
  };
}

async function main(): Promise<void> {
  const plan = planInvite(parseInviteArgs(process.argv.slice(2)));
  const credentials = resolve(process.cwd(), CREDENTIALS_FILE);
  await runInvite(plan, await cognitoInviteDeps((username, ispId, password) => saveCredentialTo(credentials, username, ispId, password, new Date())));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`console:invite: ${error instanceof Error ? error.message : "failed"}\n`);
    process.exit(1);
  });
}
