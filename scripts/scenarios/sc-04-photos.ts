// SC-04 · evidence photos (docs/test-plan.md §4.5; FL-035 … FL-046, FL-103). Two kinds of steps:
//
//   with a real turn (2, 15.a)    the photo enters as the installer's message with its item decided by
//                                 code (FL-046: the caption with the item's title in 2; in 15.a, the fixed
//                                 question with the pending items' buttons and no turn, then the tap) and
//                                 the agent validates it: the validation, the item and the reaction
//   by tool.invoke (3 … 11, 14)   `validate_install_photo` with `caller QA` over candidates the preset
//                                 registered, no turn nor inbound message: the class of the verdict, the
//                                 `reasonText` of `copy/`, the item never PASSED and no reaction (§4.3, row
//                                 "FL-036..FL-043 (SC-04/3..8, …)")
//
// The duplicates run in a world of their own (`sc04-dup`), like `EV-02`. Every seeded evidence of the main
// world uses seeding renders, so no photo of the set collides with it.
import type { PhotoValidation } from "../../packages/bff/src/domain/work-orders";
import { PHOTO_ITEM_BUTTONS } from "../../packages/bff/src/copy/buttons";
import { esMX } from "../../packages/bff/src/copy/es-MX";
import { candidateIdOf } from "../../packages/bff/src/evidence/candidate";
import type { QaSnapshot } from "../../packages/bff/src/qa-driver/snapshot";
import { DAY, assertCleanOutbound, at, isNotice, orderIn, personIn, photo, say, send, settledOn, tap } from "./lib/assist";
import { type ScenarioContext, ensure } from "./lib/context";
import { WAITS } from "./lib/eventually";
import { agentReplies, citationProblem, offersButton, outOf, refList } from "./lib/oracles";
import { defineScenario } from "./lib/steps";
import { type World, createWorld, op, presetOf, stored } from "./lib/world";

type Item = "POWER_READING_PHOTO" | "ONU_LABEL_PHOTO" | "ROSETTE_PHOTO";
const PASSED = { status: "PASSED" } as const;
const ready = { activeWorkOrderId: true, onu: { fixed: true }, checklist: { ONU_ONLINE: PASSED } } as const;
const main = (ctx: ScenarioContext) => stored<World>(ctx, "main");
const dup = (ctx: ScenarioContext) => stored<World>(ctx, "dup");

/** The message id of the preset's candidate for `photoId` on the order of `key`. */
function candidateOf(w: World, key: string, photoId: string, photoIds: readonly string[]): string {
  const candidates = presetOf(w, op(w, key).workOrderId)?.candidates ?? [];
  const id = candidates[photoIds.indexOf(photoId)];
  if (id === undefined) throw new RangeError(`no candidate of ${photoId} on ${key}`);
  return id;
}

const CANDIDATES: Readonly<Record<string, readonly string[]>> = {
  t1: ["ph-meter-07", "ph-meter-09", "ph-rosette-01"],
  t2: ["ph-label-04"],
  t3: ["ph-label-06"],
  t4: ["ph-label-08"],
  t5: ["ph-label-01", "ph-rosette-02"],
  t6: ["ph-label-09"],
  t7: ["ph-meter-05", "ph-meter-15"],
};

/** `tool.invoke(validate_install_photo)` and the §4.3 row of `tool.invoke`; returns the stored validation. */
async function invoked(ctx: ScenarioContext, w: World, key: string, photoId: string, item: Item, expectPass: boolean): Promise<PhotoValidation> {
  const target = op(w, key);
  const candidateId = candidateOf(w, key, photoId, CANDIDATES[key] ?? presetOf(w, target.workOrderId)?.candidates ?? []);
  const answer = (await ctx.qa("tool.invoke", { clockId: w.clockId, tool: "validate_install_photo", args: { candidateId, item }, installerId: target.installerId, workOrderId: target.workOrderId })) as { ok: boolean; validationId?: string; verdict?: string; reasonCode?: string; reasonText?: string };
  ensure(answer.ok && answer.validationId !== undefined, `validate_install_photo failed for ${photoId}`);
  const snapshot = await settledOn(ctx, w, target.installerId, [target.workOrderId]);
  const order = orderIn(snapshot, target.workOrderId);
  const validation = order.validations.find((entry) => entry.validationId === answer.validationId);
  ensure(validation !== undefined, "the validation was not stored");
  const passed = validation.verdict === "PASS";
  ctx.check(passed === expectPass, `${photoId}: ${validation.verdict}${validation.reasonCode === undefined ? "" : ` ${validation.reasonCode}`}, expected ${expectPass ? "PASS" : "not PASS"}`);
  const expectedText = validation.verdict === "UNSURE" ? esMX.photoInReview : validation.verdict === "REJECT" && validation.reasonCode !== undefined ? esMX.rejectReason(validation.reasonCode, item) : undefined;
  ctx.check(answer.reasonText === expectedText, `${photoId}: the reasonText is not the one of copy/ for ${validation.reasonCode ?? validation.verdict}`);
  const check = order.checklist.find((entry) => entry.item === item);
  ctx.check(check?.status !== "PASSED", `${item} became PASSED through tool.invoke`);
  if (validation.verdict === "REJECT") ctx.check(check?.status === "REJECTED", `${item} is ${check?.status ?? "missing"} after a REJECT`);
  if (validation.verdict === "UNSURE") ctx.check(check?.status === "IN_REVIEW", `${item} is ${check?.status ?? "missing"} after an UNSURE`);
  ctx.none(snapshot, "verdict reactions without a turn", outOf(personIn(snapshot, target.installerId).messages, { kind: "VERDICT_REACTION" }).filter((message) => message.refs?.validationId === answer.validationId));
  ctx.inform(`${photoId}.reason`, validation.reasonCode ?? validation.verdict);
  return validation;
}

export default defineScenario({
  id: "SC-04",
  slug: "sc-04",
  title: "Evidence photos",
  suites: ["full"],
  async setup(ctx) {
    const candidates = (key: string) => ({ ...ready, candidates: [...(CANDIDATES[key] ?? [])] });
    ctx.state.main = await createWorld(ctx, {
      startAtSim: at(DAY, "10:10"),
      operations: [
        { key: "p", model: "wo-24817", installer: "own", preset: { ...ready, lastInboundAtSim: at(DAY, "10:00") } },
        { key: "u", model: "wo-24817", installer: "own", preset: { activeWorkOrderId: true, lastInboundAtSim: at(DAY, "10:00") } },
        ...["t1", "t2", "t3", "t4", "t5", "t7"].map((key) => ({ key, model: "wo-24817", installer: "own" as const, preset: candidates(key) })),
        { key: "t6", model: "wo-24821", installer: "own", preset: candidates("t6") },
        {
          key: "c",
          model: "wo-24817",
          installer: "own",
          preset: { onu: { fixed: true }, activeWorkOrderId: true, checklist: { ONU_ONLINE: PASSED, POWER_READING_PHOTO: PASSED, ONU_LABEL_PHOTO: PASSED, ROSETTE_PHOTO: PASSED }, offer: [{ action: "CUSTOMER_OK" }, { action: "CLOSE_INSTALLATION" }] },
        },
      ],
    });
    ctx.state.dup = await createWorld(
      ctx,
      {
        startAtSim: at(DAY, "10:10"),
        operations: [
          { key: "da", model: "wo-24817", installer: "own", preset: { checklist: { POWER_READING_PHOTO: { status: "PASSED", photoId: "ph-meter-01" } } } },
          { key: "db", model: "wo-24817", installer: "own", preset: { activeWorkOrderId: true, candidates: ["ph-adv-04"] } },
          { key: "dc", model: "wo-24820", installer: "own", preset: { activeWorkOrderId: true, checklist: { ONU_LABEL_PHOTO: { status: "REJECTED", attempts: 2 } }, candidates: ["ph-meter-01"] } },
        ],
      },
      "dup",
    );
  },
  steps: [
    {
      id: "1",
      title: "\"¿Qué fotos me faltan?\" → the pending items and §EVI-01",
      kind: "agent",
      flows: ["FL-035"],
      after: "preset",
      async run(ctx) {
        const w = main(ctx);
        const p = op(w, "p");
        await say(ctx, w, p.installerId, "¿Qué fotos me faltan?");
        const snapshot = await settledOn(ctx, w, p.installerId, [p.workOrderId]);
        const order = orderIn(snapshot, p.workOrderId);
        const reply = agentReplies(personIn(snapshot, p.installerId).messages).at(-1);
        ensure(reply !== undefined, "no REPLY");
        const pending = order.checklist.filter((entry) => entry.status === "PENDING" || entry.status === "REJECTED").map((entry) => entry.item);
        const items = refList(reply, "items");
        const photos = ["POWER_READING_PHOTO", "ONU_LABEL_PHOTO", "ROSETTE_PHOTO"];
        ctx.check(photos.every((item) => items.includes(item)) && items.every((item) => pending.includes(item as never)), `refs.items ${items.join(", ")} for pending ${pending.join(", ")}`);
        const problem = citationProblem(order, reply, ["EVI-01"]);
        ctx.check(problem === undefined, problem ?? "");
        assertCleanOutbound(ctx, snapshot);
      },
    },
    {
      id: "2",
      title: "ph-meter-01 with the caption \"Lectura del medidor\" (the item by code) by a real turn → PASS, ✅ reaction, the item PASSED",
      kind: "agent",
      flows: ["FL-036", "FL-103"],
      after: "preset",
      async run(ctx) {
        const w = main(ctx);
        const p = op(w, "p");
        await photo(ctx, w, p.installerId, "ph-meter-01", "POWER_READING_PHOTO");
        const snapshot = await settledOn(ctx, w, p.installerId, [p.workOrderId], [p.installerId], WAITS.photoSec + WAITS.turnSec);
        const order = orderIn(snapshot, p.workOrderId);
        const validations = order.validations.filter((entry) => entry.item === "POWER_READING_PHOTO" && entry.source !== "SEED");
        const pass = validations.find((entry) => entry.verdict === "PASS");
        ensure(pass !== undefined, `ph-meter-01 validated ${validations.map((entry) => entry.verdict).join(", ") || "nothing"}`);
        ctx.check(order.checklist.find((entry) => entry.item === "POWER_READING_PHOTO")?.status === "PASSED", "POWER_READING_PHOTO is not PASSED");
        const reactions = outOf(personIn(snapshot, p.installerId).messages, { kind: "VERDICT_REACTION" });
        for (const validation of validations) {
          const own = reactions.filter((message) => message.refs?.validationId === validation.validationId);
          ctx.check(own.length === 1 && own[0]?.refs?.verdict === validation.verdict, `validation ${validation.verdict}: ${own.length} reaction(s)`);
        }
        const reply = agentReplies(personIn(snapshot, p.installerId).messages).at(-1);
        const reaction = reactions.find((message) => message.refs?.validationId === pass.validationId);
        ctx.check(reply === undefined || reaction === undefined || reaction.createdAt <= reply.createdAt, "the reaction came after the REPLY");
        assertCleanOutbound(ctx, snapshot);
      },
    },
    { id: "3", title: "ph-meter-07 → not PASS (OUT_OF_RANGE_LOW by code if the model read it)", kind: "agent", flows: ["FL-037"], after: "preset", run: async (ctx) => void (await invoked(ctx, main(ctx), "t1", "ph-meter-07", "POWER_READING_PHOTO", false)) },
    { id: "4", title: "ph-meter-09 → not PASS (OUT_OF_RANGE_HIGH)", kind: "agent", flows: ["FL-037"], after: "preset", run: async (ctx) => void (await invoked(ctx, main(ctx), "t1", "ph-meter-09", "POWER_READING_PHOTO", false)) },
    { id: "5", title: "ph-label-04 → not PASS, item REJECTED", kind: "agent", flows: ["FL-038"], after: "preset", run: async (ctx) => void (await invoked(ctx, main(ctx), "t2", "ph-label-04", "ONU_LABEL_PHOTO", false)) },
    { id: "6", title: "ph-label-06 → not PASS, item REJECTED", kind: "agent", flows: ["FL-038"], after: "preset", run: async (ctx) => void (await invoked(ctx, main(ctx), "t3", "ph-label-06", "ONU_LABEL_PHOTO", false)) },
    { id: "7", title: "ph-label-08 → not PASS, item REJECTED", kind: "agent", flows: ["FL-038"], after: "preset", run: async (ctx) => void (await invoked(ctx, main(ctx), "t4", "ph-label-08", "ONU_LABEL_PHOTO", false)) },
    { id: "8", title: "ph-rosette-01 as the meter → not PASS (WRONG_SUBJECT informed)", kind: "agent", flows: ["FL-039"], after: "preset", run: async (ctx) => void (await invoked(ctx, main(ctx), "t1", "ph-rosette-01", "POWER_READING_PHOTO", false)) },
    {
      id: "9",
      title: "The label and the rosette valid; the checklist completed by the seeded buttons",
      parts: [
        {
          part: "a",
          title: "ph-label-01 and ph-rosette-02 → PASS both, items not PASSED",
          kind: "agent",
          flows: ["FL-040"],
          after: "preset",
          async run(ctx) {
            await invoked(ctx, main(ctx), "t5", "ph-label-01", "ONU_LABEL_PHOTO", true);
            await invoked(ctx, main(ctx), "t5", "ph-rosette-02", "ROSETTE_PHOTO", true);
          },
        },
        {
          part: "b",
          title: "Order c: \"Cliente conforme\" → CUSTOMER_OK PASSED and the checklist complete; \"Cerrar instalación\" → CLOSED with the certificate",
          kind: "det",
          flows: ["FL-040"],
          after: "preset",
          async run(ctx) {
            const w = main(ctx);
            const c = op(w, "c");
            await tap(ctx, w, c.installerId, "CUSTOMER_OK");
            const done = await settledOn(ctx, w, c.installerId, [c.workOrderId]);
            ctx.check(orderIn(done, c.workOrderId).checklist.every((entry) => entry.status === "PASSED" || entry.status === "OVERRIDDEN"), "the checklist is not complete");
            await tap(ctx, w, c.installerId, "CLOSE_INSTALLATION");
            const closed = await settledOn(ctx, w, c.installerId, [c.workOrderId]);
            const order = orderIn(closed, c.workOrderId);
            ctx.check(order.order.status === "CLOSED", `the order is ${order.order.status}`);
            ctx.check(order.certificate?.sha256 !== undefined, "no certificate with its sha256");
          },
        },
      ],
    },
    { id: "10", title: "wo-24821 + ph-label-09 → not PASS (SERIAL_MISMATCH informed)", kind: "agent", flows: ["FL-041"], after: "preset", run: async (ctx) => void (await invoked(ctx, main(ctx), "t6", "ph-label-09", "ONU_LABEL_PHOTO", false)) },
    { id: "11", title: "ph-meter-05 → not PASS (READING_MISMATCH informed)", kind: "agent", flows: ["FL-041"], after: "preset", run: async (ctx) => void (await invoked(ctx, main(ctx), "t7", "ph-meter-05", "POWER_READING_PHOTO", false)) },
    {
      id: "12",
      title: "sc04-dup: ph-adv-04 in dup-b → REJECT DUPLICATE_EVIDENCE against dup-a's seeded evidence, the model never called",
      kind: "det",
      flows: ["FL-041"],
      after: "preset",
      expect: "DUPLICATE_EVIDENCE",
      async run(ctx) {
        const validation = await invoked(ctx, dup(ctx), "db", "ph-adv-04", "POWER_READING_PHOTO", false);
        ctx.check(validation.verdict === "REJECT" && validation.reasonCode === "DUPLICATE_EVIDENCE", `${validation.verdict} ${validation.reasonCode ?? ""}`);
        ctx.check(validation.modelVerdict === undefined && validation.usage === undefined, "the model was called for a duplicate");
      },
    },
    {
      id: "13",
      title: "sc04-dup: ph-meter-01 in dup-c as the label → the third rejection, DUPLICATE_EVIDENCE → exactly one PHOTO_ATTEMPTS case",
      kind: "det",
      flows: ["FL-042"],
      after: "preset",
      expect: "DUPLICATE_EVIDENCE",
      async run(ctx) {
        const w = dup(ctx);
        const dc = op(w, "dc");
        const validation = await invoked(ctx, w, "dc", "ph-meter-01", "ONU_LABEL_PHOTO", false);
        ctx.check(validation.reasonCode === "DUPLICATE_EVIDENCE" && validation.modelVerdict === undefined, "not a duplicate decided without the model");
        const snapshot = await settledOn(ctx, w, dc.installerId, [dc.workOrderId]);
        const order = orderIn(snapshot, dc.workOrderId);
        ctx.exactly(snapshot, 1, "PHOTO_ATTEMPTS cases", order.cases.filter((entry) => entry.reason === "PHOTO_ATTEMPTS"));
        ctx.check(order.checklist.find((entry) => entry.item === "ONU_LABEL_PHOTO")?.attempts === 3, "the label does not count three attempts");
      },
    },
    {
      id: "14",
      title: "ph-meter-15 → UNSURE or UNREADABLE, the item IN_REVIEW if UNSURE",
      kind: "agent",
      flows: ["FL-043"],
      after: "preset",
      async run(ctx) {
        const validation = await invoked(ctx, main(ctx), "t7", "ph-meter-15", "POWER_READING_PHOTO", false);
        ctx.check(validation.verdict === "UNSURE" || validation.reasonCode === "UNREADABLE", `${validation.verdict} ${validation.reasonCode ?? ""}`);
      },
    },
    {
      id: "15",
      title: "Images out of place",
      parts: [
        {
          part: "a",
          title: "A photo nobody asked for, without a caption, the three photo items pending → the fixed question with their buttons and no turn; the tap → that candidate validated for the item chosen",
          kind: "agent",
          flows: ["FL-046"],
          after: "preset",
          async run(ctx) {
            const w = main(ctx);
            const u = op(w, "u");
            const turnsOf = (snapshot: QaSnapshot) => personIn(snapshot, u.installerId).turnNotes.length;
            const turnsBefore = turnsOf(await ctx.snapshot({ clockId: w.clockId, personIds: [u.installerId] }));
            await photo(ctx, w, u.installerId, "ph-rosette-03");
            const asked = await settledOn(ctx, w, u.installerId, [u.workOrderId]);
            const order = orderIn(asked, u.workOrderId);
            ctx.none(asked, "validations before the item is chosen", order.validations.filter((entry) => entry.source !== "SEED"));
            ctx.exactly(asked, turnsBefore, "turns after the photo", personIn(asked, u.installerId).turnNotes);
            const pending = order.checklist.filter((entry) => entry.item in PHOTO_ITEM_BUTTONS && entry.status !== "PASSED" && entry.status !== "OVERRIDDEN").map((entry) => PHOTO_ITEM_BUTTONS[entry.item as Item].es);
            const questions = personIn(asked, u.installerId).messages.filter((message) => message.direction === "OUT" && message.kind === "SYSTEM_NOTICE" && isNotice(message, "itemChoicePrompt"));
            ctx.exactly(asked, 1, "itemChoicePrompt notices", questions);
            const titles = ((questions[0]?.interactive as { buttons?: Array<{ title?: unknown }> } | undefined)?.buttons ?? []).map((button) => String(button.title));
            ctx.check(titles.length === 3 && [...titles].sort().join() === [...pending].sort().join(), `the question offers ${titles.join(", ") || "no button"} for pending ${pending.join(", ")}`);
            const sent = personIn(asked, u.installerId).messages.filter((message) => message.direction === "IN" && message.media?.kind === "IMAGE").at(-1);
            ensure(sent !== undefined, "the photo is not in the thread");
            await tap(ctx, w, u.installerId, "CHOOSE_ITEM", { title: PHOTO_ITEM_BUTTONS.ROSETTE_PHOTO.es });
            const snapshot = await settledOn(ctx, w, u.installerId, [u.workOrderId], [u.installerId], WAITS.photoSec + WAITS.turnSec);
            const validations = orderIn(snapshot, u.workOrderId).validations.filter((entry) => entry.source !== "SEED");
            ctx.check(validations.length === 1 && validations[0]?.item === "ROSETTE_PHOTO" && validations[0].candidateId === candidateIdOf(sent.messageId), `after the tap: ${validations.map((entry) => `${entry.item} ${entry.candidateId ?? "?"}`).join(", ") || "no validation"}`);
            ctx.check(turnsOf(snapshot) > turnsBefore, "the tap ran no turn");
            const person = personIn(snapshot, u.installerId);
            ctx.check(person.messages.filter((message) => isNotice(message, "itemChoicePrompt")).length === 1, "the item was asked again");
            ctx.check(!agentReplies(person.messages).some((message) => offersButton(message, "CHOOSE_ITEM")), "a REPLY asks the item again");
            assertCleanOutbound(ctx, snapshot);
          },
        },
        {
          part: "b",
          title: "An image of 4,5 MB (a notice) and a sticker (a notice), no turn",
          kind: "det",
          flows: ["FL-046"],
          after: "preset",
          async run(ctx) {
            const w = main(ctx);
            const u = op(w, "u");
            await settledOn(ctx, w, u.installerId, [u.workOrderId]);
            const before = await ctx.snapshot({ clockId: w.clockId, personIds: [u.installerId] });
            const turnsBefore = personIn(before, u.installerId).turnNotes.length;
            await send(ctx, w, u.installerId, { type: "oversizeImage", bytes: 4_500_000 });
            await send(ctx, w, u.installerId, { type: "other", kind: "sticker" });
            const snapshot = await settledOn(ctx, w, u.installerId, [u.workOrderId]);
            const person = personIn(snapshot, u.installerId);
            ctx.check(person.messages.some((message) => isNotice(message, "imageTooLarge")), "no imageTooLarge notice");
            ctx.check(person.messages.some((message) => isNotice(message, "unsupportedMedia")), "no notice for the sticker");
            ctx.exactly(snapshot, turnsBefore, "turns after the two images", person.turnNotes);
          },
        },
      ],
    },
  ],
});
