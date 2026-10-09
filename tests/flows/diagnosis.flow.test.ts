// Area C · Voice and diagnosis (docs/flows-catalog.md FL-017 to FL-026 and FL-102), in process: the voice
// note through the media checks and `transcribe_voice_note` (the Transcribe fake answers the datasheet's
// transcript), the worker's preloaded reads, the scripted Harness through the local Gateway, the `orders`
// target over the in-process orchestrator and the outbound pipeline.
import { describe, expect, it } from "vitest";
import { splitSessionToken } from "@cuadrilla/shared";
import { STATUS_QUESTION } from "../../packages/bff/src/agent/grounding";
import { READ_ONU, READ_ORDERS, STATUS_REPLY, citedReply, outputOf, reply, search, troubleshooting } from "./support/agent";
import { CONFIRM_ONLINE, DIAGNOSE_NO_PON, dbm } from "./support/story";
import { createFlowWorld, type FlowWorld } from "./support/world";

async function onOrder(world: FlowWorld, installerId: string, workOrderId: string, time: string): Promise<void> {
  await world.at(time);
  await world.data.worlds.setActiveWorkOrder(installerId, world.clockId, workOrderId, await world.simNow());
}

const replies = (world: FlowWorld, personId: string) => world.delivered(personId, "REPLY");

describe("diagnosis flows", () => {
  it("[FL-017] a voice note is transcribed inside its message, masked, and answered in the window without max_tokens", async () => {
    const world = await createFlowWorld();
    await onOrder(world, "inst-rogelio", "wo-24817", "09:20");
    world.plan(DIAGNOSE_NO_PON);
    await world.voice("inst-rogelio", "vn-01");
    const voice = (await world.thread("inst-rogelio")).find((message) => message.direction === "IN" && message.content === "VOICE");
    expect(voice?.media?.kind).toBe("AUDIO");
    expect(voice?.transcript?.text).toMatch(/ONU/);
    expect(voice?.transcript?.text).toMatch(/PON/);
    expect(voice?.transcript?.confidence).toBeGreaterThanOrEqual(0.55);
    const [job] = world.transcribe.started;
    expect(job?.TranscriptionJobName).toMatch(/^cuadrilla-poc-[0-9a-f]{32}$/);
    expect(job?.Media?.MediaFileUri).not.toMatch(/[#?+= ]/);
    expect(job?.OutputKey).toMatch(/^[a-zA-Z0-9-_.!*'()/]{1,1024}$/);
    expect(world.objects.mediaObjects.deleted).toContain(`Media/${job?.OutputKey ?? ""}`);
    expect(world.objects.keys("Media", "transcripts/")).toEqual([]);
    expect(world.harness.turns[0]?.envelope.inboundKind).toBe("VOICE_TRANSCRIPT");
    expect(world.harness.turns[0]?.stopReason).toBe("end_turn");
    expect(await replies(world, "inst-rogelio")).toHaveLength(1);
    expect(world.logs.some((line) => line.metric === "FirstReplyLatency" && line.kind === "VOICE_TRANSCRIPT")).toBe(true);
  });

  it("[FL-018] an unintelligible note, one over two minutes and a document get their fixed notices and no turn", async () => {
    const world = await createFlowWorld();
    await onOrder(world, "inst-rogelio", "wo-24817", "09:20");
    await world.voice("inst-rogelio", "vn-09");
    await world.voice("inst-rogelio", "vn-10");
    await world.send("inst-rogelio", { type: "other", kind: "document" });
    expect(world.harness.turns).toHaveLength(0);
    const notices = (await world.delivered("inst-rogelio", "SYSTEM_NOTICE")).map((message) => message.text ?? "");
    expect(notices).toHaveLength(3);
    expect(notices[0]).toMatch(/No te entendí bien/);
    expect(notices[1]).toMatch(/2 minutos/);
    expect(notices[2]).toMatch(/recibir texto, notas de voz y fotos/);
    expect(world.logs.some((line) => line.metric === "TranscribeLowConfidence")).toBe(true);
    const voices = (await world.thread("inst-rogelio")).filter((message) => message.direction === "IN" && message.content === "VOICE");
    expect(world.objects.bytesOf("Media", voices[1]?.media?.s3Key ?? "")).toBeUndefined();
  });

  it("[FL-019] the ONU's state comes from the orchestrator for the order's serial; reads change nothing and a serial written by the model never passes", async () => {
    const world = await createFlowWorld();
    await onOrder(world, "inst-rogelio", "wo-24817", "09:20");
    world.plan({ steps: [READ_ONU, READ_ONU, { tool: "get_onu_status", input: { serial: "DEMO9999AAAA" } }, reply("Sigo revisando la ONU.")] });
    await world.text("inst-rogelio", "¿Cómo está la ONU?");
    const calls = world.harness.turns[0]?.calls ?? [];
    expect(calls[0]?.output).toMatchObject({ ok: true, operState: "LOS" });
    expect(calls[1]?.output).toMatchObject({ ok: true, operState: "LOS" });
    expect(calls[2]?.cedar.decision).toBe("DENY");
    expect(calls[2]?.output).toBeUndefined();
    expect(world.network.requests.filter((request) => request.startsWith("GET"))).toEqual(["GET /v1/onus/DEMO3F2C19A0", "GET /v1/onus/DEMO3F2C19A0"]);
    const row = await world.network.row(world.clockId, "DEMO3F2C19A0");
    expect(row).toMatchObject({ behaviour: "LOS_THEN_ONLINE", fixed: false });
    expect(row?.queryCount).toBeGreaterThanOrEqual(2);
    const turnId = splitSessionToken(world.harness.turns[0]?.envelope.sessionToken ?? "").turnId;
    const stored = await world.data.runtime.listTurnResults(turnId, "get_onu_status");
    expect(stored.map((result) => result.output.operState)).toEqual(["LOS", "LOS"]);
  });

  it("[FL-020] guided diagnosis: a cited step, the installer's physical action brings the ONU online, the step is fixed, the item passes and the photos are asked", async () => {
    const world = await createFlowWorld();
    await onOrder(world, "inst-rogelio", "wo-24817", "09:20");
    world.plan(DIAGNOSE_NO_PON, CONFIRM_ONLINE);
    await world.voice("inst-rogelio", "vn-01");
    await world.text("inst-rogelio", "Ya limpié el conector, ya prende");
    const steps = await world.data.workOrders.listSteps("wo-24817");
    expect(steps.map((step) => [step.stepRef, step.outcome])).toEqual([["DIAG-02", "FIXED"]]);
    expect((await world.data.workOrders.getChecklistItem("wo-24817", "ONU_ONLINE"))?.status).toBe("PASSED");
    expect((await world.network.row(world.clockId, "DEMO3F2C19A0"))?.fixed).toBe(true);
    const sent = await replies(world, "inst-rogelio");
    expect(sent.map((message) => message.refs?.citations)).toEqual([["DIAG-02"], ["EVI-01"]]);
    expect(sent[1]?.refs?.items).toEqual(["POWER_READING_PHOTO", "ONU_LABEL_PHOTO", "ROSETTE_PHOTO"]);
    expect(sent[1]?.text).toContain("21,4");
  });

  it("[FL-021] low power: online but out of the zone's range, the item cannot pass and the agent guides with §DIAG-03", async () => {
    const world = await createFlowWorld();
    await onOrder(world, "inst-rogelio", "wo-24818", "11:50");
    world.plan({
      steps: [
        READ_ONU,
        { tool: "update_checklist", input: { item: "ONU_ONLINE", status: "PASSED" } },
        search("potencia baja fuera de rango", "DIAG"),
        citedReply((context) => `La ONU está en línea pero en ${dbm(context)} dBm, fuera del rango. Revisa limpieza, curvaturas y conectores`, "DIAG-03"),
      ],
    });
    await world.text("inst-rogelio", "Ya prendió pero el medidor marca muy bajo");
    const [onu, update] = world.harness.turns[0]?.calls ?? [];
    expect(onu?.output).toMatchObject({ ok: true, operState: "ONLINE", rxPowerDbm: -29.8, inRange: false });
    expect(update?.output).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect((await world.data.workOrders.getChecklistItem("wo-24818", "ONU_ONLINE"))?.status).toBe("PENDING");
    expect((await replies(world, "inst-rogelio"))[0]?.refs?.citations).toEqual(["DIAG-03"]);
  });

  it("[FL-022] (a) an ONU without power: §DIAG-01 and, after the installer acts, online", async () => {
    const world = await createFlowWorld();
    await onOrder(world, "inst-tomas", "wo-24832", "10:10");
    world.plan(
      { steps: [READ_ONU, search("la ONU no enciende, sin energía, eliminador", "DIAG"), troubleshooting("NO_POWER", "DIAG-01", "PENDING"), citedReply(() => "La ONU no tiene energía. Revisa el eliminador y el contacto", "DIAG-01")] },
      { steps: [READ_ONU, troubleshooting("NO_POWER", "DIAG-01", "FIXED"), { tool: "update_checklist", input: { item: "ONU_ONLINE", status: "PASSED" } }, reply((context) => `Listo, ya está en línea a ${dbm(context)} dBm.`)] },
    );
    await world.text("inst-tomas", "La ONU está apagada, no enciende nada");
    await world.text("inst-tomas", "Ya cambié de contacto el eliminador");
    expect(world.harness.turns[0]?.calls[0]?.output).toMatchObject({ ok: true, operState: "DYING_GASP" });
    expect((await world.data.workOrders.listSteps("wo-24832")).map((step) => step.outcome)).toEqual(["FIXED"]);
    expect((await world.data.workOrders.getChecklistItem("wo-24832", "ONU_ONLINE"))?.status).toBe("PASSED");
  });

  it("[FL-022] (b) an ONU not provisioned twice in a row opens exactly one NOT_PROVISIONED case and tells the installer", async () => {
    const world = await createFlowWorld();
    await onOrder(world, "inst-beatriz", "wo-24830", "10:10");
    const readAndSay = { steps: [READ_ONU, search("ONU no aprovisionada en la OLT", "DIAG"), citedReply(() => "La ONU no está dada de alta en la red; no lo puedes resolver tú", "DIAG-04")] };
    world.plan(readAndSay, readAndSay, readAndSay);
    await world.text("inst-beatriz", "La ONU prende pero no navega");
    expect(await world.data.cases.listCasesOfWorkOrder("wo-24830")).toEqual([]);
    await world.text("inst-beatriz", "Ya la reinicié y sigue igual");
    await world.text("inst-beatriz", "¿Y ahora?");
    const cases = await world.data.cases.listCasesOfWorkOrder("wo-24830");
    expect(cases.map((caseItem) => caseItem.reason)).toEqual(["NOT_PROVISIONED"]);
    expect(await world.delivered("inst-beatriz", "CASE_NOTICE")).toHaveLength(1);
  });

  it("[FL-025] (a) an off-topic question gets a short reply back to work and no case; (b) another installer's orders are never read", async () => {
    const world = await createFlowWorld();
    await onOrder(world, "inst-rogelio", "wo-24817", "09:20");
    world.plan(
      { steps: [reply("Eso no lo sé; sigamos con tu orden.")] },
      { steps: [READ_ORDERS, { tool: "get_work_order", input: { workOrderNumber: "24820" } }, reply("Solo veo tus órdenes del día.")] },
    );
    await world.text("inst-rogelio", "¿Quién ganó el partido anoche?");
    await world.text("inst-rogelio", "¿Qué órdenes tiene Karina hoy?");
    const [, second] = world.harness.turns;
    expect(JSON.stringify(second?.calls[0]?.output)).not.toContain("24820");
    expect(second?.calls[1]?.output).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    const sent = (await world.delivered("inst-rogelio")).map((message) => message.text ?? "").join("\n");
    for (const foreign of ["Karina", "24820", "24821", "24822"]) expect(sent).not.toContain(foreign);
    expect(await world.data.cases.listCasesOfWorkOrder("wo-24817")).toEqual([]);
  });

  it("[FL-025] (c) a greeting gets exactly one status reply per message, from the reads the worker preloaded, measured against the status question", async () => {
    const world = await createFlowWorld();
    await onOrder(world, "inst-rogelio", "wo-24817", "09:20");
    world.plan({ steps: [STATUS_REPLY] }, { steps: [STATUS_REPLY] });
    await world.text("inst-rogelio", "Hola");
    await world.text("inst-rogelio", "hola");
    expect(await replies(world, "inst-rogelio")).toHaveLength(2);
    for (const turn of world.harness.turns) {
      expect(Object.keys(turn.envelope.preloaded).sort()).toEqual(["get_checklist", "get_work_order", "get_work_orders"]);
      expect(turn.calls.map((call) => call.tool)).toEqual(["send_whatsapp"]);
    }
    expect(world.guardrails.g2Inputs.map((input) => input.query)).toEqual([STATUS_QUESTION.es, STATUS_QUESTION.es]);
  });

  it("[FL-026] with the orchestrator down the read retries and answers unavailable; the agent states no power nor state", async () => {
    const world = await createFlowWorld();
    await onOrder(world, "inst-rogelio", "wo-24817", "09:20");
    world.network.outage = true;
    world.plan({ steps: [READ_ONU, reply((context) => (outputOf(context, "get_onu_status").available === false ? "Ahorita no puedo ver la red; sigamos con el manual." : "Ya la vi."))] });
    await world.text("inst-rogelio", "¿La ONU ya tiene señal?");
    expect(world.harness.turns[0]?.calls[0]?.output).toMatchObject({ ok: true, available: false });
    expect(world.network.requests.filter((request) => request.startsWith("GET"))).toHaveLength(3);
    const [answer] = await replies(world, "inst-rogelio");
    expect(answer?.text).not.toMatch(/dBm|LOS|ONLINE|en línea/);
    expect(world.logs.filter((line) => line.message === "tool.failed")).toEqual([]);
  });

  it("[FL-102] a queued message is marked read before the first outbound of its turn; an unknown number is never acknowledged", async () => {
    const world = await createFlowWorld();
    await onOrder(world, "inst-rogelio", "wo-24817", "09:20");
    await world.text("inst-rogelio", "Ya llegué con la clienta");
    const inbound = (await world.thread("inst-rogelio")).find((message) => message.direction === "IN" && message.text === "Ya llegué con la clienta");
    expect(inbound?.status).toBe("READ");
    const events = await world.data.conversations.listMessageEvents("inst-rogelio", inbound?.messageId);
    const ack = events.find((event) => event.status === "READ" && event.eventId.startsWith("ack-"));
    expect(ack).toBeDefined();
    const [answer] = await replies(world, "inst-rogelio");
    expect(Date.parse(ack?.atReal ?? "")).toBeLessThanOrEqual(Date.parse(answer?.sentAtReal ?? ""));
    const unknown = await world.sendFrom("+525501990001", { type: "text", body: "Hola" });
    expect(world.memory.client.dump("Conversations").filter((row) => row.entity === "MessageEvent" && row.eventId === `ack-${unknown.wamid}`)).toEqual([]);
  });
});
