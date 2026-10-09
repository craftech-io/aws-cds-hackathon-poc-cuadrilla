// SC-00 · smoke of every deploy (docs/test-plan.md §4.5 and §6; `SMK/1` … `SMK/10`). The public pages and
// the edge are checked from the runner over HTTP; the stage's services through the `QaDriver`: the pool's
// clients and JWKS, the mocks, the manual's Knowledge Base, the real Scheduler, Transcribe and a full turn,
// SES with an attachment until DELIVERY, the policy audit, the structure of a real photo validation, the
// two web ACLs and the Bff's origin check. Every step is `det`: none asserts what the model decided.
import type { QaSnapshot } from "../../packages/bff/src/qa-driver/snapshot";
import { DAY, assertCleanOutbound, at, orderIn, personIn, settledOn, voice } from "./lib/assist";
import { Blocked, ensure } from "./lib/context";
import { directOriginProblems, healthProblem, publicPagesProblems, signupEdge } from "./lib/edge";
import { WAITS } from "./lib/eventually";
import { agentReplies, citationsOf } from "./lib/oracles";
import { defineScenario } from "./lib/steps";
import { type World, createWorld, op, stored } from "./lib/world";

const ONE_DAY_ORDER = { onu: { fixed: true } } as const;

type ClientView = { explicitAuthFlows: string[]; idTokenValidity: number | null; tokenValidityUnits: { IdToken?: string } | null; allowedOAuthFlowsUserPoolClient: boolean; callbackUrls: string[]; writeAttributes: string[] };

function sameSet(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && expected.every((value) => actual.includes(value));
}

export default defineScenario({
  id: "SC-00",
  slug: "sc-00",
  title: "Smoke of the deploy",
  suites: ["smoke", "full"],
  steps: [
    {
      id: "1",
      title: "The landing, /signup, /login, /join and the legal pages answer 200, the root with its security headers",
      kind: "det",
      flows: ["FL-089", "FL-119"],
      after: "preset",
      async run(ctx) {
        const problems = await publicPagesProblems();
        ctx.check(problems.length === 0, problems.join("; "));
      },
    },
    {
      id: "2",
      title: "auth.probe: the three clients of the pool with their flows and attributes, the pool's attributesRequireVerificationBeforeUpdate = [email], and the JWKS",
      kind: "det",
      flows: ["FL-079"],
      after: "preset",
      async run(ctx) {
        const probe = (await ctx.qa("auth.probe", {})) as { clients: Record<"ConsoleWeb" | "GuestSignup" | "QaProbe", ClientView>; pool: { attributesRequireVerificationBeforeUpdate: string[] }; jwks: { status: number; keys: number } };
        const { ConsoleWeb: web, GuestSignup: signup, QaProbe: qa } = probe.clients;
        ctx.check(sameSet(web.explicitAuthFlows, ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]), `ConsoleWeb flows: ${web.explicitAuthFlows.join(", ")}`);
        ctx.check(web.idTokenValidity === 15 && web.tokenValidityUnits?.IdToken === "minutes", "ConsoleWeb id tokens last 15 minutes");
        ctx.check(!web.allowedOAuthFlowsUserPoolClient && web.callbackUrls.length === 0, "ConsoleWeb has no hosted UI");
        ctx.check(sameSet(web.writeAttributes, ["name"]), `ConsoleWeb writes ${web.writeAttributes.join(", ")}`);
        ctx.check(sameSet(signup.explicitAuthFlows, ["ALLOW_REFRESH_TOKEN_AUTH"]), `GuestSignup flows: ${signup.explicitAuthFlows.join(", ")}`);
        ctx.check(sameSet(signup.writeAttributes, ["email", "name", "locale"]), `GuestSignup writes ${signup.writeAttributes.join(", ")}`);
        ctx.check(qa.explicitAuthFlows.includes("ALLOW_ADMIN_USER_PASSWORD_AUTH") && qa.explicitAuthFlows.every((flow) => flow === "ALLOW_ADMIN_USER_PASSWORD_AUTH" || flow === "ALLOW_REFRESH_TOKEN_AUTH"), `QaProbe flows: ${qa.explicitAuthFlows.join(", ")}`);
        ctx.check(qa.idTokenValidity === 5 && qa.writeAttributes.length === 0, "QaProbe: 5-minute tokens, writes nothing");
        ctx.check(probe.jwks.status === 200 && probe.jwks.keys > 0, "the pool's JWKS is downloadable");
        ctx.check(sameSet(probe.pool.attributesRequireVerificationBeforeUpdate, ["email"]), `the pool verifies before updating: ${probe.pool.attributesRequireVerificationBeforeUpdate.join(", ") || "nothing"}`);
      },
    },
    {
      id: "3",
      title: "/api/health, probe.mocks (each mock with each role), world.create and kb.probe (§SEG-01 first)",
      kind: "det",
      flows: ["FL-019"],
      after: "preset",
      async run(ctx) {
        const health = await healthProblem();
        ctx.check(health === undefined, health ?? "");
        const mocks = (await ctx.qa("probe.mocks", {})) as { network: string; dispatch: string; worker: unknown };
        ctx.check(mocks.network === "OK" && mocks.dispatch === "OK", `mocks with the driver's role: network ${mocks.network}, dispatch ${mocks.dispatch}`);
        ctx.check(mocks.worker !== "UNAVAILABLE", "the worker's HEALTH_PROBE answered");
        const world = await createWorld(ctx, {
          startAtSim: at(DAY, "07:25"),
          operations: [
            { key: "a", model: "wo-24817", installer: "own", preset: { activeWorkOrderId: true } },
            { key: "c", model: "wo-24817", installer: "own", preset: { checklist: { ONU_ONLINE: { status: "PASSED" }, POWER_READING_PHOTO: { status: "PASSED" }, ONU_LABEL_PHOTO: { status: "PASSED" }, ROSETTE_PHOTO: { status: "PASSED" }, CUSTOMER_OK: { status: "PASSED" } }, ...ONE_DAY_ORDER, activeWorkOrderId: true } },
            { key: "p", model: "wo-24817", installer: "own", preset: { candidates: ["ph-meter-01"], activeWorkOrderId: true, ...ONE_DAY_ORDER } },
          ],
        });
        ctx.state.world = world;
        const kb = (await ctx.qa("kb.probe", { clockId: world.clockId, installerId: op(world, "a").installerId })) as { firstSectionId: string | null };
        ctx.check(kb.firstSectionId === "SEG-01", `the KB's first result is ${kb.firstSectionId ?? "nothing"}, not SEG-01`);
      },
    },
    {
      id: "4",
      title: "The real Scheduler: DAY_START at 07:30 fires by its schedule and the template goes out SENT",
      kind: "det",
      flows: ["FL-009"],
      after: "3",
      async run(ctx) {
        const world = stored<World>(ctx, "world");
        const a = op(world, "a");
        const unfrozen = (await ctx.qa("clock.unfreeze", { clockId: world.clockId, leadSec: 120 })) as { dueAtReal?: string };
        try {
          const snapshot = await ctx.eventually(
            "DAY_START by the Scheduler",
            async () => {
              const seen = await ctx.snapshot({ clockId: world.clockId, workOrderIds: [a.workOrderId], personIds: [a.installerId] });
              const timer = orderIn(seen, a.workOrderId).timers.find((entry) => entry.kind === "DAY_START");
              const sent = personIn(seen, a.installerId).messages.find((message) => message.kind === "DAY_START" && ["SENT", "DELIVERED", "READ"].includes(message.status));
              return timer?.firedBy === "SCHEDULER" && sent !== undefined ? seen : undefined;
            },
            WAITS.schedulerSec,
          );
          ensure(snapshot !== undefined, "no DAY_START");
          if (unfrozen.dueAtReal !== undefined) ctx.latency("schedulerLatenessMs", Math.max(0, ctx.now() - Date.parse(unfrozen.dueAtReal)));
        } finally {
          await ctx.qa("clock.freeze", { clockId: world.clockId });
        }
      },
    },
    {
      id: "5",
      title: "vn-01 → the real Transcribe (a transcript) → a full turn with a REPLY and no max_tokens",
      kind: "det",
      flows: ["FL-017"],
      after: "3",
      async run(ctx) {
        const world = stored<World>(ctx, "world");
        const a = op(world, "a");
        await voice(ctx, world, a.installerId, "vn-01");
        const snapshot = await settledOn(ctx, world, a.installerId, [a.workOrderId], [a.installerId], WAITS.voiceSec + WAITS.turnSec);
        const thread = personIn(snapshot, a.installerId).messages;
        const note = thread.find((message) => message.direction === "IN" && message.content === "VOICE");
        ctx.check((note?.transcript?.text ?? "").trim().length > 0, "the voice note has a transcript");
        ctx.check(agentReplies(thread).length > 0, "the turn ended with a REPLY");
        assertCleanOutbound(ctx, snapshot);
        ctx.inform("citations", agentReplies(thread).flatMap(citationsOf).join(",") || "none");
      },
    },
    {
      id: "6",
      title: "An email with an attachment to the SES simulator (the certificate of a closed order) reaches DELIVERY",
      kind: "det",
      flows: ["FL-048"],
      after: "3",
      async run(ctx) {
        const world = stored<World>(ctx, "world");
        const c = op(world, "c");
        await ctx.qa("tool.invoke", { clockId: world.clockId, tool: "close_installation", args: { outcome: "INSTALLED" }, installerId: c.installerId, workOrderId: c.workOrderId });
        const snapshot = await settledOn(ctx, world, c.installerId, [c.workOrderId]);
        const mail = orderIn(snapshot, c.workOrderId).emails.find((email) => email.kind === "CERTIFICATE_EMAIL" && email.attachment !== undefined);
        ensure(mail !== undefined, "no certificate email with its attachment");
        const outcome = (await ctx.qa("mail.outcome", { clockId: world.clockId, mailId: mail.mailId, until: "FINAL", timeoutSec: WAITS.emailSec })) as { events: Array<{ type: string }> };
        ctx.check(outcome.events.some((event) => event.type === "DELIVERY"), `the email ended in ${outcome.events.map((event) => event.type).join(", ")}, not DELIVERY`);
      },
    },
    {
      id: "7",
      title: "policyAudit of the smoke's world: 0 violations",
      kind: "det",
      flows: ["FL-077"],
      after: "6",
      async run(ctx) {
        const world = stored<World>(ctx, "world");
        const audit = (await ctx.qa("policyAudit.run", { clockId: world.clockId })) as { violations: number };
        ctx.check(audit.violations === 0, `${audit.violations} violation(s)`);
      },
    },
    {
      id: "8",
      title: "tool.invoke(validate_install_photo) with ph-meter-01: a record_verdict, valid output, no max_tokens (the verdict is a warn metric)",
      kind: "det",
      flows: ["FL-036"],
      after: "3",
      async run(ctx) {
        const world = stored<World>(ctx, "world");
        const p = op(world, "p");
        const candidateId = world.presets.find((preset) => preset.workOrderId === p.workOrderId)?.candidates[0];
        ensure(candidateId !== undefined, "the candidate of ph-meter-01 was not seeded");
        const answer = (await ctx.qa("tool.invoke", { clockId: world.clockId, tool: "validate_install_photo", args: { candidateId, item: "POWER_READING_PHOTO" }, installerId: p.installerId, workOrderId: p.workOrderId })) as { ok: boolean; verdict?: string; validationId?: string };
        ctx.check(answer.ok, "validate_install_photo answered a failure");
        const snapshot: QaSnapshot = await ctx.snapshot({ clockId: world.clockId, workOrderIds: [p.workOrderId] });
        const validation = orderIn(snapshot, p.workOrderId).validations.find((entry) => entry.validationId === answer.validationId);
        ensure(validation !== undefined, "the validation was not stored");
        ctx.check(validation.source === "MODEL", `the validation's source is ${validation.source}`);
        ctx.check(validation.modelVerdict !== undefined, "no valid record_verdict came back (no toolUse, or an output zod refused)");
        ctx.check(validation.stopReason !== "max_tokens", "the photo call stopped by max_tokens");
        ctx.inform("SmokePhotoVerdict", answer.verdict ?? "none");
        if (answer.verdict !== "PASS") ctx.warn(`ph-meter-01 validated ${answer.verdict ?? "nothing"} (SmokePhotoVerdict)`);
      },
    },
    {
      id: "9",
      title: "WAF from the runner: the sign-up without a token gets the challenge; its batch the challenge or the app's 400; waf.probe of both web ACLs",
      kind: "det",
      flows: ["FL-114"],
      after: "preset",
      async run(ctx) {
        const edge = await signupEdge();
        ctx.check(edge.problems.length === 0, edge.problems.join("; "));
        for (const warning of edge.warnings) ctx.warn(warning);
        const acls = (await ctx.qa("waf.probe", {})) as { edge?: { WebACL?: unknown }; auth?: { WebACL?: unknown }; poolAssociation?: { WebACL?: unknown } };
        ctx.check(acls.edge?.WebACL !== undefined && acls.auth?.WebACL !== undefined, "both web ACLs exist");
        ctx.check(acls.poolAssociation?.WebACL !== undefined, "the user pool has its web ACL");
      },
    },
    {
      id: "10",
      title: "Origin: the Bff's Function URL called directly answers 403 without a body to every variant",
      kind: "det",
      flows: ["FL-114"],
      after: "preset",
      async run(ctx) {
        const problems = await directOriginProblems();
        if (problems === undefined) throw new Blocked("the Bff's Function URL is unknown: pass --bff-url (from this app's SST state)");
        ctx.check(problems.length === 0, problems.join("; "));
        // `OriginRejected` and the counts of leads and counters need the stage's tables: `npm run qa:edge-probes` (§6.1).
        ctx.inform("countsBeforeAfter", "checked by qa:edge-probes with the operator's profile");
      },
    },
  ],
});
