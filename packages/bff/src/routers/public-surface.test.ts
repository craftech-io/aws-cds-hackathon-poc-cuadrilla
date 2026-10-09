// No procedure of the console, public or not, hands out a lead or a lead's email, to any role
// (ADR-0026: the leads never have a view for guests; an internal view is out of scope). Two layers:
// the source of every router (which lead modules it may import and what it may call on a store), and
// every procedure of the real `appRouter` called as the public, a supervisor, an operator and a guest
// with inputs that name the lead, while a lead with a real-looking address exists.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { type TestContextDeps, createTestIssuer, testContextDeps } from "../auth/testing";
import { type Connector, createMemoryConnector } from "../connector/index";
import type { Lead } from "../leads/model";
import { confirmedLead, hashOf, leadHarness } from "../leads/testing";
import { type AccountPorts, createAccountRouter } from "./account";
import { appRouter } from "./index";
import { createCallerFactory, createContextFactory, router } from "./trpc";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROUTER_SOURCES = readdirSync(HERE).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));
const LEAD_IMPORT = /from\s+"\.\.\/leads\/([a-z-]+)"/g;
/** What a router may import from leads/: shapes and patterns, never a store or a table. */
const ALLOWED_LEAD_MODULES: Readonly<Record<string, readonly string[]>> = {
  "account.ts": ["deletion", "model"],
  // `signup.start` (WP-57) writes a pending lead and answers a ticket, never the lead.
  "signup.ts": ["store", "dynamo-table", "keys", "consent", "attribution", "model", "transitions"],
  // The QaDriver's direct `signup.start` (routers/qa-seam.ts): only the origin of an address, to refuse a non-QA one.
  "qa-seam.ts": ["keys"],
};
/** Store reads a router must never make: they hand back leads. */
const LEAD_READS = /\.(scan|findBySub|listEvents|get)\(\s*(?:hashOf|emailHash|leadEmailHash|input\.)/;

describe("the console never returns a lead [FL-117]", () => {
  it("[FL-117] routers import from leads/ only what their row allows, and never read leads back", () => {
    expect(ROUTER_SOURCES.length).toBeGreaterThan(3);
    for (const file of ROUTER_SOURCES) {
      const source = readFileSync(`${HERE}${file}`, "utf8");
      const imported = [...source.matchAll(LEAD_IMPORT)].map((match) => match[1] ?? "");
      const allowed = ALLOWED_LEAD_MODULES[file] ?? [];
      for (const module of imported) expect(allowed, `${file} imports leads/${module}`).toContain(module);
      if (imported.length > 0) expect(source, file).not.toMatch(LEAD_READS);
      expect(source, file).not.toMatch(/\bleads\.scan\b|scanMeta|MemoryLeadTable/);
    }
  });

  describe("every procedure, every role", () => {
    const issuer = createTestIssuer();
    let data: Connector;
    let deps: TestContextDeps;
    let lead: Lead;
    const fakePorts: AccountPorts = { deleteGuestAccount: async () => ({ outcome: "DELETED", leadId: lead.leadId, deletedUsers: 1 }) };
    const surface = router({ ...appRouter._def.record, account: createAccountRouter(() => fakePorts) });
    const caller = createCallerFactory(surface);
    const procedures = Object.keys(surface._def.procedures);
    const roles = {
      public: undefined,
      supervisor: () => issuer.idToken({ sub: "sub-adriana", ispId: "isp-demo", userId: "usr-adriana", role: "SUPERVISOR", isGuest: "false" }),
      ops: () => issuer.idToken({ sub: "sub-lina", ispId: "isp-demo", userId: "usr-ops-lina", role: "OPS", isGuest: "false" }),
      guest: () => issuer.idToken({ sub: "sub-guest07", ispId: "isp-guest-07", userId: "usr-guest-07", role: "GUEST", isGuest: "true", "cognito:groups": ["GUEST"] }),
    } as const;

    beforeEach(async () => {
      data = createMemoryConnector().connector;
      deps = testContextDeps(issuer, { connector: data });
      await data.isps.putUser({ ispId: "isp-demo", userId: "usr-adriana", role: "SUPERVISOR", name: "Supervisora", cognitoSub: "sub-adriana" });
      await data.isps.putUser({ ispId: "isp-demo", userId: "usr-ops-lina", role: "OPS", name: "Operaciones", cognitoSub: "sub-lina" });
      await data.isps.putUser({ ispId: "isp-guest-07", userId: "usr-guest-07", role: "GUEST", name: "Invitado 07", cognitoSub: "sub-guest07" });
      lead = await confirmedLead(leadHarness().store, { email: "visitante.real@example.com", name: "Visitante Real" });
    });

    it("[FL-117] no answer or error of any procedure carries the lead, its email, its id or its hash", async () => {
      expect(procedures.length).toBeGreaterThan(0);
      const leaks = [lead.email, lead.leadId, hashOf(lead.email), "Visitante Real"];
      const inputs = [undefined, {}, { email: lead.email }, { leadId: lead.leadId }, { userId: lead.userId, email: lead.email }];
      const seen: string[] = [];
      for (const [role, bearer] of Object.entries(roles)) {
        const headers: Record<string, string> = bearer === undefined ? {} : { authorization: `Bearer ${bearer()}` };
        const api = caller(await createContextFactory(() => deps)({ event: { headers } }));
        for (const path of procedures) {
          const call = path.split(".").reduce<unknown>((node, key) => Reflect.get(node as object, key), api) as (input?: unknown) => Promise<unknown>;
          for (const input of inputs) {
            let answer: string;
            try {
              answer = JSON.stringify((await call(input)) ?? null);
            } catch (error) {
              answer = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
            }
            seen.push(`${role} ${path}`);
            for (const leak of leaks) expect(answer, `${role} ${path} ${JSON.stringify(input)}`).not.toContain(leak);
          }
        }
      }
      expect(seen).toContain("guest account.deleteGuest");
      expect(deps.lines.join("\n")).not.toContain(lead.email);
    });
  });
});
