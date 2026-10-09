import { TRPCError } from "@trpc/server";
import { describe, expect, it } from "vitest";
import { DEMO, GUEST_07 } from "../services/people/testing";
import { consoleTestWorld, type ConsoleTestWorld } from "./console-testing";

const EV = "ev-01J9ZQX0000000000000000000";
const VAL = "val-01J9ZQX0000000000000000000";

async function seedStory(t: ConsoleTestWorld): Promise<void> {
  const { connector } = t.memory;
  const { world } = t;
  await connector.people.putCustomer({ customerId: `cust-10421${world.spec.tag}`, ispId: world.ispId, clockId: world.clockId, firstName: "Lucía", lastName: "Treviño", addressLine: "Calle Ficticia 12", neighborhood: "Las Lomitas", email: "success+c10421@simulator.amazonses.com", phone: "+525501010099" });
  await connector.workOrders.createWorkOrder({
    workOrderId: `wo-24900${world.spec.tag}`,
    workOrderNumber: "24900",
    ispId: world.ispId,
    clockId: world.clockId,
    worldEpoch: 1,
    installerId: world.ids.julian,
    customerId: `cust-10421${world.spec.tag}`,
    crewId: "crew-s1",
    zoneId: "zone-sur",
    date: "2026-10-13",
    appointmentWindow: { startSim: "2026-10-13T08:00:00-06:00", endSim: "2026-10-13T09:00:00-06:00" },
    plan: "Fibra 100",
    onuSerial: "DEMO3F2C1000",
    onuModel: "ONU-G1",
    oltPort: "OLT-S1/1/1",
    opticalClass: "C+",
    status: "SCHEDULED",
  });
  const order = world.ids.order;
  const base = { personId: world.ids.rogelio, ispId: world.ispId, clockId: world.clockId, channel: "WHATSAPP" as const, workOrderId: order, simulated: true };
  await connector.conversations.appendMessage({
    ...base,
    messageId: "wa-in-0001",
    direction: "IN",
    content: "VOICE",
    status: "RECEIVED",
    author: `PERSON:${world.ids.rogelio}`,
    media: { kind: "AUDIO", s3Key: "sim/seg/upl-1", mime: "audio/ogg", bytes: 1200 },
    transcript: { text: "la ONU no prende la luz PON", confidence: 0.93 },
    sentAtSim: "2026-10-13T09:20:00-06:00",
  });
  await connector.conversations.appendMessage({
    ...base,
    messageId: "wa-out-0002",
    direction: "OUT",
    content: "TEXT",
    kind: "REPLY",
    status: "SENT",
    author: "AGENT",
    text: "Limpia el conector (Manual v1, §DIAG-02).",
    policy: { decision: "ALLOW", ruleIds: ["CP-WA-24H", "CP-CITATION"] },
    refs: { policy: { form: "TEXT", author: "AGENT", citations: ["DIAG-02"] } },
    sentAtSim: "2026-10-13T09:21:00-06:00",
  });
  await connector.conversations.appendTurnNote({ turnId: "turn-0001", personId: world.ids.rogelio, clockId: world.clockId, workOrderId: order, trigger: "INSTALLER_MESSAGE", note: "Guided §DIAG-02.", atSim: "2026-10-13T09:21:05-06:00" });
  await connector.audit.append({ ispId: world.ispId, clockId: world.clockId, atSim: "2026-10-13T09:21:00-06:00", decision: "ALLOW", action: "SEND_WHATSAPP", ruleIds: ["CP-WA-24H"], actor: "AGENT", refs: { workOrderId: order }, messageId: "wa-out-0002" });
  await connector.workOrders.createEvidence({ evidenceId: EV, workOrderId: order, clockId: world.clockId, worldEpoch: 1, item: "POWER_READING_PHOTO", sha256: "1".repeat(64), s3Key: "photos/wo-24817/POWER_READING_PHOTO/ev.jpg", mime: "image/jpeg", bytes: 2000, receivedAtSim: "2026-10-13T09:46:00-06:00" });
  await connector.workOrders.createValidation({ validationId: VAL, workOrderId: order, clockId: world.clockId, item: "POWER_READING_PHOTO", evidenceId: EV, verdict: "PASS", source: "SCRIPTED", atSim: "2026-10-13T09:46:30-06:00" });
  await connector.timers.createTimer({ timerId: "deferred-1", kind: "DEFERRED_SEND", home: { kind: "WORK_ORDER", id: order }, clockId: world.clockId, dueAtSim: "2026-10-13T10:00:00-06:00", status: "SCHEDULED", reason: "CP-QUIET-HOURS" });
}

async function refusal(call: Promise<unknown>): Promise<string> {
  const error = await call.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(TRPCError);
  return (error as TRPCError).code;
}

describe("orders router [FL-080]", () => {
  it("[FL-080] lists the world's day with the main story pinned first and filters by crew and status", async () => {
    const t = await consoleTestWorld(DEMO);
    await seedStory(t);
    const ops = await t.as("OPS", "usr-ops");
    const all = await ops.orders.list();
    expect(all.day).toBe("2026-10-13");
    expect(all.workOrders.map((row) => row.workOrderNumber)).toEqual(["24817", "24900"]);
    expect(all.workOrders[0]).toMatchObject({ mainStory: true, installer: { firstName: "Rogelio" }, checklist: expect.arrayContaining([{ item: "ONU_ONLINE", status: "PENDING" }]) });
    expect((await ops.orders.list({ crewId: "crew-s1" })).workOrders.map((row) => row.workOrderNumber)).toEqual(["24900"]);
    expect((await ops.orders.list({ status: "SCHEDULED" })).workOrders.map((row) => row.workOrderNumber)).toEqual(["24900"]);
  });

  it("[FL-080] the detail never carries the customer's phone or email", async () => {
    const t = await consoleTestWorld(DEMO);
    await seedStory(t);
    const detail = await (await t.as()).orders.get({ workOrderId: "wo-24900" });
    expect(detail.customer).toEqual({ firstName: "Lucía", lastName: "Treviño", addressLine: "Calle Ficticia 12", neighborhood: "Las Lomitas" });
    expect(JSON.stringify(detail)).not.toMatch(/simulator\.amazonses|\+5255/);
    expect(detail.acceptanceRange).toEqual({ minDbm: -28, maxDbm: -8 });
  });

  it("[FL-080] the timeline unifies messages, transcripts, citations, turn notes, validations and decisions, plus what is pending", async () => {
    const t = await consoleTestWorld(DEMO);
    await seedStory(t);
    const timeline = await (await t.as()).orders.timeline({ workOrderId: t.world.ids.order });
    expect(timeline.entries.map((entry) => entry.type)).toEqual(["MESSAGE", "MESSAGE", "DECISION", "TURN_NOTE", "VALIDATION"]);
    expect(timeline.entries[0]).toMatchObject({ direction: "IN", transcript: { text: "la ONU no prende la luz PON" }, hasMedia: true });
    expect(timeline.entries[1]).toMatchObject({ direction: "OUT", citations: ["DIAG-02"], ruleIds: ["CP-WA-24H", "CP-CITATION"] });
    expect(timeline.pending).toEqual([{ kind: "DEFERRED_SEND", dueAtSim: "2026-10-13T10:00:00-06:00", reason: "CP-QUIET-HOURS" }]);
    // No S3 key ever reaches the browser: media travel by a presigned link only.
    expect(JSON.stringify(timeline)).not.toContain("sim/seg/upl-1");
  });

  it("[FL-080] audio and photos by a 5-minute GET link with the type fixed by the code; the certificate as a download", async () => {
    const t = await consoleTestWorld(DEMO);
    await seedStory(t);
    const console = await t.as();
    const audio = await console.orders.mediaUrl({ workOrderId: t.world.ids.order, messageId: "wa-in-0001" });
    expect(audio).toMatchObject({ contentType: "audio/ogg" });
    expect(audio.url).toContain("/s3/Media/sim/seg/upl-1");
    const photo = await console.orders.mediaUrl({ workOrderId: t.world.ids.order, evidenceId: EV });
    expect(photo.url).toContain("/s3/Evidence/photos/");
    expect(photo.url).toContain("response-content-type=image%2Fjpeg");
    expect(await refusal(console.orders.mediaUrl({ workOrderId: t.world.ids.order, messageId: "wa-out-0002" }))).toBe("NOT_FOUND");
    expect(await refusal(console.orders.certificateUrl({ workOrderId: t.world.ids.order }))).toBe("NOT_FOUND");
    await t.memory.connector.workOrders.putCertificate({ workOrderId: t.world.ids.order, clockId: t.world.clockId, certificateId: "cert-24817-1", n: 1, issuedAtSim: "2026-10-13T10:05:00-06:00", sha256: "2".repeat(64), s3Key: "certificates/wo-24817/acta-1.pdf" });
    const certificate = await console.orders.certificateUrl({ workOrderId: t.world.ids.order });
    expect(certificate.url).toContain("response-content-disposition=attachment");
  });

  it("[FL-080] the ONU in the simulated network, in range against the zone's acceptance range", async () => {
    const t = await consoleTestWorld(DEMO);
    const status = await (await t.as()).orders.onuStatus({ workOrderId: t.world.ids.order });
    expect(status).toMatchObject({ available: true, operState: "ONLINE", rxPowerDbm: -21.4, inRange: true });
    expect(t.ports.network.calls).toEqual([{ op: "status", serial: "DEMO3F2C19A0" }]);
  });

  it("[FL-081] an order of another world is refused: a guest never reads the demo's orders", async () => {
    const demo = await consoleTestWorld(DEMO);
    const guest = await consoleTestWorld(GUEST_07, demo);
    expect(await refusal((await guest.as()).orders.get({ workOrderId: demo.world.ids.order }))).toBe("FORBIDDEN");
    expect((await (await guest.as()).orders.list()).workOrders.map((row) => row.workOrderId)).toEqual([guest.world.ids.order]);
  });
});
