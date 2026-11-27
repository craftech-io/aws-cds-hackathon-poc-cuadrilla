// `console:block` (ADR-0029 §11, FL-126) over doubles: a Cognito client that records the commands it is
// sent and the registry and `Runtime` in memory. Nothing reaches AWS.
import { describe, expect, it } from "vitest";
import { MemoryTableClient } from "../../packages/bff/src/connector/memory/table-client";
import { markSessionPassed } from "../../packages/bff/src/phone/session";
import type { EmailSource } from "../leads/email-input";
import { parseBlockArgs, runBlock } from "./block";

const NOW = new Date("2026-11-27T15:00:00.000Z");
const ROW = { PK: "ISP#isp-guest-07", SK: "USER#usr-g01K80000000000000000000007" };
const USERNAME = "gst-01K80000000000000000000007";
const POOL = "us-east-1_TEST";

const noInput: EmailSource = { readStdin: async () => "", readFile: async () => "" };
const input = (text: string): EmailSource => ({ readStdin: async () => text, readFile: async () => text });

interface Sent {
  readonly command: string;
  readonly input: Record<string, unknown>;
}

function fakeCognito(users: ReadonlyArray<{ readonly username: string; readonly sub: string; readonly email: string }>) {
  const sent: Sent[] = [];
  return {
    sent,
    send: async (command: { readonly constructor: { readonly name: string }; readonly input: Record<string, unknown> }) => {
      sent.push({ command: command.constructor.name, input: command.input });
      const attributes = (user: (typeof users)[number]) => [
        { Name: "sub", Value: user.sub },
        { Name: "email", Value: user.email },
      ];
      if (command.constructor.name === "AdminGetUserCommand") {
        const user = users.find((candidate) => candidate.username === command.input.Username);
        if (user === undefined) throw Object.assign(new Error("User does not exist."), { name: "UserNotFoundException" });
        return { Username: user.username, UserAttributes: attributes(user) };
      }
      if (command.constructor.name === "ListUsersCommand") {
        const email = /^email = "(.*)"$/.exec(String(command.input.Filter))?.[1];
        return { Users: users.filter((user) => user.email === email).map((user) => ({ Username: user.username, Attributes: attributes(user) })) };
      }
      return {};
    },
  };
}

async function setup() {
  const client = new MemoryTableClient();
  await client.put("Isps", { ...ROW, entity: "ConsoleUser", ispId: "isp-guest-07", userId: "usr-g01K80000000000000000000007", role: "GUEST", name: "Invitada", cognitoSub: "sub-7", cognitoSubKey: "SUB#sub-7", active: true, phone: "+525512345678", phoneVerifiedAt: NOW.toISOString(), createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), version: 1 });
  await markSessionPassed(client, { userId: "usr-g01K80000000000000000000007", sessionId: "jti-1", authTime: Math.floor(NOW.getTime() / 1000) }, NOW);
  await markSessionPassed(client, { userId: "usr-g01K80000000000000000000007", sessionId: "jti-2", authTime: Math.floor(NOW.getTime() / 1000) }, NOW);
  const cognito = fakeCognito([{ username: USERNAME, sub: "sub-7", email: "invitada@correo-ficticio.mx" }]);
  return { client, cognito, deps: { cognito, userPoolId: POOL, client, now: () => NOW, wait: async () => undefined } };
}

const sessions = (client: MemoryTableClient) => client.dump("Runtime").filter((row) => String(row.PK).startsWith("PHONESESSION"));

describe("console:block [FL-126]", () => {
  it("[FL-126] --block marks the row, disables the Cognito user, signs it out everywhere and deletes its passed sessions", async () => {
    const { client, cognito, deps } = await setup();
    expect(sessions(client)).toHaveLength(4);
    const result = await runBlock({ who: { username: USERNAME }, action: "BLOCK" }, deps);
    expect(result).toEqual({ user: USERNAME, outcome: "BLOCKED", userId: "usr-g01K80000000000000000000007", ispId: "isp-guest-07", sessionsCleared: 2 });
    expect(await client.get("Isps", ROW)).toMatchObject({ blockedAt: NOW.toISOString() });
    expect(cognito.sent.map((sent) => sent.command)).toEqual(["AdminGetUserCommand", "AdminDisableUserCommand", "AdminUserGlobalSignOutCommand"]);
    expect(cognito.sent.every((sent) => sent.input.UserPoolId === POOL)).toBe(true);
    expect(sessions(client)).toEqual([]);
  });

  it("[FL-126] --unblock takes the mark away and enables the user", async () => {
    const { client, cognito, deps } = await setup();
    await runBlock({ who: { username: USERNAME }, action: "BLOCK" }, deps);
    expect(await runBlock({ who: { username: USERNAME }, action: "UNBLOCK" }, deps)).toMatchObject({ outcome: "UNBLOCKED" });
    expect((await client.get("Isps", ROW))?.blockedAt).toBeUndefined();
    expect(cognito.sent.at(-1)?.command).toBe("AdminEnableUserCommand");
  });

  it("[FL-126] finds the account by its one address, read from standard input, never printed", async () => {
    const { cognito, deps } = await setup();
    const request = await parseBlockArgs(["--stage", "poc", "--by-email", "--block"], input("invitada@correo-ficticio.mx\n"));
    expect(request).toEqual({ who: { email: "invitada@correo-ficticio.mx" }, action: "BLOCK" });
    const result = await runBlock(request, deps);
    expect(result).toMatchObject({ user: USERNAME, outcome: "BLOCKED" });
    expect(JSON.stringify(result)).not.toContain("@");
    expect(cognito.sent[0]).toEqual({ command: "ListUsersCommand", input: { UserPoolId: POOL, Filter: 'email = "invitada@correo-ficticio.mx"', Limit: 2 } });
    await expect(runBlock({ who: { email: "otra@correo-ficticio.mx" }, action: "BLOCK" }, deps)).rejects.toThrow(/exactly one Cognito user/);
  });

  it("[FL-126] takes one account and exactly one action; an address never as an argument", async () => {
    expect(await parseBlockArgs(["--stage", "poc", "--username", USERNAME, "--unblock"], noInput)).toEqual({ who: { username: USERNAME }, action: "UNBLOCK" });
    await expect(parseBlockArgs(["--stage", "poc", "--username", "ana@correo-ficticio.mx", "--block"], noInput)).rejects.toThrow(/never from an argument/);
    await expect(parseBlockArgs(["--stage", "poc", "--username", USERNAME], noInput)).rejects.toThrow(/exactly one of --block or --unblock/);
    await expect(parseBlockArgs(["--stage", "poc", "--username", USERNAME, "--block", "--unblock"], noInput)).rejects.toThrow(/exactly one of --block or --unblock/);
    await expect(parseBlockArgs(["--stage", "poc", "--block"], noInput)).rejects.toThrow(/exactly one of --username or --by-email/);
    await expect(parseBlockArgs(["--username", USERNAME, "--block"], noInput)).rejects.toThrow(/--stage poc/);
    await expect(parseBlockArgs(["--stage", "poc", "--by-email", "--block"], input('a"b@correo-ficticio.mx'))).rejects.toThrow(/not an email address/);
  });
});
