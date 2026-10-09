// Light load (docs/test-plan.md §7 "Carga liviana", on demand: `npm run scenarios -- --suite load`, with the
// CTO's OK: it spends about 60 turns): 20 QA installers of one world, 3 messages each, all of them at once
// (one installer's messages one after the other, the installers in parallel). Then no event of the world in
// the DLQ, every installer's messages stored once and in the order they were sent, and no inbound answered
// by more than one turn.
import { DAY, at, personIn, say } from "./lib/assist";
import type { ScenarioContext } from "./lib/context";
import { defineScenario } from "./lib/steps";
import { type World, createWorld, stored } from "./lib/world";

export const LOAD_INSTALLERS = 20;
export const LOAD_MESSAGES = ["Voy llegando a la orden", "Ya estoy en el domicilio", "Empiezo con la instalación"] as const;
const SETTLE_ROUNDS = 4;

const world = (ctx: ScenarioContext) => stored<World>(ctx, "world");

/** Problems of one installer's thread: each text once, in the order sent, and no more turns than inbounds. */
export function threadProblems(person: { readonly personId: string; readonly messages: ReadonlyArray<{ readonly direction: string; readonly text?: string; readonly messageId: string }>; readonly turnNotes: ReadonlyArray<{ readonly turnId: string; readonly trigger: string }> }, sent: readonly string[]): string[] {
  const problems: string[] = [];
  const inbound = person.messages.filter((message) => message.direction === "IN");
  const texts = inbound.map((message) => message.text ?? "");
  for (const text of sent) {
    const count = texts.filter((entry) => entry === text).length;
    if (count !== 1) problems.push(`${person.personId}: "${text}" stored ${count} time(s)`);
  }
  const order = texts.filter((text) => sent.includes(text));
  if (order.join("|") !== sent.join("|")) problems.push(`${person.personId}: stored out of order`);
  if (new Set(inbound.map((message) => message.messageId)).size !== inbound.length) problems.push(`${person.personId}: a repeated inbound id`);
  const turns = person.turnNotes.filter((note) => note.trigger === "INSTALLER_MESSAGE");
  if (new Set(turns.map((note) => note.turnId)).size !== turns.length) problems.push(`${person.personId}: a repeated turn`);
  if (turns.length > inbound.length) problems.push(`${person.personId}: ${turns.length} turns for ${inbound.length} inbound(s)`);
  return problems;
}

export default defineScenario({
  id: "LOAD",
  slug: "sc-99-load",
  title: "Light load: 20 installers, 3 messages each",
  suites: [],
  async setup(ctx) {
    ctx.state.world = await createWorld(ctx, {
      startAtSim: at(DAY, "09:00"),
      operations: Array.from({ length: LOAD_INSTALLERS }, (_, index) => ({ key: `i${index + 1}`, model: "wo-24817", installer: "own" as const, preset: { activeWorkOrderId: true } })),
    });
  },
  steps: [
    {
      id: "1",
      title: "60 messages at once → no DLQ, each installer's order kept, no duplicate turns",
      kind: "det",
      flows: ["FL-099"],
      after: "preset",
      async run(ctx) {
        const w = world(ctx);
        const started = ctx.now();
        await Promise.all(
          w.operations.map(async (operation) => {
            for (const text of LOAD_MESSAGES) await say(ctx, w, operation.installerId, text);
          }),
        );
        ctx.latency("sendAllMs", ctx.now() - started);
        let snapshot = undefined;
        for (let round = 0; round < SETTLE_ROUNDS && snapshot === undefined; round += 1) {
          try {
            snapshot = await ctx.settled({ clockId: w.clockId }, { clockId: w.clockId, personIds: w.operations.map((operation) => operation.installerId) });
          } catch (error) {
            if (round === SETTLE_ROUNDS - 1) throw error;
          }
        }
        ctx.latency("settledMs", ctx.now() - started);
        const dead = (await ctx.qa("dlq.find", { clockId: w.clockId })) as { found: unknown[] };
        ctx.check(dead.found.length === 0, `${dead.found.length} event(s) of the world in the DLQ`);
        const problems = w.operations.flatMap((operation) => (snapshot === undefined ? [] : threadProblems(personIn(snapshot, operation.installerId), LOAD_MESSAGES)));
        ctx.check(problems.length === 0, problems.slice(0, 10).join(" · "));
      },
    },
  ],
});
