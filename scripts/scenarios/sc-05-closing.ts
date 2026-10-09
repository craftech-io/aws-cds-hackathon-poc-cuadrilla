// SC-05 · closing and the certificate (docs/test-plan.md §4.5; FL-047 … FL-053, FL-090). Every order closed by
// a button carries the seeded offer (`CLOSE_INSTALLATION` with its real nonce) and a fixed ONU; the tap is an
// inbound of the installer, so its 24 h window is open and the certificate goes as a document. The order with
// the window closed (`w`, last inbound 25 h ago, no offer) is closed by `tool.invoke(close_installation)`
// with `caller QA` and no inbound: the certificate goes as the `acta_instalacion` template.
import { DAY, assertCleanOutbound, at, decided, orderIn, personIn, settledOn, tap, voice } from "./lib/assist";
import { type ScenarioContext, ensure } from "./lib/context";
import { WAITS } from "./lib/eventually";
import { agentReplies, citationProblem, forbiddenIn, outOf, refList, textOf } from "./lib/oracles";
import { defineScenario } from "./lib/steps";
import { type World, createWorld, op, stored } from "./lib/world";

const PASSED = { status: "PASSED" } as const;
const COMPLETE = { ONU_ONLINE: PASSED, POWER_READING_PHOTO: PASSED, ONU_LABEL_PHOTO: PASSED, ROSETTE_PHOTO: PASSED, CUSTOMER_OK: PASSED } as const;
const closable = { activeWorkOrderId: true, onu: { fixed: true }, checklist: COMPLETE, offer: { action: "CLOSE_INSTALLATION" } } as const;
const world = (ctx: ScenarioContext) => stored<World>(ctx, "world");

async function closeByButton(ctx: ScenarioContext, key: string) {
  const w = world(ctx);
  const target = op(w, key);
  await tap(ctx, w, target.installerId, "CLOSE_INSTALLATION");
  const snapshot = await settledOn(ctx, w, target.installerId, [target.workOrderId]);
  return { snapshot, order: orderIn(snapshot, target.workOrderId), person: personIn(snapshot, target.installerId), target };
}

/** The certificate email of an order to the customer, followed until its final SES event. */
async function customerMailOutcome(ctx: ScenarioContext, key: string): Promise<string[]> {
  const w = world(ctx);
  const target = op(w, key);
  const snapshot = await settledOn(ctx, w, target.installerId, [target.workOrderId]);
  const mail = orderIn(snapshot, target.workOrderId).emails.find((email) => email.kind === "CERTIFICATE_EMAIL" && email.toRole === "CUSTOMER");
  ensure(mail !== undefined, "no certificate email to the customer");
  const outcome = (await ctx.qa("mail.outcome", { clockId: w.clockId, mailId: mail.mailId, until: "FINAL", timeoutSec: WAITS.emailSec })) as { events: Array<{ type: string }> };
  return outcome.events.map((event) => event.type);
}

async function undelivered(ctx: ScenarioContext, key: string, expected: "BOUNCE" | "COMPLAINT") {
  const { order } = await closeByButton(ctx, key);
  ctx.check(order.order.status === "CLOSED", `the order is ${order.order.status}`);
  const events = await customerMailOutcome(ctx, key);
  ctx.check(events.includes(expected), `the email ended in ${events.join(", ")}`);
  const w = world(ctx);
  const target = op(w, key);
  const snapshot = await settledOn(ctx, w, target.installerId, [target.workOrderId]);
  ctx.exactly(snapshot, 1, "CERTIFICATE_UNDELIVERED cases", orderIn(snapshot, target.workOrderId).cases.filter((entry) => entry.reason === "CERTIFICATE_UNDELIVERED"));
}

export default defineScenario({
  id: "SC-05",
  slug: "sc-05",
  title: "Closing and the certificate",
  suites: ["full"],
  async setup(ctx) {
    ctx.state.world = await createWorld(ctx, {
      startAtSim: at(DAY, "15:20"),
      operations: [
        { key: "full", model: "wo-24817", installer: "own", preset: closable },
        { key: "noros", model: "wo-24817", installer: "own", preset: { ...closable, checklist: { ONU_ONLINE: PASSED, POWER_READING_PHOTO: PASSED, ONU_LABEL_PHOTO: PASSED, CUSTOMER_OK: PASSED } } },
        { key: "w", model: "wo-24817", installer: "own", preset: { activeWorkOrderId: true, onu: { fixed: true }, checklist: COMPLETE, lastInboundAtSim: "2026-10-12T14:20:00-06:00" } },
        { key: "bounce", model: "wo-24831", installer: "own", preset: closable },
        { key: "complaint", model: "wo-24832", installer: "own", preset: closable },
        { key: "absent", model: "wo-24822", installer: "own", preset: { activeWorkOrderId: true } },
        { key: "curp", model: "wo-24821", installer: "own", preset: closable },
      ],
    });
  },
  steps: [
    {
      id: "1",
      title: "Closing with the rosette pending",
      parts: [
        {
          part: "a",
          title: "\"Cerrar instalación\" → NOT_COMPLETE, no certificate, one closeNotComplete notice with refs.items = missing, no turn",
          kind: "det",
          flows: ["FL-050"],
          after: "preset",
          async run(ctx) {
            const { snapshot, order, person } = await closeByButton(ctx, "noros");
            ctx.none(snapshot, "certificates", order.certificate === undefined ? [] : [order.certificate]);
            ctx.check(order.order.status !== "CLOSED", "the order closed with the rosette pending");
            const notices = ctx.exactly(snapshot, 1, "closeNotComplete notices", outOf(person.messages, { kind: "SYSTEM_NOTICE" }).filter((message) => refList(message, "items").length > 0));
            ctx.check(refList(notices[0] ?? { refs: {} }, "items").includes("ROSETTE_PHOTO"), "the notice does not name the rosette");
            ctx.none(snapshot, "turns for the tap", order.turnNotes);
          },
        },
        {
          part: "b",
          title: "Same order, \"ya terminé, cierra la instalación\" in free text → the oracle of FL-050",
          kind: "agent",
          flows: ["FL-050"],
          after: "preset",
          async run(ctx) {
            const w = world(ctx);
            const target = op(w, "noros");
            await ctx.qa("wa.inbound", { clockId: w.clockId, identity: target.installerId, content: { type: "text", text: "Ya terminé, cierra la instalación" } });
            const snapshot = await settledOn(ctx, w, target.installerId, [target.workOrderId]);
            const order = orderIn(snapshot, target.workOrderId);
            ctx.none(snapshot, "certificates", order.certificate === undefined ? [] : [order.certificate]);
            ctx.check(order.order.status === "IN_PROGRESS" || order.order.status === "SCHEDULED", `the order is ${order.order.status}`);
            const reply = agentReplies(personIn(snapshot, target.installerId).messages).at(-1);
            ensure(reply !== undefined, "no REPLY");
            ctx.check(refList(reply, "items").includes("ROSETTE_PHOTO") || /roseta/i.test(reply.text ?? ""), "the reply does not say the rosette is missing");
            assertCleanOutbound(ctx, snapshot);
          },
        },
      ],
    },
    {
      id: "2",
      title: "\"Cerrar instalación\" with the checklist complete → the certificate with its sha256",
      kind: "det",
      flows: ["FL-047"],
      after: "preset",
      async run(ctx) {
        const { order } = await closeByButton(ctx, "full");
        ctx.check(order.order.status === "CLOSED", `the order is ${order.order.status}`);
        ctx.check(order.certificate?.sha256 !== undefined && order.certificate.s3Key !== undefined, "no certificate PDF with its sha256");
      },
    },
    {
      id: "3",
      title: "Two emails with DELIVERY (≤ 300 s) and the outbox",
      kind: "det",
      flows: ["FL-048", "FL-090"],
      after: "2",
      async run(ctx) {
        const w = world(ctx);
        const target = op(w, "full");
        const snapshot = await settledOn(ctx, w, target.installerId, [target.workOrderId]);
        const mails = orderIn(snapshot, target.workOrderId).emails.filter((email) => email.kind === "CERTIFICATE_EMAIL");
        ctx.check(mails.length === 2 && mails.every((mail) => mail.attachment !== undefined), `${mails.length} certificate email(s)`);
        for (const mail of mails) {
          const outcome = (await ctx.qa("mail.outcome", { clockId: w.clockId, mailId: mail.mailId, until: "FINAL", timeoutSec: WAITS.emailSec })) as { events: Array<{ type: string }> };
          ctx.check(outcome.events.some((event) => event.type === "DELIVERY"), `${mail.toRole}: ${outcome.events.map((event) => event.type).join(", ")}`);
        }
        const outbox = (await ctx.qa("console", { clockId: w.clockId, procedure: "outbox.list", input: {} })) as { items?: Array<{ mailId?: string }> } | Array<{ mailId?: string }>;
        const listed = Array.isArray(outbox) ? outbox : (outbox.items ?? []);
        ctx.check(mails.every((mail) => listed.some((item) => item.mailId === mail.mailId)), "the outbox does not list both emails");
      },
    },
    {
      id: "4",
      title: "The certificate to the installer over WhatsApp",
      parts: [
        {
          part: "a",
          title: "The certificate of step 2 (closed by the button) reaches the installer as a document (ALLOW CP-WA-24H)",
          kind: "det",
          flows: ["FL-049"],
          after: "2",
          async run(ctx) {
            const w = world(ctx);
            const target = op(w, "full");
            const snapshot = await settledOn(ctx, w, target.installerId, [target.workOrderId]);
            const documents = outOf(personIn(snapshot, target.installerId).messages, { kind: "CERTIFICATE" });
            ctx.check(documents.some((message) => message.content === "DOCUMENT" && message.policy?.decision === "ALLOW"), "no certificate sent as a document");
          },
        },
        {
          part: "b",
          title: "Order w: tool.invoke(close_installation) → CLOSED, and the certificate as the acta_instalacion template (DENY CP-WA-24H of the document)",
          kind: "det",
          flows: ["FL-049"],
          after: "preset",
          async run(ctx) {
            const w = world(ctx);
            const target = op(w, "w");
            await ctx.qa("tool.invoke", { clockId: w.clockId, tool: "close_installation", args: { outcome: "INSTALLED" }, installerId: target.installerId, workOrderId: target.workOrderId });
            const snapshot = await settledOn(ctx, w, target.installerId, [target.workOrderId]);
            const order = orderIn(snapshot, target.workOrderId);
            ctx.check(order.order.status === "CLOSED" && order.certificate !== undefined, "the order did not close with its certificate");
            const sent = outOf(personIn(snapshot, target.installerId).messages, { kind: "CERTIFICATE", templateName: "acta_instalacion" });
            ctx.check(sent.length === 1, `${sent.length} acta_instalacion template(s)`);
            ctx.check(decided(order.decisions, "DENY", "CP-WA-24H").length > 0, "no DENY CP-WA-24H of the document");
          },
        },
      ],
    },
    { id: "5", title: "Bounce → a CERTIFICATE_UNDELIVERED case", kind: "det", flows: ["FL-051"], after: "preset", run: (ctx) => undelivered(ctx, "bounce", "BOUNCE") },
    { id: "6", title: "Complaint → a CERTIFICATE_UNDELIVERED case", kind: "det", flows: ["FL-051"], after: "preset", run: (ctx) => undelivered(ctx, "complaint", "COMPLAINT") },
    {
      id: "7",
      title: "vn-11 → FAILED_VISIT without a certificate",
      kind: "agent",
      flows: ["FL-052"],
      after: "preset",
      async run(ctx) {
        const w = world(ctx);
        const target = op(w, "absent");
        await voice(ctx, w, target.installerId, "vn-11");
        let snapshot = await settledOn(ctx, w, target.installerId, [target.workOrderId], [target.installerId], WAITS.voiceSec + WAITS.turnSec);
        if (orderIn(snapshot, target.workOrderId).order.status !== "FAILED_VISIT") {
          // The alternative of §4.3: the agent asks to confirm and closes on the next turn.
          await ctx.qa("wa.inbound", { clockId: w.clockId, identity: target.installerId, content: { type: "text", text: "Sí, confirmo, nadie abre" } });
          snapshot = await settledOn(ctx, w, target.installerId, [target.workOrderId]);
          ctx.inform("alternative", "closed after confirming");
        }
        const order = orderIn(snapshot, target.workOrderId);
        ctx.check(order.order.status === "FAILED_VISIT", `the order is ${order.order.status}`);
        ctx.check(order.certificate === undefined, "a certificate for a failed visit");
        const cited = agentReplies(personIn(snapshot, target.installerId).messages).some((reply) => citationProblem(order, reply, ["COM-05"]) === undefined);
        ctx.check(cited, "no reply cites §COM-05");
      },
    },
    {
      id: "8",
      title: "The certificate without phone, email nor CURP; template parameters without personal data",
      kind: "det",
      flows: ["FL-053"],
      after: "preset",
      async run(ctx) {
        const { snapshot, order, person } = await closeByButton(ctx, "curp");
        ensure(order.certificate !== undefined, "no certificate");
        const content = JSON.stringify(order.certificate.content ?? {});
        ctx.check(forbiddenIn(content).filter((hit) => hit !== "promise").length === 0, `the certificate's content carries ${forbiddenIn(content).join(", ")}`);
        for (const message of outOf(person.messages).filter((entry) => entry.templateName !== undefined)) ctx.check(forbiddenIn(textOf(message)).length === 0, `${message.templateName} carries personal data`);
        assertCleanOutbound(ctx, snapshot);
        ctx.inform("pdfText", "the PDF's text is extracted in certificates/pdf.test.ts; the stored content is checked here");
      },
    },
  ],
});
