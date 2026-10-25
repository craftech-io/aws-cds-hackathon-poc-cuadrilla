// SC-15 · memory (docs/test-plan.md §4.5; FL-027, FL-086): two label photos with glare by real turns build the
// installer's measured profile (`InstallerProfile.rejects.GLARE`), and the next photo request carries its tip
// (`refs.tipIds`); "Reiniciar demo" leaves the old actor with nothing and the new one empty; and no record of
// Memory keeps a customer's name or phone.
//
// Deviation from the plan's world: §4.5 names the `qa-min` template, whose two orders have installers of their
// own; step 2 needs order B of the SAME installer, so the world clones `wo-24817` and `wo-24818` for one
// installer. When step 1 does not leave GLARE ≥ 2 (the validator chose another reason), step 2 runs on the
// order of a world whose installer was seeded with the `profile {rejects: {GLARE: 2}}` preset, and says so.
import { DAY, at, orderIn, personIn, photo, say, settledOn } from "./lib/assist";
import { type ScenarioContext, ensure } from "./lib/context";
import { WAITS } from "./lib/eventually";
import { agentReplies, refList } from "./lib/oracles";
import { defineScenario } from "./lib/steps";
import { type World, createWorld, op, stored } from "./lib/world";

const SENTINEL = ["reflejo", "flash", "brillo", "glare"];
const named = (ctx: ScenarioContext, name: string) => stored<World>(ctx, name);

interface Inspection {
  readonly actorId: string;
  readonly events: number;
  readonly eventSensitive: readonly string[];
  readonly eventCustomerHits: number;
  readonly records: ReadonlyArray<{ readonly strategy: string; readonly sentinelHit: boolean; readonly sensitive: readonly string[]; readonly customerHits: number }>;
}

export default defineScenario({
  id: "SC-15",
  slug: "sc-15",
  title: "Memory",
  suites: ["full"],
  async setup(ctx) {
    const ready = { onu: { fixed: true }, checklist: { ONU_ONLINE: { status: "PASSED" } } } as const;
    ctx.state.world = await createWorld(ctx, {
      startAtSim: at(DAY, "09:30"),
      operations: [
        { key: "a", model: "wo-24817", installer: "own", preset: { ...ready, activeWorkOrderId: true } },
        { key: "b", model: "wo-24818", installer: "a", preset: ready },
      ],
    });
    ctx.state.tips = await createWorld(ctx, { startAtSim: at(DAY, "09:30"), operations: [{ key: "t", model: "wo-24818", installer: "own", preset: { ...ready, activeWorkOrderId: true, profile: { rejects: { GLARE: 2 } } } }] }, "tips");
    ctx.state.keep = await createWorld(ctx, { startAtSim: at(DAY, "09:30"), operations: [{ key: "k", model: "wo-24817", installer: "own", preset: { activeWorkOrderId: true } }] }, "keep");
  },
  steps: [
    {
      id: "1",
      title: "Order A: two photos with glare, each captioned with its item, by real turns → two REJECT and InstallerProfile.rejects.GLARE ≥ 2",
      kind: "agent",
      flows: ["FL-027"],
      after: "preset",
      async run(ctx) {
        const w = named(ctx, "world");
        const a = op(w, "a");
        const startedAt = new Date(ctx.now()).toISOString();
        for (const [photoId, item] of [["ph-label-06", "ONU_LABEL_PHOTO"], ["ph-rosette-08", "ROSETTE_PHOTO"]] as const) {
          await photo(ctx, w, a.installerId, photoId, item);
          await settledOn(ctx, w, a.installerId, [a.workOrderId], [a.installerId], WAITS.photoSec + WAITS.turnSec);
        }
        const snapshot = await settledOn(ctx, w, a.installerId, [a.workOrderId]);
        const rejects = orderIn(snapshot, a.workOrderId).validations.filter((validation) => validation.verdict !== "PASS");
        const glare = rejects.filter((validation) => validation.reasonCode === "GLARE").length;
        ctx.state.glare = glare;
        ctx.check(rejects.length >= 2, `${rejects.length} photo(s) not PASS`);
        if (glare < 2) ctx.inform("profile", `GLARE ${glare}: step 2 runs on the seeded profile`);
        try {
          await ctx.qa("memory.inspect", { installerId: a.installerId, waitForExtraction: { sentinel: { keywords: SENTINEL }, afterTs: startedAt, timeoutSec: WAITS.memoryExtractionSec } });
          ctx.inform("memoryTip", "extracted");
        } catch (error) {
          ctx.inform("memoryTip", `not extracted: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    },
    {
      id: "2",
      title: "Order B of the same installer: the photo request carries the profile's tip (oracle FL-027)",
      kind: "agent",
      flows: ["FL-027"],
      after: "preset",
      async run(ctx) {
        const glare = (ctx.state.glare as number | undefined) ?? 0;
        const w = glare >= 2 ? named(ctx, "world") : named(ctx, "tips");
        const target = glare >= 2 ? op(w, "b") : op(w, "t");
        if (glare < 2) ctx.inform("profile", "seeded GLARE 2 (the preset of the tips world)");
        await say(ctx, w, target.installerId, `Ya estoy en la orden ${target.workOrderId.slice(3)} y la ONU ya está en línea, ¿qué fotos te mando?`);
        const snapshot = await settledOn(ctx, w, target.installerId, [target.workOrderId]);
        const reply = agentReplies(personIn(snapshot, target.installerId).messages).at(-1);
        ensure(reply !== undefined, "no REPLY");
        const tipped = refList(reply, "tipIds").length > 0 || SENTINEL.some((word) => (reply.text ?? "").toLowerCase().includes(word));
        ctx.check(tipped, "the photo request carries no tip of the profile");
      },
    },
    {
      id: "3",
      title: "console.clock.reset (once) → the old actor with 0 events and 0 records (≤ 120 s), the new actor empty",
      kind: "det",
      flows: ["FL-086"],
      after: "preset",
      async run(ctx) {
        const w = named(ctx, "world");
        const a = op(w, "a");
        const before = (await ctx.snapshot({ clockId: w.clockId })).worldEpoch;
        await ctx.qa("console", { clockId: w.clockId, procedure: "clock.reset" });
        const old = await ctx.eventually(
          "the old actor purged",
          async () => {
            const inspected = (await ctx.qa("memory.inspect", { installerId: a.installerId, epoch: before })) as Inspection;
            return inspected.events === 0 && inspected.records.length === 0 ? inspected : undefined;
          },
          WAITS.memoryPurgeSec,
          10,
        );
        ctx.check(old.events === 0, "the old actor keeps events");
        const fresh = (await ctx.qa("memory.inspect", { installerId: a.installerId })) as Inspection;
        ctx.check(fresh.actorId !== old.actorId && fresh.events === 0 && fresh.records.length === 0, "the new actor is not empty");
      },
    },
    {
      id: "4",
      title: "Messages with the customer's name and phone: no record of the three namespaces keeps them (after a quiet namespace)",
      kind: "det",
      flows: ["FL-027"],
      after: "preset",
      async run(ctx) {
        const w = named(ctx, "keep");
        const k = op(w, "k");
        const startedAt = new Date(ctx.now()).toISOString();
        await say(ctx, w, k.installerId, "Ya estoy con la señora Lucía Treviño, me dio su teléfono 55 0300 4321 por si no abre");
        await settledOn(ctx, w, k.installerId, [k.workOrderId]);
        let inspected: Inspection;
        try {
          inspected = (await ctx.qa("memory.inspect", { installerId: k.installerId, waitForExtraction: { afterTs: startedAt, timeoutSec: WAITS.memoryExtractionSec, stableSec: 60, minQuietSec: 180 } })) as Inspection;
        } catch {
          inspected = (await ctx.qa("memory.inspect", { installerId: k.installerId })) as Inspection;
          ctx.warn("the extraction did not finish: the records read so far were checked");
        }
        const leaking = inspected.records.filter((record) => record.customerHits > 0 || record.sensitive.includes("PHONE"));
        ctx.check(leaking.length === 0, `${leaking.length} record(s) keep the customer's name or phone`);
      },
    },
  ],
});
