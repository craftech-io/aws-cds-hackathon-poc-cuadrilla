// Presets per operation of `world.create` and the scenes of "Saltar a escena" (docs/tool-catalog.md,
// docs/seed-spec.md §10.1, docs/test-plan.md §3): seeding renders that never collide with the set,
// explicit set photos only when asked, the case through the real ladder, and the agent's buttons with
// real nonces that a tap resolves like any other.
import { describe, expect, it } from "vitest";
import { GUEST_TEST_CLOCK_ID, GUEST_TEST_ISP_ID, ToolError, type WaButtonAction } from "@cuadrilla/shared";
import { type ButtonActionEvent, runButtonAction } from "../channels/whatsapp/button-actions";
import { INSTALLER_BUTTONS } from "../channels/whatsapp/keywords";
import { resolveNonce } from "../channels/whatsapp/nonces";
import type { WorkOrderActions } from "../channels/whatsapp/ports";
import type { CaseDeps } from "../cases/ports";
import { candidateIdOf } from "../evidence/candidate";
import { fakeNetwork, memoryTimers, policyOutbound, type World } from "../cases/testing";
import { createLogger } from "../lib/log";
import { factoryDepsOf } from "./deps";
import { buildWorld } from "./factory";
import { SEED_RENDERS_PER_ASPECT } from "./photo-catalog";
import { casePresetEffects } from "./preset-effects";
import { offerText } from "./presets";
import { jumpToScene } from "./rebuild";
import { scenesOf } from "./scenes";
import { NONCE_KEY, PHOTO_INDEX, type WorldsHarness, allRows, worldsHarness } from "./testing";
import { createWorld } from "./worlds";
import type { QaOperation } from "./templates";

const RUN = "qa-31-sc-04";

async function qaWorld(harness: WorldsHarness, operations: readonly QaOperation[], clockId = RUN) {
  const created = await createWorld(harness.deps, { clockId, operations });
  if (created.kind !== "QA") throw new Error("expected a QA world");
  return created.world;
}

function evidenceOf(harness: WorldsHarness, clockId: string): Array<Record<string, unknown>> {
  return allRows(harness)
    .filter(({ table, row }) => table === "WorkOrders" && row.entity === "Evidence" && row.clockId === clockId)
    .map(({ row }) => row);
}

/** Case presets through the real ladder, with the outbound fake that runs the real contact policy. */
function withCases(harness: WorldsHarness): WorldsHarness {
  const world = harness as unknown as World;
  const caseDeps: CaseDeps = {
    connector: harness.connector,
    outbound: policyOutbound(world),
    timers: memoryTimers(world),
    turns: { enqueueCaseClosed: async () => undefined },
    network: fakeNetwork(),
    realClock: { now: async () => harness.now() },
    logger: createLogger({ sink: () => undefined }),
  };
  return Object.assign(harness, { deps: { ...harness.deps, effects: casePresetEffects(caseDeps) } });
}

describe("preset checklist", () => {
  it("seeds each evidence with a seeding render of its own, never with bytes of the set", async () => {
    const harness = worldsHarness();
    const passed = { status: "PASSED" } as const;
    const checklist = { POWER_READING_PHOTO: passed, ONU_LABEL_PHOTO: passed, ROSETTE_PHOTO: passed, ONU_ONLINE: passed };
    await qaWorld(harness, [
      { key: "a", model: "wo-24817", installer: "own", preset: { checklist } },
      { key: "b", model: "wo-24820", installer: "own", preset: { checklist: { ...checklist, POWER_READING_PHOTO: { status: "REJECTED", attempts: 2 } } } },
    ]);
    const evidence = evidenceOf(harness, RUN);
    expect(evidence).toHaveLength(7);
    const hashes = evidence.map((row) => String(row.sha256));
    expect(new Set(hashes).size).toBe(hashes.length);
    const set = PHOTO_INDEX.setHashes();
    expect(hashes.some((hash) => set.has(hash))).toBe(false);
    expect(evidence.every((row) => /^ph-seed-/.test(String(row.photoId)) && row.seeded === true)).toBe(true);
    // [W4 review B2] each seeded evidence has its object: the seed's photo, at the key the row points at.
    for (const row of evidence) expect(harness.evidencePhotos.get(String(row.s3Key))).toBe(row.photoId);
    const items = allRows(harness).filter(({ table, row }) => table === "WorkOrders" && row.entity === "ChecklistItem" && row.clockId === RUN && row.item === "POWER_READING_PHOTO");
    expect(items.map(({ row }) => [row.status, row.attempts]).sort()).toEqual([["PASSED", 0], ["REJECTED", 2]]);
    const rejected = items.find(({ row }) => row.status === "REJECTED")?.row;
    expect(rejected?.lastRejectReason).toEqual(expect.any(String));
  });

  it("uses the set photo of an explicit photoId (the duplicate a step asks for on purpose)", async () => {
    const harness = worldsHarness();
    const world = await qaWorld(harness, [{ key: "a", model: "wo-24817", installer: "own", preset: { checklist: { POWER_READING_PHOTO: { status: "PASSED", photoId: "ph-meter-01" } } } }], "qa-31-sc04-dup");
    const [evidence] = evidenceOf(harness, world.clockId);
    expect(evidence).toMatchObject({ photoId: "ph-meter-01", sha256: PHOTO_INDEX.photo("ph-meter-01").sha256 });
    const order = await harness.connector.workOrders.requireWorkOrder(world.operations[0]?.workOrderId ?? "");
    expect(await harness.connector.workOrders.findEvidenceByHash(world.clockId, order.worldEpoch, PHOTO_INDEX.photo("ph-meter-01").sha256)).toHaveLength(1);
  });

  it(`fails with PRESET_POOL_EXHAUSTED once a world needs more than ${SEED_RENDERS_PER_ASPECT} renders of one item and aspect`, async () => {
    const harness = worldsHarness();
    const operations = Array.from({ length: SEED_RENDERS_PER_ASPECT + 1 }, (_unused, index) => ({ key: `o${index}`, model: "wo-24817", installer: "own", preset: { checklist: { ROSETTE_PHOTO: { status: "PASSED" as const } } } }));
    await expect(qaWorld(harness, operations)).rejects.toMatchObject({ reason: "PRESET_POOL_EXHAUSTED" });
    // Never half a world: the clock, the rows and the leases of the failed build are gone.
    expect(await harness.connector.runtime.getClock(RUN)).toBeUndefined();
    expect(allRows(harness).filter(({ table, row }) => table === "WorkOrders" && row.clockId === RUN)).toEqual([]);
    expect(allRows(harness).filter(({ row }) => String(row.PK).startsWith("LEASE#"))).toEqual([]);
  });
});

describe("other presets of an operation", () => {
  it("seeds the ONU, the steps, the window, the active order, candidate photos and the profile", async () => {
    const harness = worldsHarness();
    const world = await qaWorld(harness, [
      {
        key: "a",
        model: "wo-24818",
        installer: "own",
        preset: {
          onu: { behaviour: "LOW_POWER_THEN_OK", rxDbm: -29.8, fixed: true },
          steps: [{ symptom: "LOW_POWER", stepRef: "DIAG-03", outcome: "NO_CHANGE" }],
          lastInboundAtSim: "2026-10-13T11:47:00-06:00",
          activeWorkOrderId: true,
          candidates: ["ph-meter-02"],
          profile: { rejects: { GLARE: 2 } },
        },
      },
    ]);
    const { workOrderId, installerId } = world.operations[0] ?? { workOrderId: "", installerId: "" };
    const order = await harness.connector.workOrders.requireWorkOrder(workOrderId);
    expect(await harness.client.get("Network", { PK: `ONU#${RUN}#${order.onuSerial}`, SK: "META" })).toMatchObject({ behaviour: "LOW_POWER_THEN_OK", rxPowerDbm: -29.8, fixed: true, fixedBy: "DEMO_CONTROL" });
    expect((await harness.connector.workOrders.listSteps(workOrderId)).map((step) => [step.stepRef, step.outcome])).toEqual([["DIAG-03", "NO_CHANGE"]]);
    expect((await harness.connector.people.requirePerson(installerId)).lastInboundAtSim).toBe("2026-10-13T11:47:00-06:00");
    expect((await harness.connector.worlds.getInstallerState(installerId))?.activeWorkOrderId).toBe(workOrderId);
    const inbound = (await harness.connector.conversations.listMessages(installerId)).filter((message) => message.direction === "IN");
    expect(inbound.map((message) => [message.content, message.media?.sha256])).toEqual([["IMAGE", PHOTO_INDEX.photo("ph-meter-02").sha256]]);
    expect(world.presets.find((preset) => preset.workOrderId === workOrderId)?.candidates).toEqual(inbound.map((message) => candidateIdOf(message.messageId)));
    expect([...harness.media.values()]).toEqual(["ph-meter-02"]);
    expect((await harness.connector.people.getProfile(installerId))?.rejects).toEqual({ GLARE: 2 });
  });

  it("opens the case through the real ladder up to the rung, and takes it for TAKEN", async () => {
    const harness = withCases(worldsHarness());
    const world = await qaWorld(harness, [
      { key: "a", model: "wo-24818", installer: "own", preset: { case: { reason: "DIAGNOSIS_ATTEMPTS", rung: "SECONDARY", status: "OPEN" } } },
      { key: "b", model: "wo-24820", installer: "own", preset: { case: { reason: "PHOTO_ATTEMPTS", rung: "PRIMARY", status: "TAKEN" } } },
    ]);
    const [open, taken] = await Promise.all(world.operations.map(async (operation) => (await harness.connector.cases.listCasesOfWorkOrder(operation.workOrderId))[0]));
    expect(open).toMatchObject({ reason: "DIAGNOSIS_ATTEMPTS", rung: "SECONDARY", status: "OPEN" });
    expect(taken).toMatchObject({ reason: "PHOTO_ATTEMPTS", rung: "PRIMARY", status: "TAKEN", takenBy: `sup-adriana-${RUN}` });
    expect(open?.roster).toMatchObject({ primaryId: `sup-adriana-${RUN}`, secondaryId: `sup-hector-${RUN}` });
  });

  it("refuses a case preset when the world was built without the case handlers", async () => {
    const harness = worldsHarness();
    await expect(qaWorld(harness, [{ key: "a", model: "wo-24818", installer: "own", preset: { case: { reason: "OUT_OF_MANUAL", rung: "PRIMARY", status: "OPEN" } } }])).rejects.toBeInstanceOf(ToolError);
  });
});

const OFFERS: ReadonlyArray<WaButtonAction & ("CONSULT_SUPERVISOR" | "CUSTOMER_OK" | "CLOSE_INSTALLATION" | "CHOOSE_ITEM")> = ["CONSULT_SUPERVISOR", "CUSTOMER_OK", "CLOSE_INSTALLATION", "CHOOSE_ITEM"];

describe("preset offer", () => {
  it.each(OFFERS)("seeds a REPLY with the %s button and a real nonce that a tap resolves; another person's phone is refused", async (action) => {
    const harness = worldsHarness();
    const world = await qaWorld(harness, [
      { key: "a", model: "wo-24817", installer: "own", preset: { offer: { action, ...(action === "CHOOSE_ITEM" ? { item: "ROSETTE_PHOTO" as const } : {}) } } },
      { key: "b", model: "wo-24820", installer: "own" },
    ]);
    const [mine, other] = world.operations;
    if (mine === undefined || other === undefined) throw new Error("two operations expected");
    const installer = await harness.connector.people.requirePerson(mine.installerId);
    const offers = (await harness.connector.conversations.listMessages(mine.installerId)).filter((message) => message.direction === "OUT");
    expect(offers).toHaveLength(1);
    const offer = offers[0];
    expect(offer).toMatchObject({ kind: "REPLY", content: "INTERACTIVE", author: "AGENT", seeded: true, refs: { seeded: true, offer: action } });
    expect(offer?.text).toBe(offerText({ action }));
    const [button] = (offer?.interactive?.buttons ?? []) as Array<{ id: string; action: string }>;
    expect(button?.action).toBe(action);

    const nonces = { runtime: harness.connector.runtime, nonceKey: NONCE_KEY, realClock: { now: async () => harness.now() } };
    const tap = await resolveNonce({ payload: button?.id ?? "", clockId: RUN, phoneHash: installer.phoneHash ?? "", allowedActions: INSTALLER_BUTTONS }, nonces);
    expect(tap).toMatchObject({ ok: true, nonce: { action, personId: mine.installerId, object: action === "CHOOSE_ITEM" ? { kind: "ITEM", id: "ROSETTE_PHOTO" } : { kind: "WORK_ORDER", id: mine.workOrderId } } });
    const stranger = await harness.connector.people.requirePerson(other.installerId);
    expect(await resolveNonce({ payload: button?.id ?? "", clockId: RUN, phoneHash: stranger.phoneHash ?? "", allowedActions: INSTALLER_BUTTONS }, nonces)).toEqual({ ok: false, reason: "NONCE_FOREIGN" });

    if (action === "CHOOSE_ITEM") return;
    const calls: string[] = [];
    const actions: WorkOrderActions = {
      openConsultCase: async () => void calls.push("CONSULT_SUPERVISOR"),
      closeInstallation: async () => (calls.push("CLOSE_INSTALLATION"), { ok: true }) as Awaited<ReturnType<WorkOrderActions["closeInstallation"]>>,
      recordCustomerOk: async () => void calls.push("CUSTOMER_OK"),
    };
    const event = { type: "BUTTON_ACTION", action, eventId: "evt-1", clockId: RUN, ispId: world.ispId, installerId: mine.installerId, workOrderId: mine.workOrderId, offerMessageId: offer?.messageId, message: { personId: mine.installerId, sentAtSim: "2026-10-13T10:05:00-06:00", messageId: "msg-tap" } } as ButtonActionEvent;
    await runButtonAction(event, { connector: harness.connector, actions, notices: { send: async () => undefined } as never });
    expect(calls).toEqual([action]);
  });
});

describe("scenes of Saltar a escena", () => {
  it("every scene that ends on a button of the agent seeds it, and no scene seeds bytes of the set", async () => {
    const scenes = await scenesOf(worldsHarness().deps, GUEST_TEST_ISP_ID);
    expect(scenes.length).toBeGreaterThan(5);
    const set = PHOTO_INDEX.setHashes();
    for (const scene of scenes) {
      const harness = withCases(worldsHarness());
      await buildWorld(factoryDepsOf(harness.deps), { ispId: GUEST_TEST_ISP_ID, origin: "TEST" });
      await jumpToScene(harness.deps, { clockId: GUEST_TEST_CLOCK_ID, sceneId: scene.sceneId, actor: "QA" });
      for (const [workOrderId, preset] of Object.entries(scene.orders)) {
        const checklist = preset.checklist ?? {};
        const photosDone = ["POWER_READING_PHOTO", "ONU_LABEL_PHOTO", "ROSETTE_PHOTO"].every((item) => checklist[item as keyof typeof checklist]?.status === "PASSED");
        const ready = photosDone && checklist.CUSTOMER_OK?.status === "PASSED" && checklist.ONU_ONLINE?.status === "PASSED";
        const offered = (await harness.connector.conversations.listMessages((await harness.connector.workOrders.requireWorkOrder(workOrderId)).installerId))
          .filter((message) => message.refs?.seeded === true && message.workOrderId === workOrderId)
          .map((message) => message.refs?.offer);
        if (ready) expect(offered, scene.sceneId).toContain("CLOSE_INSTALLATION");
        else if (photosDone) expect(offered, scene.sceneId).toContain("CUSTOMER_OK");
      }
      const hashes = evidenceOf(harness, GUEST_TEST_CLOCK_ID).filter((row) => row.seeded === true).map((row) => String(row.sha256));
      expect(hashes.filter((hash) => set.has(hash)), scene.sceneId).toEqual([]);
    }
  });
});
