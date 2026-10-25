// SC-17 · WhatsApp live (docs/test-plan.md §4.5; FL-091, FL-092, FL-095, FL-082, FL-101, FL-072): the real
// transport with a team phone. While `live` is not one of the stage's transports (it is enabled by configuration, P-01)
// every step is `SKIPPED_LIVE_P01`. With the live transport it needs the person holding the team phone (`setLiveOperator`, the
// runner's `--live-operator`): each step that needs the phone asks for one action on it and waits for its
// effect in the world; without that person the scenario is BLOCKED, never green.
//
// Deviation from §4.5's world: the `QaDriver` does not reach the live world (its guard fences `qa-*` worlds),
// so the team phone is bound by code (FL-101) to a `qa-*` world of this scenario that clones `wo-24817`; the
// real transport is the same one the live world uses. QA worlds are built from operations, not from the
// `guest` template, so 9.a binds the phone to that world. `pricing.category` is not in the stored statuses
// (the snapshot reads messages, not their events): step 6 checks the statuses and reports where the category
// is read (the `WhatsAppTemplateCategory` metric of the channel's log, which counts only non-utility ones).
import { PHOTO_ITEM_BUTTONS } from "../../packages/bff/src/copy/buttons";
import { DAY, at, decided, orderIn, personIn, say, settledOn, tap, withAction } from "./lib/assist";
import { CREW_N3, caseOn } from "./lib/cases";
import { Blocked, type ScenarioContext, ensure } from "./lib/context";
import { WAITS } from "./lib/eventually";
import { agentReplies, citationProblem, containsWords, outOf } from "./lib/oracles";
import { type Unit, defineScenario, dependentsOf, unitsOf } from "./lib/steps";
import { type World, createWorld, op, registerWorld, staff, stored } from "./lib/world";
import sc18 from "./sc-18-guest-tour";
import { GUEST_TEST_CLOCK_ID } from "@cuadrilla/shared";

/** The person holding the team phone, as the runner asks them (stdin) for one action at a time. */
export interface LiveOperator {
  /** Shows what to do on the team phone; resolves once they did it. */
  prompt(message: string): Promise<void>;
  /** What the photo of step 4 shows: a label that must `PASS`, or one that must not. */
  readonly photoClass: "PASS" | "NOT_PASS";
}

let operator: LiveOperator | undefined;

export function setLiveOperator(value: LiveOperator | undefined): void {
  operator = value;
}

const HUMAN_SEC = 600;
const VOICE_SCRIPT = "Ya conecté la ONU pero no prende la luz PON";
const VOICE_WORDS = ["onu", "luz", "pon"];
const PASSED = { status: "PASSED" } as const;
const COMPLETE = { ONU_ONLINE: PASSED, POWER_READING_PHOTO: PASSED, ONU_LABEL_PHOTO: PASSED, ROSETTE_PHOTO: PASSED, CUSTOMER_OK: PASSED } as const;
const world = (ctx: ScenarioContext) => stored<World>(ctx, "world");

function phone(): LiveOperator {
  if (operator === undefined) throw new Blocked("SC-17 needs the person holding the team phone (--live-operator)");
  return operator;
}

/** Asks for one action on the team phone and waits for the inbound it produces in the world. */
async function fromPhone(ctx: ScenarioContext, ask: string, matches: (message: ReturnType<typeof personIn>["messages"][number]) => boolean) {
  const w = world(ctx);
  const a = op(w, "a");
  const since = new Date(ctx.now()).toISOString();
  await phone().prompt(ask);
  return ctx.eventually(
    `the team phone's message (${ask})`,
    async () => {
      const snapshot = await ctx.snapshot({ clockId: w.clockId, workOrderIds: [a.workOrderId], personIds: [a.installerId] });
      return personIn(snapshot, a.installerId).messages.find((message) => message.direction === "IN" && message.transport === "live" && (message.sentAtReal ?? "") >= since && matches(message));
    },
    HUMAN_SEC,
    5,
  );
}

const sent = (status: string) => status === "DELIVERED" || status === "READ";

/** The SC-18 tour (its setup and every unit) with the stage's live transport on; each unit scored alone. */
async function tour(ctx: ScenarioContext): Promise<Map<string, string | undefined>> {
  const outcomes = new Map<string, string | undefined>();
  registerWorld(ctx.state, GUEST_TEST_CLOCK_ID);
  await sc18.setup?.(ctx);
  const units = unitsOf(sc18);
  const down = new Set<string>();
  for (const unit of units) {
    if (down.has(unit.id)) {
      outcomes.set(unit.id, `skipped: depends on '${unit.after}'`);
      continue;
    }
    try {
      await unit.run(ctx);
      outcomes.set(unit.id, undefined);
    } catch (error) {
      outcomes.set(unit.id, error instanceof Error ? error.message : String(error));
      for (const id of dependentsOf(units, unit.id)) down.add(id);
    }
  }
  ctx.state.tour = outcomes;
  return outcomes;
}

function failuresOf(outcomes: Map<string, string | undefined>, units: readonly Unit[]): string[] {
  return units.flatMap((unit) => {
    const outcome = outcomes.get(unit.id);
    return outcome === undefined ? [] : [`SC-18/${unit.id}: ${outcome}`];
  });
}

export default defineScenario({
  id: "SC-17",
  slug: "sc-17",
  title: "WhatsApp live",
  suites: ["full"],
  lane: "guest-test",
  async pending(ctx) {
    ctx.state.world = await createWorld(ctx, {
      startAtSim: at(DAY, "07:20"),
      settings: { demoMode: false },
      operations: [
        { key: "a", model: "wo-24817", installer: "own", preset: { activeWorkOrderId: true } },
        { key: "c", model: "wo-24818", installer: "a", preset: { onu: { fixed: true }, checklist: COMPLETE } },
      ],
    });
    const identities = (await ctx.qa("console", { clockId: world(ctx).clockId, procedure: "simulator.identities" })) as { liveTransport: boolean };
    return identities.liveTransport ? undefined : "live is not a WhatsApp transport of the stage (enabled by configuration, P-01)";
  },
  async setup(ctx) {
    const w = world(ctx);
    const a = op(w, "a");
    const code = (await ctx.qa("console", { clockId: w.clockId, procedure: "simulator.joinCode", input: { personId: a.installerId } })) as { message: string };
    await phone().prompt(`From the team phone, send "${code.message}" to the stage's WhatsApp number`);
    await ctx.eventually("the team phone bound to the world", async () => withAction((await ctx.snapshot({ clockId: w.clockId })).decisions, "PHONE_LEASE_CREATED").length > 0, HUMAN_SEC, 5);
  },
  steps: [
    {
      id: "1",
      title: "ordenes_del_dia delivered to the team phone",
      kind: "det",
      flows: ["FL-092"],
      after: "preset",
      async run(ctx) {
        const w = world(ctx);
        const a = op(w, "a");
        await ctx.qa("clock.fireDayStart", { personId: a.installerId });
        const template = await ctx.eventually(
          "ordenes_del_dia DELIVERED",
          async () => {
            const snapshot = await ctx.snapshot({ clockId: w.clockId, personIds: [a.installerId] });
            return outOf(personIn(snapshot, a.installerId).messages, { templateName: "ordenes_del_dia" }).find((message) => message.transport === "live" && sent(message.status));
          },
          WAITS.settleSec,
          5,
        );
        ctx.check(template.providerMessageId !== undefined && !template.providerMessageId.startsWith("wamid.SIM"), "the template has no wamid of Meta");
      },
    },
    {
      id: "2",
      title: "A button tapped on the team phone",
      kind: "det",
      flows: ["FL-091"],
      after: "1",
      async run(ctx) {
        const tapped = await fromPhone(ctx, 'Tap a button of the "ordenes_del_dia" message on the team phone', (message) => message.buttonAction !== undefined);
        ctx.inform("button", tapped.buttonAction ?? "none");
      },
    },
    {
      id: "3",
      title: "A real voice note: the media by the AWS id, the transcript with the script's words (≥ 0.55) and a reply citing DIAG-02",
      kind: "agent",
      flows: ["FL-091"],
      after: "preset",
      async run(ctx) {
        const w = world(ctx);
        const a = op(w, "a");
        const note = await fromPhone(ctx, `Record and send a voice note saying: "${VOICE_SCRIPT}"`, (message) => message.media?.kind === "AUDIO");
        const snapshot = await settledOn(ctx, w, a.installerId, [a.workOrderId], [a.installerId], WAITS.voiceSec + WAITS.turnSec);
        const stored = personIn(snapshot, a.installerId).messages.find((message) => message.messageId === note.messageId);
        ensure(stored?.transcript !== undefined, "the voice note has no transcript");
        ctx.check(containsWords(stored.transcript.text, VOICE_WORDS) && stored.transcript.confidence >= 0.55, `transcript confidence ${stored.transcript.confidence}`);
        ctx.check(stored.media?.s3Key !== undefined, "the media was not downloaded");
        const reply = agentReplies(personIn(snapshot, a.installerId).messages).find((message) => message.sentAtSim >= note.sentAtSim);
        ensure(reply !== undefined, "no REPLY to the voice note");
        const problem = citationProblem(orderIn(snapshot, a.workOrderId), reply, ["DIAG-02"]);
        ctx.check(problem === undefined, problem ?? "");
      },
    },
    {
      id: "4",
      title: "A real photo: downloaded to S3, a PhotoValidation of the declared class and one coherent reaction",
      kind: "agent",
      flows: ["FL-091"],
      after: "preset",
      async run(ctx) {
        const w = world(ctx);
        const a = op(w, "a");
        const expected = phone().photoClass;
        const label = expected === "PASS" ? "a sharp photo of the ONU's label" : "a photo of the ONU's label with glare";
        const shot = await fromPhone(ctx, `Send ${label} with the caption "${PHOTO_ITEM_BUTTONS.ONU_LABEL_PHOTO.es}"`, (message) => message.media?.kind === "IMAGE");
        const snapshot = await settledOn(ctx, w, a.installerId, [a.workOrderId], [a.installerId], WAITS.photoSec + WAITS.turnSec);
        const validation = orderIn(snapshot, a.workOrderId).validations.find((entry) => entry.source !== "SEED" && JSON.stringify(entry).includes(shot.messageId));
        ensure(validation !== undefined, "no PhotoValidation of the photo");
        ctx.check(expected === "PASS" ? validation.verdict === "PASS" : validation.verdict !== "PASS", `the photo is ${validation.verdict}`);
        const reactions = outOf(personIn(snapshot, a.installerId).messages, { kind: "VERDICT_REACTION" }).filter((message) => message.refs?.validationId === validation.validationId);
        ctx.check(reactions.length === 1 && reactions[0]?.refs?.verdict === validation.verdict, `${reactions.length} reaction(s)`);
      },
    },
    {
      id: "5",
      title: "The certificate as a document (PostWhatsAppMessageMedia)",
      kind: "det",
      flows: ["FL-092"],
      after: "preset",
      async run(ctx) {
        const w = world(ctx);
        const c = op(w, "c");
        await ctx.qa("tool.invoke", { clockId: w.clockId, tool: "close_installation", args: { outcome: "INSTALLED" }, installerId: c.installerId, workOrderId: c.workOrderId });
        const snapshot = await settledOn(ctx, w, c.installerId, [c.workOrderId]);
        ctx.check(orderIn(snapshot, c.workOrderId).certificate !== undefined, "no certificate");
        const document = outOf(personIn(snapshot, c.installerId).messages, { kind: "CERTIFICATE" }).find((message) => message.media?.kind === "DOCUMENT" && message.transport === "live");
        ensure(document !== undefined, "the certificate did not go as a live document");
        ctx.check(document.providerMessageId !== undefined && !document.providerMessageId.startsWith("wamid.SIM"), "the document has no wamid of Meta");
      },
    },
    {
      id: "6",
      title: "Statuses of the live messages and the utility category of the templates",
      kind: "det",
      flows: ["FL-092"],
      after: "preset",
      async run(ctx) {
        const w = world(ctx);
        const a = op(w, "a");
        const live = await ctx.eventually(
          "every live message DELIVERED or READ",
          async () => {
            const out = personIn(await ctx.snapshot({ clockId: w.clockId, personIds: [a.installerId] }), a.installerId).messages.filter((message) => message.direction === "OUT" && message.transport === "live");
            return out.length > 0 && out.every((message) => sent(message.status) || message.status === "DENIED" || message.status === "DEFERRED") ? out : undefined;
          },
          WAITS.settleSec,
          10,
        );
        ctx.check(live.every((message) => message.status !== "FAILED"), "a live message FAILED");
        ctx.inform("pricingCategory", "read in the channel's log: WhatsAppTemplateCategory counts only non-utility templates");
      },
    },
    {
      id: "7",
      title: "Own WABA: during the live test nothing foreign arrives besides the runner's qa-foreign events",
      kind: "det",
      flows: ["FL-095"],
      after: "preset",
      async run(ctx) {
        const w = world(ctx);
        const published = (await ctx.qa("wa.publishForeign", {})) as { eventId: string };
        await ctx.qa("probe.foreign", { eventId: published.eventId, timeoutSec: 60 });
        const snapshot = await ctx.settled({ clockId: w.clockId }, { clockId: w.clockId, personIds: w.operations.map((entry) => entry.installerId) });
        const since = new Date(ctx.now() - 120_000).toISOString();
        ctx.none(snapshot, "inbound messages without the live transport", snapshot.people.flatMap((person) => person.messages).filter((message) => message.direction === "IN" && (message.sentAtReal ?? "") >= since && message.transport !== "live" && message.simulated === false));
        ctx.inform("ForeignPhoneNumberEvents", "secondary check: only the runner's qa-foreign events in the channel's log");
      },
    },
    {
      id: "8",
      title: "With live in the transports, the simulator still works",
      parts: [
        {
          part: "a",
          title: "The det steps and parts of the SC-18 tour over a simulated guest world pass the same",
          kind: "det",
          flows: ["FL-082"],
          after: "preset",
          async run(ctx) {
            const outcomes = await tour(ctx);
            const failures = failuresOf(outcomes, unitsOf(sc18).filter((unit) => unit.kind === "det"));
            ctx.check(failures.length === 0, failures.join(" · "));
          },
        },
        {
          part: "b",
          title: "The agent steps and parts of the same tour meet the FL-082 row",
          kind: "agent",
          flows: ["FL-082"],
          after: "preset",
          oracleFlow: "FL-082",
          async run(ctx) {
            const outcomes = (ctx.state.tour as Map<string, string | undefined> | undefined) ?? (await tour(ctx));
            const failures = failuresOf(outcomes, unitsOf(sc18).filter((unit) => unit.kind === "agent"));
            ctx.check(failures.length === 0, failures.join(" · "));
          },
        },
      ],
    },
    {
      id: "9",
      title: "A team phone bound by code",
      parts: [
        {
          part: "a",
          title: "Bound by code to a qa-* world → its messages routed there; a second binding in another world → LEASE_CONFLICT",
          kind: "det",
          flows: ["FL-101"],
          after: "preset",
          async run(ctx) {
            const w = world(ctx);
            const routed = (await ctx.snapshot({ clockId: w.clockId })).people.flatMap((person) => person.messages).filter((message) => message.direction === "IN" && message.transport === "live");
            ctx.check(routed.length > 0, "no message of the team phone in its world");
            const other = await createWorld(ctx, { startAtSim: at(DAY, "07:20"), operations: [{ key: "o", model: "wo-24819", installer: "own" }] }, "other");
            const code = (await ctx.qa("console", { clockId: other.clockId, procedure: "simulator.joinCode", input: { personId: op(other, "o").installerId } })) as { message: string };
            await phone().prompt(`From the same team phone, send "${code.message}"`);
            const conflict = await ctx.eventually(
              "the second binding refused",
              async () => decided((await ctx.snapshot({ clockId: w.clockId })).decisions, "DENY", undefined, "PHONE_LEASE").find((entry) => entry.reason === "LEASE_CONFLICT"),
              HUMAN_SEC,
              5,
            );
            ctx.check(conflict.reason === "LEASE_CONFLICT", "no LEASE_CONFLICT");
            ctx.check(withAction((await ctx.snapshot({ clockId: other.clockId })).decisions, "PHONE_LEASE_CREATED").length === 0, "the phone was bound to the second world");
          },
        },
        {
          part: "b",
          // The QaDriver never writes `PHONELEASE#` (IAM denies it, infra/qa-driver-fence.ts), so a closed real
          // window of a bound phone is proven locally (U policy/window.test.ts, LF onboarding.flow.test.ts);
          // here, the open one with the world's clock paused: the policy of the bound phone runs on real time.
          title: "Within the real window, world clock paused: the supervisor's text → CP-WA-24H with the real clock ALLOW, the relay to the phone on the live transport, quiet hours NOT_APPLICABLE_LEASE",
          kind: "det",
          flows: ["FL-072", "FL-101"],
          after: "9.a",
          async run(ctx) {
            const w = world(ctx);
            const a = op(w, "a");
            const supervisor = staff(w, CREW_N3.primary);
            await ctx.qa("case.open", { workOrderId: a.workOrderId, reason: "INSTALLER_ASKED" });
            const opened = await caseOn(ctx, w, "a", "INSTALLER_ASKED");
            await tap(ctx, w, supervisor, "TAKE_CASE", { objectId: opened.caseId });
            await settledOn(ctx, w, a.installerId, [a.workOrderId], [a.installerId, supervisor]);
            await phone().prompt('From the team phone, send "Sigo en la orden"');
            await ctx.eventually("the team phone's message in its world", async () => personIn(await ctx.snapshot({ clockId: w.clockId }), a.installerId).messages.find((message) => message.direction === "IN" && message.transport === "live" && message.text === "Sigo en la orden"), HUMAN_SEC, 5);
            await say(ctx, w, supervisor, "Revisa el conector del poste, ahí está la falla");
            const snapshot = await settledOn(ctx, w, a.installerId, [a.workOrderId], [a.installerId, supervisor]);
            const allowed = decided(orderIn(snapshot, a.workOrderId).decisions, "ALLOW").filter((entry) => entry.evaluated.some((rule) => rule.ruleId === "CP-WA-24H" && rule.clock === "REAL" && rule.result === "PASS"));
            ctx.check(allowed.length > 0, "no ALLOW with CP-WA-24H on the real clock");
            const quiet = allowed.flatMap((entry) => entry.evaluated).filter((rule) => rule.ruleId === "CP-QUIET-HOURS");
            ctx.check(quiet.some((rule) => rule.result === "NOT_APPLICABLE_LEASE"), "CP-QUIET-HOURS was not NOT_APPLICABLE_LEASE");
            const relayed = outOf(personIn(snapshot, a.installerId).messages, { kind: "RELAY" }).filter((message) => message.transport === "live");
            ctx.check(relayed.length >= 1, "no relay of the supervisor to the team phone");
          },
        },
      ],
    },
  ],
});
