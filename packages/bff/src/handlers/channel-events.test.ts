import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyEmailEvent } from "../channels/email/events";
import { BOUNCE_CUSTOMER, COMPLAINT_CUSTOMER, CUSTOMER, EMAIL_CONFIG, ZONE_CHIEF, alertRequest, certificateRequest, emailWorld } from "../channels/email/testing";
import { workOrder } from "../connector/testing";
import { captureLogger, queuedBodies, recordingSender, recordingSink } from "../feeds/testing";
import { EmailEventEvent } from "../worker/events";
import { configurationSetOf, createChannelEventsHandler } from "./channel-events";

type Fixture = Record<string, unknown> & { detail: { eventType: string; mail: { messageId: string; tags: Record<string, string[]> } } };

function fixture(name: string): Fixture {
  return JSON.parse(readFileSync(new URL(`../channels/email/fixtures/${name}.json`, import.meta.url), "utf8")) as Fixture;
}

const ADDRESSES = [CUSTOMER, BOUNCE_CUSTOMER, COMPLAINT_CUSTOMER, ZONE_CHIEF, "lead-mailbox@craftech.io"];

/** A world where `send` went out with the fixture's SES id, its orders, and the entry over a recording queue. */
async function entry(name: string, send: "certificate" | "alert" = "certificate", overrides: Parameters<typeof certificateRequest>[1] = {}) {
  const world = await emailWorld({ messageIds: [fixture(name).detail.mail.messageId] });
  for (const [id, number] of [["wo-24817", "24817"], ["wo-24819", "24819"], ["wo-24831", "24831"]] as const) {
    await world.connector.workOrders.createWorkOrder(workOrder({ workOrderId: id, workOrderNumber: number, customerId: `cust-1${number.slice(1)}` }));
  }
  const outcome = await world.client.send(send === "certificate" ? certificateRequest(world.clockId, overrides) : alertRequest(world.clockId));
  if (!outcome.ok) throw new Error(`send failed: ${outcome.reason}`);
  const sender = recordingSender();
  const { logger, lines } = captureLogger();
  const queue = recordingSink(world.connector, sender);
  const handler = createChannelEventsHandler(() => ({ connector: world.connector, queue, configurationSetName: EMAIL_CONFIG.configurationSetName, logger }), () => logger);
  const pending = async () => (await world.connector.worlds.listPendingMail(world.clockId)).open.length;
  const inFlight = async () => (await world.connector.worlds.getInstallerState("inst-rogelio"))?.inFlight ?? [];
  const outbox = async () => (await world.connector.conversations.listOutbox("isp-demo"))[0];
  /** What the worker's `apply_email_event` starts from: the queued record. */
  const queuedRecord = (index = 0) => EmailEventEvent.parse(queuedBodies(sender)[index]).record;
  return { world, sender, handler, lines, pending, inFlight, outbox, queuedRecord };
}

describe("ChannelEvents entry", () => {
  it("is fenced to the stage's configuration set", () => {
    expect(configurationSetOf("poc")).toBe(EMAIL_CONFIG.configurationSetName);
  });

  it("[FL-048] a delivered certificate becomes EMAIL_EVENT on the installer's group, then the pending mark closes with the world busy", async () => {
    const h = await entry("ses-delivery");
    expect(await h.pending()).toBe(1);
    expect(await h.handler(fixture("ses-delivery"))).toEqual({ status: "QUEUED" });
    expect(h.sender.messages).toEqual([{ body: expect.any(String), groupId: "inst-rogelio", deduplicationId: expect.stringMatching(/^ses-[0-9a-f]{40}$/) }]);
    expect(EmailEventEvent.parse(queuedBodies(h.sender)[0])).toEqual({
      type: "EMAIL_EVENT",
      eventId: h.sender.messages[0]?.deduplicationId,
      clockId: "GLOBAL#isp-demo",
      ispId: "isp-demo",
      installerId: "inst-rogelio",
      record: {
        type: "DELIVERY",
        providerMessageId: fixture("ses-delivery").detail.mail.messageId,
        atReal: "2026-10-13T13:00:02.874Z",
        ispId: "isp-demo",
        clockId: "GLOBAL#isp-demo",
        mailId: "mail-test-001",
        kind: "CERTIFICATE_EMAIL",
        workOrderId: "wo-24817",
      },
    });
    expect(await h.pending()).toBe(0);
    expect(await h.inFlight()).toEqual([h.sender.messages[0]?.deduplicationId]);
    expect((await h.outbox())?.status).toBe("SENT");
    expect(await applyEmailEvent(h.world.connector, h.queuedRecord())).toMatchObject({ applied: true, status: "DELIVERED", changed: true, effect: "NONE" });
  });

  it("[FL-048] a Send is applied here and never queued; a redelivered Delivery is a duplicate that marks nothing busy", async () => {
    const h = await entry("ses-delivery");
    expect(await h.handler(fixture("ses-send"))).toEqual({ status: "SENT_APPLIED" });
    expect(h.sender.messages).toEqual([]);
    expect(await h.pending()).toBe(1);
    expect((await h.outbox())?.events.map((event) => event.type)).toEqual(["SEND"]);
    expect(await h.handler(fixture("ses-delivery"))).toEqual({ status: "QUEUED" });
    const busy = [...(await h.inFlight())];
    expect(await h.handler(fixture("ses-delivery"))).toEqual({ status: "DUPLICATE" });
    expect(h.sender.messages).toHaveLength(1);
    expect(await h.inFlight()).toEqual(busy);
  });

  it("[FL-051] a permanent bounce of the certificate reaches the worker, whose apply asks for the console-only case", async () => {
    const h = await entry("ses-bounce-permanent", "certificate", { to: BOUNCE_CUSTOMER, workOrderId: "wo-24831" });
    expect(await h.handler(fixture("ses-bounce-permanent"))).toEqual({ status: "QUEUED" });
    expect(h.queuedRecord()).toMatchObject({ type: "BOUNCE", bounceType: "Permanent", workOrderId: "wo-24831" });
    expect(await applyEmailEvent(h.world.connector, h.queuedRecord())).toMatchObject({ status: "BOUNCED", effect: "CERTIFICATE_UNDELIVERED" });
  });

  it("queues a transient bounce and a delivered alert on the group of their order's installer", async () => {
    const transient = await entry("ses-bounce-transient");
    expect(await transient.handler(fixture("ses-bounce-transient"))).toEqual({ status: "QUEUED" });
    expect(await applyEmailEvent(transient.world.connector, transient.queuedRecord())).toMatchObject({ status: "DELAYED", effect: "SCHEDULE_CERT_RETRY" });
    const alert = await entry("ses-alert-delivery", "alert");
    expect(await alert.handler(fixture("ses-alert-delivery"))).toEqual({ status: "QUEUED" });
    expect(alert.queuedRecord()).toMatchObject({ kind: "ZONE_CHIEF_ALERT", workOrderId: "wo-24819" });
    expect(await applyEmailEvent(alert.world.connector, alert.queuedRecord())).toMatchObject({ effect: "ALERT_DELIVERED", deliveryLatencyMs: 6_500 });
  });

  it("throws when the queue fails (EventBridge retries), with the pending mark still open and the world quiet", async () => {
    const h = await entry("ses-bounce-transient");
    h.sender.failNext();
    await expect(h.handler(fixture("ses-bounce-transient"))).rejects.toThrow("SendMessage failed");
    expect(await h.inFlight()).toEqual([]);
    expect(await h.pending()).toBe(1);
    expect(await h.handler(fixture("ses-bounce-transient"))).toEqual({ status: "QUEUED" });
    expect(await h.pending()).toBe(0);
  });

  it("never queues an email without EmailTags.workOrderId, but still moves its outbox row and closes its pending mark", async () => {
    const h = await entry("ses-delivery");
    const event = fixture("ses-delivery");
    delete event.detail.mail.tags.workOrderId;
    expect(await h.handler(event)).toEqual({ status: "NO_WORK_ORDER" });
    expect(h.sender.messages).toEqual([]);
    expect(await h.pending()).toBe(0);
    expect((await h.outbox())?.status).toBe("DELIVERED");
    const unknownOrder = fixture("ses-bounce-transient");
    unknownOrder.detail.mail.tags.workOrderId = ["wo-24890"];
    expect(await h.handler(unknownOrder)).toEqual({ status: "UNKNOWN_MAIL" });
    expect(h.sender.messages).toEqual([]);
  });

  it("ignores Cognito's untagged emails and other configuration sets; a failed lead notice only adds LeadNotifyFailures", async () => {
    const h = await entry("ses-delivery");
    const cognito = fixture("ses-bounce-permanent");
    cognito.detail.mail.tags = { "ses:configuration-set": [EMAIL_CONFIG.configurationSetName] };
    expect(await h.handler(cognito)).toEqual({ status: "IGNORED" });
    const foreign = fixture("ses-delivery");
    foreign.detail.mail.tags["ses:configuration-set"] = ["another-app-email-poc"];
    expect(await h.handler(foreign)).toEqual({ status: "IGNORED" });
    const lead = fixture("ses-bounce-permanent");
    lead.detail.mail.tags = { "ses:configuration-set": [EMAIL_CONFIG.configurationSetName], kind: ["LEAD_NOTIFY"], stage: ["poc"] };
    Object.assign(lead.detail, { bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "lead-mailbox@craftech.io" }] } });
    expect(await h.handler(lead)).toEqual({ status: "LEAD_NOTICE_FAILURE" });
    const delivered = fixture("ses-delivery");
    delivered.detail.mail.tags = { "ses:configuration-set": [EMAIL_CONFIG.configurationSetName], kind: ["LEAD_NOTIFY"] };
    expect(await h.handler(delivered)).toEqual({ status: "IGNORED" });
    expect(h.sender.messages).toEqual([]);
    expect(h.lines.filter((line) => line.includes('"metric":"LeadNotifyFailures"'))).toHaveLength(1);
  });

  it("never writes an address to a log line nor to the queue", async () => {
    const h = await entry("ses-bounce-permanent", "certificate", { to: BOUNCE_CUSTOMER, workOrderId: "wo-24831" });
    await h.handler(fixture("ses-bounce-permanent"));
    await h.handler({ source: "aws.ses", detail: { eventType: "Bounce", mail: { tags: { kind: ["LEAD_NOTIFY"] }, destination: [BOUNCE_CUSTOMER] } } });
    const written = [...h.lines, ...h.sender.messages.map((message) => message.body)].join("\n");
    for (const address of ADDRESSES) expect(written).not.toContain(address);
  });
});
