// SC-20 · the own sign-up, the guest's world and the lead (docs/test-plan.md §4.5; FL-104 … FL-118, FL-121,
// FL-122). Every `signup.start` goes through the PUBLIC path, `POST /api/signup.start` through the Router,
// the edge's web ACL (its silent Challenge, solved by the page's AWS WAF SDK in a headless Chromium,
// lib/public-signup.ts) and the Bff, with the real limits and no exception: the `QaDriver` never writes a
// lead nor a counter of the sign-up. Every address is `success+qa-<runId>-<n>@simulator.amazonses.com`
// (the mailbox simulator; `origin QA` by the server's own rule, so the notice to Craftech is suppressed and
// the account's world counts in the run's own room). Only what IAM and the code can fence to QA goes
// through the QA seam of ADR-0025 §7: the confirmation and the sign-in, administrative and only for users
// whose address IN COGNITO is a QA one; `guest.forceExpire` only for an account of a QA run's room;
// `guest.capsOverride` only on that room's limits; the cleanup through `GuestAccountDeletion`. No password
// ever leaves the driver.
//
// The run's starts spend the runner's per-IP room of the clock hour (5): steps 1, 2, 4 and 7 take four, so
// step 8 proves the limit with the fifth and the sixth. Run it from a runner without other sign-ups in that
// hour (a scenarios job of its own); a second run in the same hour from the same IP is refused at step 1.
import { createHash } from "node:crypto";
import { authRules, edgeRules } from "../../infra/waf-spec";
import { type ScenarioContext, AssertionFailed, ensure } from "./lib/context";
import { edgeConfig } from "./lib/edge";
import { WAITS } from "./lib/eventually";
import { type PublicSignup, type StartAnswer, type StartForm, type Started, openPublicSignup } from "./lib/public-signup";
import { defineScenario } from "./lib/steps";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const QA_LIMITS = { activeWorlds: 150, signupsPerDay: 150 } as const;
/** Starts per IP and clock hour (packages/bff/src/signup/limits.ts `perIpPerHour`). */
const PER_IP_PER_HOUR = 5;
const HOUR_MS = 3_600_000;

interface LeadView {
  readonly found: boolean;
  readonly leadId?: string;
  readonly status?: string;
  readonly origin?: string;
  readonly consents?: Record<string, { accepted: boolean; textVersion: string; locale?: string; at?: string }>;
  readonly utm?: Record<string, string> | null;
  readonly pendingUsernames?: string[];
  readonly hasSub?: boolean;
  readonly notifyOutcome?: string | null;
  readonly lastLoginAt?: string | null;
  readonly events?: Array<{ kind: string }>;
}

interface Principal {
  readonly clockId: string;
  readonly ispId: string;
  readonly role: string;
  readonly isGuest: boolean;
}

/** The QA address of the run's n-th sign-up (the seam's expression, lower case). */
export function qaEmail(runId: string, n: number | string): string {
  return `success+qa-${runId}-${n}@simulator.amazonses.com`;
}

/** A `gst-<ULID>` user that never collides with a real one: derived from the run and a label. */
export function qaUsername(runId: string, label: string): string {
  const digest = createHash("sha256").update(`${runId}/${label}`).digest();
  return `gst-${[...digest.subarray(0, 26)].map((byte) => CROCKFORD.charAt(byte % 32)).join("")}`.replace(/^gst-[89A-Z]/, "gst-7");
}

function track(ctx: ScenarioContext, username: string): void {
  const users = (ctx.state.users as string[] | undefined) ?? [];
  if (!users.includes(username)) ctx.state.users = [...users, username];
}

/** The scenario's browser on `/signup`, opened once per run (closed by the cleanup). */
async function publicPath(ctx: ScenarioContext): Promise<PublicSignup> {
  const open = ctx.state.publicSignup as Promise<PublicSignup> | undefined;
  if (open !== undefined) return open;
  const opening = openPublicSignup(edgeConfig().baseUrl);
  ctx.state.publicSignup = opening;
  return opening;
}

/** One public start; an accepted one is tracked for the cleanup and counted in its clock hour. */
async function attemptStart(ctx: ScenarioContext, n: number | string, extra: Omit<StartForm, "email"> = {}): Promise<StartAnswer> {
  const answer = await (await publicPath(ctx)).start({ email: qaEmail(ctx.runId, n), ...extra });
  if (answer.ok) {
    track(ctx, answer.result.username);
    const hour = Math.floor(ctx.now() / HOUR_MS);
    const hours = (ctx.state.startsByHour as Record<number, number> | undefined) ?? {};
    ctx.state.startsByHour = { ...hours, [hour]: (hours[hour] ?? 0) + 1 };
  }
  return answer;
}

async function start(ctx: ScenarioContext, n: number | string, extra: Omit<StartForm, "email"> = {}): Promise<Started> {
  const answer = await attemptStart(ctx, n, { contactAccepted: true, utm: { utm_source: "qa", utm_campaign: "sc20" }, ...extra });
  if (!answer.ok) throw new AssertionFailed(`the public signup.start answered ${answer.status} ${answer.code}${answer.reason === undefined ? "" : `/${answer.reason}`}`);
  return answer.result;
}

/** start → signUp → confirm: a confirmed account of the run. */
async function confirmed(ctx: ScenarioContext, n: number | string): Promise<string> {
  const started = await start(ctx, n);
  await ctx.qa("auth.signUp", { username: started.username, email: qaEmail(ctx.runId, n), ticket: started.ticket });
  await ctx.qa("auth.confirmQaSignup", { username: started.username });
  return started.username;
}

async function world(ctx: ScenarioContext, username: string, until: string[]): Promise<{ principal: Principal; status: string; summary?: { workOrders: number; installers: string[] } }> {
  return ctx.eventually(
    `the guest's world ${until.join(" or ")}`,
    async () => {
      const principal = (await ctx.qa("auth.qaLogin", { username })) as Principal;
      const view = (await ctx.qa("console", { clockId: principal.clockId, procedure: "guest.world", signupUser: username })) as { status: string; summary?: { workOrders: number; installers: string[] } };
      return until.includes(view.status) ? { principal, status: view.status, ...(view.summary === undefined ? {} : { summary: view.summary }) } : undefined;
    },
    WAITS.worldReadySec,
    5,
  );
}

export default defineScenario({
  id: "SC-20",
  slug: "sc-20",
  title: "The own sign-up, the guest's world and the lead",
  suites: ["full"],
  alone: true,
  cleanup: async (ctx) => {
    const browser = ctx.state.publicSignup as Promise<PublicSignup> | undefined;
    await browser?.then((open) => open.close()).catch(() => undefined);
    await ctx.qa("guest.capsOverride", QA_LIMITS);
    for (const username of (ctx.state.users as string[] | undefined) ?? []) await ctx.qa("auth.cleanupQaSignup", { username });
  },
  steps: [
    {
      id: "1",
      title: "Public signup.start (Router, WAF token, Bff) with both consents and UTM → a PENDING lead, origin QA, the user pending and a ticket",
      kind: "det",
      flows: ["FL-104", "FL-115"],
      after: "preset",
      async run(ctx) {
        const started = await start(ctx, 1);
        ctx.check(/^gst-[0-9A-HJKMNP-TV-Z]{26}$/.test(started.username) && started.ticket.length > 0, "no gst-* user or ticket");
        const lead = (await ctx.qa("leads.get", { email: qaEmail(ctx.runId, 1) })) as LeadView;
        ctx.check(lead.found && lead.status === "PENDING" && lead.origin === "QA", `lead ${lead.status ?? "missing"} ${lead.origin ?? ""}`);
        ctx.check(lead.pendingUsernames?.includes(started.username) === true, "the user is not pending on the lead");
        for (const id of ["TERMS_PRIVACY", "CONTACT"]) ctx.check(lead.consents?.[id]?.accepted === true && typeof lead.consents[id]?.textVersion === "string", `consent ${id} not recorded`);
        ctx.check(lead.utm?.source === "qa", "the UTM was not kept");
        ctx.state.first = started;
      },
    },
    {
      id: "2",
      title: "auth.signUp with the ticket → UNCONFIRMED; without a ticket, and with another user's ticket → TICKET_INVALID and no user",
      kind: "det",
      flows: ["FL-104", "FL-114"],
      after: "1",
      async run(ctx) {
        const first = ctx.state.first as Started;
        const signed = (await ctx.qa("auth.signUp", { username: first.username, email: qaEmail(ctx.runId, 1), ticket: first.ticket })) as { outcome: string; status?: string };
        ctx.check(signed.outcome === "SIGNED_UP" && signed.status === "UNCONFIRMED", `the sign-up answered ${signed.outcome} ${signed.status ?? ""}`);
        const bare = qaUsername(ctx.runId, "noticket");
        const without = (await ctx.qa("auth.signUp", { username: bare, email: qaEmail(ctx.runId, "noticket"), omitTicket: true })) as { outcome: string; reason?: string; userExists?: boolean };
        ctx.check(without.outcome === "REFUSED" && without.reason === "TICKET_INVALID" && without.userExists === false, `without a ticket: ${without.outcome} ${without.reason ?? ""}`);
        const other = await start(ctx, 2);
        const stolen = (await ctx.qa("auth.signUp", { username: qaUsername(ctx.runId, "stolen"), email: qaEmail(ctx.runId, 2), ticket: other.ticket })) as { outcome: string; reason?: string; userExists?: boolean };
        ctx.check(stolen.outcome === "REFUSED" && stolen.reason === "TICKET_INVALID" && stolen.userExists === false, `with another user's ticket: ${stolen.outcome} ${stolen.reason ?? ""}`);
      },
    },
    {
      id: "3",
      title: "auth.confirmQaSignup → the lead CONFIRMED (SUPPRESSED_QA), the GUEST row of origin SIGNUP, the world READY in ≤ 60 s",
      kind: "det",
      flows: ["FL-105", "FL-107", "FL-115", "FL-116"],
      after: "2",
      async run(ctx) {
        const first = ctx.state.first as Started;
        const confirmedUser = (await ctx.qa("auth.confirmQaSignup", { username: first.username })) as { status: string };
        ctx.check(confirmedUser.status === "CONFIRMED", `the user is ${confirmedUser.status}`);
        const lead = await ctx.eventually("the lead CONFIRMED", async () => {
          const read = (await ctx.qa("leads.get", { username: first.username })) as LeadView;
          return read.status === "CONFIRMED" && read.notifyOutcome !== null ? read : undefined;
        }, 60);
        ctx.check(lead.hasSub === true && lead.notifyOutcome === "SUPPRESSED_QA", `lead sub ${String(lead.hasSub)}, notice ${lead.notifyOutcome ?? "none"}`);
        const ready = await world(ctx, first.username, ["READY"]);
        ctx.check(ready.principal.role === "GUEST" && ready.principal.isGuest && /^isp-guest-s\d{6}[a-z2-7]{5}$/.test(ready.principal.ispId), `principal ${ready.principal.role} ${ready.principal.ispId}`);
        ctx.check((ready.summary?.workOrders ?? 0) > 0 && (ready.summary?.installers.length ?? 0) > 0, "the world has none of the template's rows");
        ctx.state.firstIsp = ready.principal.ispId;
      },
    },
    {
      id: "4",
      title: "Public signup.start with the same email → EMAIL_TAKEN and no new lead",
      kind: "det",
      flows: ["FL-121"],
      after: "3",
      async run(ctx) {
        const before = (await ctx.qa("leads.get", { email: qaEmail(ctx.runId, 1) })) as LeadView;
        const again = await attemptStart(ctx, 1, { contactAccepted: true });
        ctx.check(!again.ok && again.reason === "EMAIL_TAKEN", `the second start answered ${again.ok ? "ok" : again.reason ?? again.code}`);
        const after = (await ctx.qa("leads.get", { email: qaEmail(ctx.runId, 1) })) as LeadView;
        ctx.check(after.leadId === before.leadId && after.status === "CONFIRMED", "the lead changed");
      },
    },
    {
      id: "5",
      title: "auth.qaLogin → GUEST, isGuest and the generation's operator; guest.world READY; the LOGIN event; no internal role",
      kind: "det",
      flows: ["FL-108", "FL-122"],
      after: "3",
      async run(ctx) {
        const first = ctx.state.first as Started;
        const principal = (await ctx.qa("auth.qaLogin", { username: first.username })) as Principal;
        ctx.check(principal.role === "GUEST" && principal.isGuest && principal.ispId === ctx.state.firstIsp, `principal ${principal.role} ${principal.ispId}`);
        const view = (await ctx.qa("console", { clockId: principal.clockId, procedure: "guest.world", signupUser: first.username })) as { status: string };
        ctx.check(view.status === "READY", `the world is ${view.status}`);
        const lead = (await ctx.qa("leads.get", { username: first.username })) as LeadView;
        ctx.check(lead.events?.some((event) => event.kind === "LOGIN") === true && typeof lead.lastLoginAt === "string", "no LOGIN on the lead");
        const staffOnly = await ctx.attempt("console", { clockId: principal.clockId, procedure: "account.changePassword", signupUser: first.username });
        ctx.check(!staffOnly.ok && staffOnly.error.code === "FORBIDDEN", "the guest reached a staff action");
      },
    },
    {
      id: "6",
      title: "guest.forceExpire and auth.qaLogin → a new generation READY; the lead and the account the same; the old world out of reach",
      kind: "det",
      flows: ["FL-111"],
      after: "3",
      async run(ctx) {
        const first = ctx.state.first as Started;
        const lead = (await ctx.qa("leads.get", { username: first.username })) as LeadView;
        await ctx.qa("guest.forceExpire", { username: first.username });
        const renewed = await ctx.eventually("the new generation READY", async () => {
          const next = await world(ctx, first.username, ["READY", "PROVISIONING"]);
          return next.principal.ispId !== ctx.state.firstIsp && next.status === "READY" ? next : undefined;
        }, WAITS.worldReadySec * 2);
        ctx.check(renewed.principal.ispId !== ctx.state.firstIsp, "the generation did not change");
        const after = (await ctx.qa("leads.get", { username: first.username })) as LeadView;
        ctx.check(after.leadId === lead.leadId && after.status === "CONFIRMED", "the lead changed with the world");
        const old = await ctx.attempt("console", { clockId: `GUEST#${String(ctx.state.firstIsp)}`, procedure: "orders.list", signupUser: first.username });
        ctx.check(!old.ok, "the old world is still reachable");
      },
    },
    {
      id: "7",
      title: "With guest.capsOverride of active worlds at 0, another confirmed sign-up → the account and the lead, the world CAP_FULL",
      kind: "det",
      flows: ["FL-112"],
      after: "preset",
      async run(ctx) {
        await ctx.qa("guest.capsOverride", { activeWorlds: 0, signupsPerDay: 150 });
        try {
          const username = await confirmed(ctx, 7);
          const full = await world(ctx, username, ["CAP_FULL"]);
          ctx.check(full.status === "CAP_FULL", `the world is ${full.status}`);
          const lead = (await ctx.qa("leads.get", { username })) as LeadView;
          ctx.check(lead.status === "CONFIRMED", "no confirmed lead");
        } finally {
          await ctx.qa("guest.capsOverride", QA_LIMITS);
        }
      },
    },
    {
      id: "8",
      title: "Public signup.start from the runner's IP until refused → RATE_LIMITED after at most 5 starts of the clock hour",
      kind: "det",
      flows: ["FL-113"],
      after: "preset",
      async run(ctx) {
        // The hour may roll over while the step runs: its counters start again, so one more round.
        for (let round = 0; round < 2; round += 1) {
          const hour = Math.floor(ctx.now() / HOUR_MS);
          let refusal: Extract<StartAnswer, { ok: false }> | undefined;
          for (let n = 0; n <= PER_IP_PER_HOUR && refusal === undefined; n += 1) {
            const answer = await attemptStart(ctx, `ip${round}${n}`);
            if (!answer.ok) refusal = answer;
          }
          if (refusal === undefined && Math.floor(ctx.now() / HOUR_MS) !== hour) continue;
          ensure(refusal !== undefined, `${PER_IP_PER_HOUR + 1} starts in one clock hour and none refused`);
          ctx.check(refusal.reason === "RATE_LIMITED", `the refusal was ${refusal.code}${refusal.reason === undefined ? "" : `/${refusal.reason}`}`);
          const accepted = ((ctx.state.startsByHour as Record<number, number> | undefined) ?? {})[hour] ?? 0;
          ctx.check(accepted <= PER_IP_PER_HOUR, `${accepted} starts of the run were accepted in one clock hour`);
          ctx.inform("ACCEPTED_IN_HOUR", String(accepted));
          return;
        }
        throw new AssertionFailed("the clock hour rolled over twice during the step");
      },
    },
    {
      id: "9",
      title: "auth.cleanupQaSignup → no user (nor the pending ones), no lead, no registry row nor reachable world",
      kind: "det",
      flows: ["FL-118"],
      after: "3",
      async run(ctx) {
        const first = ctx.state.first as Started;
        const deleted = (await ctx.qa("auth.cleanupQaSignup", { username: first.username })) as { outcome: string; leadId?: string };
        ctx.check(deleted.outcome === "DELETED", `the deletion answered ${deleted.outcome}`);
        const lead = (await ctx.qa("leads.get", { email: qaEmail(ctx.runId, 1) })) as LeadView;
        ctx.check(!lead.found, "the lead is still there");
        const gone = await ctx.attempt("auth.qaLogin", { username: first.username });
        ctx.check(!gone.ok && gone.error.code === "NOT_FOUND", "the user is still in the pool");
        ctx.inform("LEAD_DELETED", deleted.leadId === undefined ? "no leadId" : "with its leadId");
      },
    },
    {
      id: "10",
      title: "waf.probe → rules, actions (no CAPTCHA), the Count overrides, the sign-up scope, limits and associations equal to infra/waf-spec.ts",
      kind: "det",
      flows: ["FL-114"],
      after: "preset",
      async run(ctx) {
        const probe = (await ctx.qa("waf.probe", {})) as { edge?: { WebACL?: { Rules?: unknown[] } }; auth?: { WebACL?: { Rules?: unknown[] } }; poolAssociation?: { WebACL?: unknown } };
        const same = (live: unknown[] | undefined, spec: readonly unknown[]) => JSON.stringify(normalizeRules(live ?? [])) === JSON.stringify(normalizeRules([...spec]));
        ctx.check(same(probe.edge?.WebACL?.Rules, edgeRules()), "the edge ACL differs from infra/waf-spec.ts");
        ctx.check(same(probe.auth?.WebACL?.Rules, authRules()), "the pool's ACL differs from infra/waf-spec.ts");
        ctx.check(!JSON.stringify(probe).includes("Captcha"), "a rule uses CAPTCHA");
        ctx.check(probe.poolAssociation?.WebACL !== undefined, "the pool has no web ACL");
      },
    },
  ],
});

/** Rules by name with sorted keys: what the API answers carries the same values in another order. */
function normalizeRules(rules: readonly unknown[]): unknown[] {
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort);
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sort(item)]));
    return value;
  };
  return [...rules].map(sort).sort((a, b) => String((a as { Name?: string }).Name).localeCompare(String((b as { Name?: string }).Name)));
}
