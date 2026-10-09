// Area E · Photo evidence (docs/flows-catalog.md FL-027, FL-035 to FL-042, FL-046 and FL-103), in process:
// the photo through the simulator's upload and the channel's checks, the candidate in the envelope (never
// the image), `validate_install_photo` over the scripted validator (the set's scripted verdicts, by the
// bytes it receives) with the deterministic checks against the in-process orchestrator, the reaction by
// the pipeline, `update_checklist`, the attempts and the case they open.
import { describe, expect, it } from "vitest";
import { VERDICT_REACTIONS } from "../../packages/bff/src/copy/buttons";
import { READ_CHECKLIST, READ_ORDER, candidateOf, citedReply, outputOf, reply, search, validate } from "./support/agent";
import { photoTurn } from "./support/story";
import { createFlowWorld, type FlowWorld } from "./support/world";

const ITEMS = ["POWER_READING_PHOTO", "ONU_LABEL_PHOTO", "ROSETTE_PHOTO"] as const;

/** The installer on site with the order active and its ONU online at the orchestrator's `rx` (FL-020 done). */
async function onSite(installerId: string, workOrderId: string, options: { readonly rx?: number; readonly onuOnline?: boolean } = {}): Promise<FlowWorld> {
  const world = await createFlowWorld();
  await world.at("09:45");
  const at = await world.simNow();
  await world.data.worlds.setActiveWorkOrder(installerId, world.clockId, workOrderId, at);
  const order = await world.data.workOrders.requireWorkOrder(workOrderId);
  await world.network.client.setBehaviour({ clockId: world.clockId, serial: order.onuSerial, caller: "QA", atSim: at, change: { behaviour: "ONLINE_OK", fixed: true, ...(options.rx === undefined ? {} : { rxPowerDbm: options.rx }) } });
  if (options.onuOnline !== false) await world.data.workOrders.updateChecklistItem(workOrderId, "ONU_ONLINE", { status: "PASSED" }, { actor: "QA", atSim: at });
  return world;
}

const validations = (world: FlowWorld, workOrderId: string, item?: (typeof ITEMS)[number]) => world.data.workOrders.listValidations(workOrderId, item);
const itemStatus = async (world: FlowWorld, workOrderId: string, item: string) => (await world.data.workOrders.getChecklistItem(workOrderId, item as never))?.status;

describe("evidence flows", () => {
  it("[FL-027] the photo request of a new order carries the tip of the installer's measured profile, without customer data", async () => {
    const world = await onSite("inst-karina", "wo-24820");
    world.plan({
      steps: [
        READ_ORDER,
        search("fotos de evidencia del checklist", "EVI"),
        citedReply((context) => `Mándame las tres fotos. Consejo: ${String((workOrderOf(context).tips as Array<{ text: string }> | undefined)?.[0]?.text ?? "")}`, "EVI-01", {
          refs: { items: [...ITEMS] },
        }),
      ],
    });
    await world.text("inst-karina", "¿Qué fotos mando?");
    const read = world.harness.turns[0]?.calls[0]?.output as unknown as { facts: { tips: Array<{ tipId: string; reason: string; count30d: number; text: string }> } };
    expect(read.facts.tips.map((tip) => tip.reason)).toContain("GLARE");
    expect(read.facts.tips.find((tip) => tip.reason === "GLARE")?.count30d).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(read.facts.tips)).not.toMatch(/cust-|10424|@|\+52/);
    expect((await world.delivered("inst-karina", "REPLY"))[0]?.text).toContain(read.facts.tips[0]?.text ?? "∅");
  });

  it("[FL-035] what is missing comes from get_checklist, with the short rubric, cited from §EVI-01", async () => {
    const world = await onSite("inst-rogelio", "wo-24817");
    world.plan({
      steps: [
        READ_CHECKLIST,
        search("fotos de evidencia del checklist", "EVI"),
        citedReply((context) => `Te faltan: ${((outputOf(context, "get_checklist").items as Array<{ label: string; status: string }>).filter((item) => item.status !== "PASSED").map((item) => item.label)).join(", ")}`, "EVI-01", {
          refs: { items: [...ITEMS, "CUSTOMER_OK"] },
        }),
      ],
    });
    await world.voice("inst-rogelio", "vn-06");
    const checklist = world.harness.turns[0]?.calls[0]?.output as unknown as { items: Array<{ item: string; status: string; rubricHint?: string }> };
    expect(checklist.items.filter((item) => item.status === "PENDING").map((item) => item.item).sort()).toEqual([...ITEMS, "CUSTOMER_OK"].sort());
    expect(checklist.items.find((item) => item.item === "POWER_READING_PHOTO")?.rubricHint).toBeTruthy();
    const [answer] = await world.delivered("inst-rogelio", "REPLY");
    expect(answer?.refs?.citations).toEqual(["EVI-01"]);
    expect(answer?.refs?.items).toEqual([...ITEMS, "CUSTOMER_OK"]);
  });

  it("[FL-036] the candidate id of the envelope is the one validate_install_photo accepts", async () => {
    const world = await onSite("inst-rogelio", "wo-24817", { rx: -21.4 });
    world.plan({ steps: [{ tool: "validate_install_photo", input: (context) => ({ candidateId: context.envelope.candidateId ?? "", item: "POWER_READING_PHOTO" }) }] });
    await world.photo("inst-rogelio", "ph-meter-01");
    expect(world.harness.turns[0]?.calls[0]?.output).toMatchObject({ ok: true, verdict: "PASS" });
  });

  it("[FL-036] [FL-103] the meter in range passes: validation recorded, evidence copied without metadata, item passed and one ✅ reaction", async () => {
    const world = await onSite("inst-rogelio", "wo-24817", { rx: -21.4 });
    world.plan(photoTurn("POWER_READING_PHOTO"));
    await world.photo("inst-rogelio", "ph-meter-01");
    const [validation] = await validations(world, "wo-24817", "POWER_READING_PHOTO");
    expect(validation).toMatchObject({ verdict: "PASS", rubricVersion: "v001", source: "SCRIPTED", stopReason: "tool_use" });
    expect(validation?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(validation?.usage?.inputTokens).toBeGreaterThan(0);
    const [evidence] = await world.data.workOrders.listEvidence("wo-24817");
    const copy = world.objects.bytesOf("Evidence", evidence?.s3Key ?? "");
    expect(copy).toBeDefined();
    expect(Buffer.from(copy ?? []).includes(Buffer.from("Exif"))).toBe(false);
    expect(await itemStatus(world, "wo-24817", "POWER_READING_PHOTO")).toBe("PASSED");
    const reactions = await world.delivered("inst-rogelio", "VERDICT_REACTION");
    expect(reactions.map((reaction) => reaction.refs?.verdict)).toEqual(["PASS"]);
    expect(JSON.stringify(reactions[0]?.refs?.whatsapp ?? reactions[0])).toContain(VERDICT_REACTIONS.PASS);
    expect((await world.decisions()).filter((decision) => decision.messageId === reactions[0]?.messageId).map((decision) => decision.decision)).toEqual(["ALLOW"]);
  });

  it.each([
    ["ph-meter-07", "wo-24818", -28.6, "OUT_OF_RANGE_LOW"],
    ["ph-meter-09", "wo-24819", -6.4, "OUT_OF_RANGE_HIGH"],
  ])("[FL-037] [FL-103] %s out of range is rejected by the code with an actionable reason and one 🔁 reaction", async (photoId, workOrderId, rx, reason) => {
    const world = await onSite("inst-rogelio", workOrderId, { rx });
    world.plan(photoTurn("POWER_READING_PHOTO"));
    await world.photo("inst-rogelio", photoId);
    const [validation] = await validations(world, workOrderId, "POWER_READING_PHOTO");
    expect(validation).toMatchObject({ verdict: "REJECT", reasonCode: reason });
    expect(validation?.checks).toContain("VAL-RANGE");
    expect(await itemStatus(world, workOrderId, "POWER_READING_PHOTO")).toBe("REJECTED");
    expect((await world.delivered("inst-rogelio", "VERDICT_REACTION")).map((reaction) => reaction.refs?.verdict)).toEqual(["REJECT"]);
    const answer = (await world.delivered("inst-rogelio", "REPLY")).at(-1);
    expect(answer?.text).toMatch(/No pude validar la foto: .{10,}/);
    expect(answer?.refs?.citations).toEqual(["DIAG-03"]);
  });

  it.each([
    ["ph-label-04", "BLURRY"],
    ["ph-label-06", "GLARE"],
    ["ph-label-05", "BLURRY"],
  ])("[FL-038] %s is rejected for quality (%s) and the item's failed attempts grow by one", async (photoId, reason) => {
    const world = await onSite("inst-karina", "wo-24820", { rx: -20.2 });
    world.plan(photoTurn("ONU_LABEL_PHOTO"));
    await world.photo("inst-karina", photoId);
    expect((await validations(world, "wo-24820", "ONU_LABEL_PHOTO")).map((validation) => [validation.verdict, validation.reasonCode])).toEqual([["REJECT", reason]]);
    expect((await world.data.workOrders.getChecklistItem("wo-24820", "ONU_LABEL_PHOTO"))?.attempts).toBe(1);
  });

  it("[FL-039] a rosette photo sent for the meter is the wrong subject; the installer accepts using it for the rosette and it passes", async () => {
    const world = await onSite("inst-rogelio", "wo-24817", { rx: -21.4 });
    let candidateId = "";
    world.plan(
      {
        steps: [
          validate("POWER_READING_PHOTO"),
          reply(
            (context) => {
              candidateId = candidateOf(context);
              return outputOf(context, "validate_install_photo").reasonCode === "WRONG_SUBJECT" ? "Esa foto es de la roseta, no del medidor. ¿La uso para la roseta?" : "Recibida.";
            },
            { buttons: [{ action: "CHOOSE_ITEM", item: "ROSETTE_PHOTO" }] },
          ),
        ],
      },
      { steps: [{ tool: "validate_install_photo", input: () => ({ candidateId, item: "ROSETTE_PHOTO" }) }, reply("Listo, la usé para la roseta.")] },
    );
    await world.photo("inst-rogelio", "ph-rosette-01");
    await world.tap("inst-rogelio", { title: "Roseta" });
    expect((await validations(world, "wo-24817")).map((validation) => [validation.item, validation.verdict, validation.reasonCode ?? null])).toEqual(
      expect.arrayContaining([
        ["POWER_READING_PHOTO", "REJECT", "WRONG_SUBJECT"],
        ["ROSETTE_PHOTO", "PASS", null],
      ]),
    );
    expect(world.harness.turns[1]?.envelope.candidateId).toBeUndefined();
  });

  it("[FL-040] the label with the order's serial and the rosette pass, the customer's conformity by button, and the agent offers to close", async () => {
    const world = await onSite("inst-rogelio", "wo-24817", { rx: -21.4 });
    world.plan(photoTurn("POWER_READING_PHOTO"), photoTurn("ONU_LABEL_PHOTO"), {
      steps: [validate("ROSETTE_PHOTO"), { tool: "update_checklist", input: (context) => ({ item: "ROSETTE_PHOTO", status: "PASSED", validationId: String(outputOf(context, "validate_install_photo").validationId) }) }, reply("Listo. Cuando la clienta esté conforme, toca el botón.", { buttons: [{ action: "CUSTOMER_OK" }] })],
    });
    await world.photo("inst-rogelio", "ph-meter-01");
    await world.photo("inst-rogelio", "ph-label-01");
    await world.photo("inst-rogelio", "ph-rosette-02");
    await world.tap("inst-rogelio", "CUSTOMER_OK");
    const checklist = await world.data.workOrders.listChecklist("wo-24817");
    expect(checklist.map((entry) => [entry.item, entry.status]).sort()).toEqual([...ITEMS, "CUSTOMER_OK", "ONU_ONLINE"].map((item) => [item, "PASSED"]).sort());
    expect((await validations(world, "wo-24817", "ONU_LABEL_PHOTO"))[0]?.readings).toMatchObject({ serialMatches: true });
    // The tap is deterministic and starts no turn; the offer to close comes with the agent's next answer.
    expect(world.harness.turns).toHaveLength(3);
    world.plan({ steps: [READ_CHECKLIST, reply("Todo el checklist está completo; ya puedes cerrar.", { buttons: [{ action: "CLOSE_INSTALLATION" }] })] });
    await world.text("inst-rogelio", "Ya quedó, la clienta está conforme");
    expect((world.harness.turns[3]?.calls[0]?.output as unknown as { complete: boolean }).complete).toBe(true);
    const offer = (await world.delivered("inst-rogelio", "REPLY")).at(-1);
    expect(((offer?.interactive?.buttons ?? []) as Array<{ action: string }>).map((button) => button.action)).toEqual(["CLOSE_INSTALLATION"]);
  });

  it("[FL-041] (a) a label with another serial and (b) a reading 6 dB off the orchestrator's are rejected by the checks", async () => {
    const karina = await onSite("inst-karina", "wo-24821", { rx: -22.8 });
    karina.plan(photoTurn("ONU_LABEL_PHOTO"));
    await karina.photo("inst-karina", "ph-label-09");
    expect((await validations(karina, "wo-24821", "ONU_LABEL_PHOTO")).map((validation) => [validation.reasonCode, validation.checks.includes("VAL-SERIAL")])).toEqual([["SERIAL_MISMATCH", true]]);
    const rogelio = await onSite("inst-rogelio", "wo-24817", { rx: -21.4 });
    rogelio.plan(photoTurn("POWER_READING_PHOTO"));
    await rogelio.photo("inst-rogelio", "ph-meter-05");
    expect((await validations(rogelio, "wo-24817", "POWER_READING_PHOTO")).map((validation) => [validation.reasonCode, validation.checks.includes("VAL-CROSSCHECK")])).toEqual([["READING_MISMATCH", true]]);
  });

  it("[FL-041] (c) a photo already used as evidence of another order of the world is a duplicate without calling the model; in another world it is not", async () => {
    const world = await onSite("inst-rogelio", "wo-24817", { rx: -21.4 });
    world.plan(photoTurn("POWER_READING_PHOTO"), photoTurn("POWER_READING_PHOTO"));
    await world.photo("inst-rogelio", "ph-meter-01");
    await world.data.worlds.setActiveWorkOrder("inst-rogelio", world.clockId, "wo-24818", await world.simNow());
    const calls = world.targets.photoModel.calls.length;
    await world.photo("inst-rogelio", "ph-meter-01");
    const [duplicate] = await validations(world, "wo-24818", "POWER_READING_PHOTO");
    expect(duplicate).toMatchObject({ verdict: "REJECT", reasonCode: "DUPLICATE_EVIDENCE" });
    expect(world.targets.photoModel.calls).toHaveLength(calls);
    await world.data.worlds.setActiveWorkOrder("inst-rogelio-gtest", "GUEST#isp-guest-test", "wo-24817-gtest", await world.simNow("GUEST#isp-guest-test"));
    await world.network.client.setBehaviour({ clockId: "GUEST#isp-guest-test", serial: "DEMO3F2C19A0", caller: "QA", atSim: await world.simNow("GUEST#isp-guest-test"), change: { behaviour: "ONLINE_OK", fixed: true, rxPowerDbm: -21.4 } });
    world.plan(photoTurn("POWER_READING_PHOTO"));
    await world.photo("inst-rogelio-gtest", "ph-meter-01");
    expect((await validations(world, "wo-24817-gtest", "POWER_READING_PHOTO")).map((validation) => validation.reasonCode ?? "PASS")).toEqual(["PASS"]);
  });

  it("[FL-042] the third rejection of the same item opens one PHOTO_ATTEMPTS case with the three attempts", async () => {
    const world = await onSite("inst-karina", "wo-24820", { rx: -20.2 });
    world.plan(photoTurn("ONU_LABEL_PHOTO"), photoTurn("ONU_LABEL_PHOTO"), photoTurn("ONU_LABEL_PHOTO"));
    for (const photoId of ["ph-label-04", "ph-label-05", "ph-label-06"]) await world.photo("inst-karina", photoId);
    const [caseItem, ...others] = await world.data.cases.listCasesOfWorkOrder("wo-24820");
    expect(others).toEqual([]);
    expect(caseItem?.reason).toBe("PHOTO_ATTEMPTS");
    expect(caseItem?.evidenceIds).toHaveLength(3);
    expect(await itemStatus(world, "wo-24820", "ONU_LABEL_PHOTO")).toBe("REJECTED");
    expect(await world.delivered("inst-karina", "CASE_NOTICE")).toHaveLength(1);
    expect(world.harness.turns.at(-1)?.calls[0]?.output).toMatchObject({ ok: true, attempts: 3, caseOpened: { reason: "PHOTO_ATTEMPTS" } });
  });

  it("[FL-046] (a) a photo nobody asked for is a candidate the agent asks about; (b) an image too heavy and (c) a sticker get fixed replies and no turn", async () => {
    const world = await onSite("inst-rogelio", "wo-24817", { onuOnline: false });
    world.plan({ steps: [reply("¿Para qué ítem es esta foto?", { buttons: ITEMS.map((item) => ({ action: "CHOOSE_ITEM", item })) })] });
    await world.photo("inst-rogelio", "ph-meter-01");
    expect(world.harness.turns[0]?.envelope.candidateId).toMatch(/.+/);
    expect(await validations(world, "wo-24817")).toEqual([]);
    const heavy = new Uint8Array(4_500_000);
    heavy.set([0xff, 0xd8, 0xff, 0xe0]);
    await world.photo("inst-rogelio", { bytes: heavy });
    await world.send("inst-rogelio", { type: "other", kind: "sticker" });
    expect(world.harness.turns).toHaveLength(1);
    const notices = (await world.delivered("inst-rogelio", "SYSTEM_NOTICE")).map((message) => message.text ?? "");
    expect(notices).toHaveLength(2);
    expect(notices[0]).toMatch(/foto/i);
    const images = (await world.thread("inst-rogelio")).filter((message) => message.direction === "IN" && (message.content === "IMAGE" || message.content === "STICKER"));
    expect(world.objects.keys("Media").filter((key) => key.endsWith(images[1]?.media?.s3Key ?? "∅"))).toEqual([]);
  });
});

function workOrderOf(context: Parameters<typeof outputOf>[0]): Record<string, unknown> {
  return { ...((outputOf(context, "get_work_order").workOrder ?? {}) as Record<string, unknown>), tips: (outputOf(context, "get_work_order").facts as { tips?: unknown } | undefined)?.tips };
}
