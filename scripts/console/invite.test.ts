// `console:invite` (ADR-0024, ADR-0025, docs/pending.md P-03): invited guests and the internal roles, only
// by invitation, each with a random password of at least 24 characters that never reaches a log.
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CREDENTIALS_FILE, type InviteDeps, type InvitePlan, type RegistryRow, generatePassword, parseInviteArgs, planInvite, runInvite, saveCredentialTo } from "./invite";

const plan = (...argv: string[]): InvitePlan => planInvite(parseInviteArgs(["--stage", "poc", ...argv]));

function fakeDeps(options: { readonly users?: Record<string, { sub: string; ispId?: string }>; readonly rows?: Record<string, RegistryRow> } = {}) {
  const users = new Map(Object.entries(options.users ?? {}));
  const rows = new Map(Object.entries(options.rows ?? {}));
  const calls: string[] = [];
  const passwords = new Map<string, string>();
  const saved: Array<{ username: string; ispId: string; password: string }> = [];
  const reports: string[] = [];
  const deps: InviteDeps = {
    findUser: async (username) => users.get(username),
    createUser: async ({ username, ispId, email }) => {
      calls.push(`create ${username} ${ispId}${email === undefined ? "" : " with email"}`);
      const user = { sub: `sub-${username}`, ispId };
      users.set(username, user);
      return user;
    },
    setPermanentPassword: async (username, password) => void passwords.set(username, password),
    disableMfa: async (username) => void calls.push(`mfa-off ${username}`),
    addToGroup: async (username, group) => void calls.push(`group ${username} ${group}`),
    getRow: async (ispId, userId) => rows.get(`${ispId}/${userId}`),
    bindRow: async (invited, sub) => void rows.set(`${invited.ispId}/${invited.userId}`, { role: invited.kind === "GUEST" ? "GUEST" : invited.role, cognitoSub: sub, ...(invited.kind === "GUEST" ? { guestOrigin: invited.origin } : {}) }),
    saveCredential: (username, ispId, password) => void saved.push({ username, ispId, password }),
    report: (line) => void reports.push(line),
  };
  return { deps, calls, passwords, saved, reports, rows };
}

describe("console:invite", () => {
  it("plans guests by slot and the rehearsal account, and refuses mixed or unknown flags", () => {
    expect(plan("--guest", "7")).toMatchObject({ kind: "GUEST", username: "guest-07", userId: "usr-guest-07", ispId: "isp-guest-07", origin: "INVITED" });
    expect(plan("--guest", "test")).toMatchObject({ username: "guest-test", ispId: "isp-guest-test", origin: "TEST" });
    expect(plan("--role", "SUPERVISOR", "--user", "usr-adriana", "--email", "Adriana@Example.com")).toMatchObject({ kind: "STAFF", role: "SUPERVISOR", ispId: "isp-demo", email: "adriana@example.com" });
    expect(() => plan("--guest", "99")).toThrow(/01 to 98/);
    expect(() => plan("--guest", "07", "--role", "OPS")).toThrow(/choose one/);
    expect(() => plan("--role", "GUEST", "--user", "usr-x")).toThrow(/SUPERVISOR or OPS/);
    expect(() => planInvite(parseInviteArgs(["--guest", "07"]))).toThrow(/--stage poc/);
    expect(() => parseInviteArgs(["--invitee", "07"])).toThrow(/unknown argument/);
  });

  it("generates passwords of 28 characters with every class the pool asks for, never twice the same", () => {
    const passwords = Array.from({ length: 50 }, () => generatePassword());
    for (const password of passwords) {
      expect(password).toHaveLength(28);
      expect(password).toMatch(/[A-Z]/);
      expect(password).toMatch(/[a-z]/);
      expect(password).toMatch(/\d/);
      expect(password).toMatch(/[!#%+\-=?@^_]/);
    }
    expect(new Set(passwords).size).toBe(passwords.length);
    expect(() => generatePassword(20)).toThrow(/24/);
  });

  it("creates an invited guest without email, with a password kept out of every report, MFA off, group GUEST and its registry row", async () => {
    const fake = fakeDeps();
    const outcome = await runInvite(plan("--guest", "07"), fake.deps);
    expect(outcome).toEqual({ username: "guest-07", created: true, passwordSet: true });
    expect(fake.calls).toEqual(["create guest-07 isp-guest-07", "mfa-off guest-07", "group guest-07 GUEST"]);
    expect(fake.rows.get("isp-guest-07/usr-guest-07")).toEqual({ role: "GUEST", cognitoSub: "sub-guest-07", guestOrigin: "INVITED" });
    const password = fake.passwords.get("guest-07") ?? "";
    expect(password.length).toBeGreaterThanOrEqual(24);
    expect(fake.saved).toEqual([{ username: "guest-07", ispId: "isp-guest-07", password }]);
    expect(fake.reports.join("\n")).not.toContain(password);
    expect(fake.reports.join("\n")).toContain(CREDENTIALS_FILE);
  });

  it("keeps the password of an existing account unless --reset-password, and never touches another operator's user", async () => {
    const fake = fakeDeps({ users: { "guest-07": { sub: "sub-07", ispId: "isp-guest-07" }, "guest-08": { sub: "sub-08", ispId: "isp-guest-31" } } });
    expect(await runInvite(plan("--guest", "07"), fake.deps)).toMatchObject({ created: false, passwordSet: false });
    expect(fake.saved).toEqual([]);
    expect(await runInvite(plan("--guest", "07", "--reset-password"), fake.deps)).toMatchObject({ passwordSet: true });
    expect(fake.saved).toHaveLength(1);
    await expect(runInvite(plan("--guest", "08"), fake.deps)).rejects.toThrow(/another operator/);
  });

  it("binds an internal role only to a seeded row of the demo operator with the same role, by invitation", async () => {
    const rows = { "isp-demo/usr-adriana": { role: "SUPERVISOR", cognitoSub: "" }, "isp-demo/usr-ops-lina": { role: "OPS", cognitoSub: "" } };
    const fake = fakeDeps({ rows });
    await runInvite(plan("--role", "SUPERVISOR", "--user", "usr-adriana", "--email", "adriana@example.com"), fake.deps);
    expect(fake.calls).toEqual(["create usr-adriana isp-demo with email", "group usr-adriana SUPERVISOR"]);
    expect(fake.rows.get("isp-demo/usr-adriana")).toMatchObject({ role: "SUPERVISOR", cognitoSub: "sub-usr-adriana" });
    expect(fake.saved.map((entry) => entry.username)).toEqual(["usr-adriana"]);
    await expect(runInvite(plan("--role", "SUPERVISOR", "--user", "usr-ops-lina"), fakeDeps({ rows }).deps)).rejects.toThrow(/is a OPS/);
    await expect(runInvite(plan("--role", "OPS", "--user", "usr-nobody"), fakeDeps({ rows }).deps)).rejects.toThrow(/seeded rows only/);
    const bound = fakeDeps({ rows: { "isp-demo/usr-adriana": { role: "SUPERVISOR", cognitoSub: "sub-of-someone-else" } } });
    await expect(runInvite(plan("--role", "SUPERVISOR", "--user", "usr-adriana"), bound.deps)).rejects.toThrow(/another Cognito user/);
    expect(bound.calls).toEqual([]);
  });

  it("writes the credentials file readable by the operator only", () => {
    const dir = mkdtempSync(join(tmpdir(), "invite-"));
    const path = join(dir, CREDENTIALS_FILE);
    saveCredentialTo(path, "guest-07", "isp-guest-07", "Secret-Password-For-Test-0001", new Date("2026-10-09T12:00:00.000Z"));
    saveCredentialTo(path, "guest-08", "isp-guest-08", "Secret-Password-For-Test-0002", new Date("2026-10-09T12:00:00.000Z"));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(Object.keys(JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)).toEqual(["guest-07", "guest-08"]);
  });
});
