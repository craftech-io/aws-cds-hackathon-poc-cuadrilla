import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type EmailEventRecord, applyEmailEvent, effectOf, nextStatus, parseSesEvent, statusOfEvent } from "./events";
import { BOUNCE_CUSTOMER, COMPLAINT_CUSTOMER, EMAIL_CONFIG, alertRequest, certificateRequest, emailWorld } from "./testing";

type Fixture = Record<string, unknown> & { detail: { mail: { messageId: string; tags: Record<string, string[]> } } };

function fixture(name: string): Fixture {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")) as Fixture;
}

function record(name: string): EmailEventRecord {
  const parsed = parseSesEvent(fixture(name), EMAIL_CONFIG.configurationSetName);
  if (!parsed.ok) throw new Error(`fixture ${name} ignored: ${parsed.ignored}`);
  return parsed.record;
}

/** A world where the fixture's email was sent, with the fixture's SES message id. */
async function sentWorld(name: string, overrides: Parameters<typeof certificateRequest>[1] = {}) {
  const world = await emailWorld({ messageIds: [fixture(name).detail.mail.messageId] });
  const outcome = await world.client.send(certificateRequest(world.clockId, overrides));
  if (!outcome.ok) throw new Error(`send failed: ${outcome.reason}`);
  return { ...world, apply: (event: string) => applyEmailEvent(world.connector, record(event)), mail: async () => (await world.connector.conversations.listOutbox(world.ispId))[0] };
}

describe("parseSesEvent", () => {
  it("reads our tags back from a delivery of the configuration set", () => {
    expect(record("ses-delivery")).toEqual({
      type: "DELIVERY",
      providerMessageId: "0100019a2b3c4d5e-11111111-2222-3333-4444-555555555501-000000",
      atReal: "2026-10-13T13:00:02.874Z",
      ispId: "isp-demo",
      clockId: "GLOBAL#isp-demo",
      mailId: "mail-test-001",
      kind: "CERTIFICATE_EMAIL",
      workOrderId: "wo-24817",
    });
    expect(record("ses-bounce-permanent")).toMatchObject({ type: "BOUNCE", bounceType: "Permanent", detail: "General", workOrderId: "wo-24831" });
    expect(record("ses-delivery-delay")).toMatchObject({ type: "DELIVERY_DELAY", detail: "TransientCommunicationFailure" });
  });

  it("ignores opens, other configuration sets and emails without our tags, and never throws", () => {
    const open = fixture("ses-delivery");
    Object.assign(open.detail, { eventType: "Open" });
    expect(parseSesEvent(open, EMAIL_CONFIG.configurationSetName)).toEqual({ ok: false, ignored: "UNTRACKED_TYPE" });
    const foreign = fixture("ses-delivery");
    foreign.detail.mail.tags["ses:configuration-set"] = ["another-app-email-poc"];
    expect(parseSesEvent(foreign, EMAIL_CONFIG.configurationSetName)).toEqual({ ok: false, ignored: "FOREIGN_CONFIGURATION_SET" });
    const untagged = fixture("ses-delivery");
    untagged.detail.mail.tags = { "ses:configuration-set": [EMAIL_CONFIG.configurationSetName] };
    expect(parseSesEvent(untagged, EMAIL_CONFIG.configurationSetName)).toEqual({ ok: false, ignored: "FOREIGN_TAGS" });
    expect(parseSesEvent({ source: "aws.sns" }, EMAIL_CONFIG.configurationSetName)).toEqual({ ok: false, ignored: "MALFORMED" });
    expect(parseSesEvent("not an event", EMAIL_CONFIG.configurationSetName)).toEqual({ ok: false, ignored: "MALFORMED" });
  });
});

describe("states", () => {
  it("maps every event to its status and never moves backwards", () => {
    expect(statusOfEvent("BOUNCE", "Permanent")).toBe("BOUNCED");
    expect(statusOfEvent("BOUNCE", "Transient")).toBe("DELAYED");
    expect(statusOfEvent("RENDERING_FAILURE")).toBe("FAILED");
    expect(nextStatus("DELIVERED", "SENT")).toBe("DELIVERED");
    expect(nextStatus("DELIVERED", "DELAYED")).toBe("DELIVERED");
    expect(nextStatus("DELIVERED", "COMPLAINED")).toBe("COMPLAINED");
    expect(nextStatus("DELAYED", "BOUNCED")).toBe("BOUNCED");
    expect(nextStatus("BOUNCED", "DELIVERED")).toBe("BOUNCED");
  });

  it("derives the effect from the kind of email", () => {
    expect(effectOf("CERTIFICATE_EMAIL", "DELAYED")).toBe("SCHEDULE_CERT_RETRY");
    expect(effectOf("ZONE_CHIEF_ALERT", "DELAYED")).toBe("NONE");
    expect(effectOf("ZONE_CHIEF_ALERT", "BOUNCED")).toBe("ALERT_UNDELIVERED");
    expect(effectOf("CERTIFICATE_EMAIL", "FAILED")).toBe("ALARM");
  });
});

describe("applyEmailEvent", () => {
  it("delivers: the outbox row moves to DELIVERED with the event and the world's pending mark closes", async () => {
    const world = await sentWorld("ses-delivery");
    expect((await world.connector.worlds.listPendingMail(world.clockId)).open).toHaveLength(1);
    const send = await world.apply("ses-send");
    expect(send).toMatchObject({ applied: true, status: "SENT", changed: false, effect: "NONE" });
    expect((await world.connector.worlds.listPendingMail(world.clockId)).open).toHaveLength(1);
    const delivered = await world.apply("ses-delivery");
    expect(delivered).toMatchObject({ applied: true, previous: "SENT", status: "DELIVERED", changed: true, effect: "NONE", deliveryStatus: "DELIVERED" });
    expect(await world.mail()).toMatchObject({ status: "DELIVERED", events: [{ type: "SEND" }, { type: "DELIVERY", atReal: "2026-10-13T13:00:02.874Z" }] });
    expect((await world.connector.worlds.listPendingMail(world.clockId)).open).toEqual([]);
    expect(await world.apply("ses-send")).toMatchObject({ status: "DELIVERED", changed: false });
  });

  it("measures when the zone chief got the alert (SafetyAlertLatency)", async () => {
    const world = await emailWorld({ messageIds: [fixture("ses-alert-delivery").detail.mail.messageId] });
    await world.client.send(alertRequest(world.clockId));
    const outcome = await applyEmailEvent(world.connector, record("ses-alert-delivery"));
    expect(outcome).toMatchObject({ applied: true, status: "DELIVERED", effect: "ALERT_DELIVERED", deliveryLatencyMs: 6_500 });
  });

  it("asks for one certificate retry on a transient bounce or a delay, not on a second delay", async () => {
    const world = await sentWorld("ses-bounce-transient");
    expect(await world.apply("ses-bounce-transient")).toMatchObject({ status: "DELAYED", effect: "SCHEDULE_CERT_RETRY", deliveryStatus: "DELAYED" });
    expect(await world.apply("ses-bounce-transient")).toMatchObject({ status: "DELAYED", changed: false, effect: "NONE" });
  });

  it("raises an alarm on a rejected email", async () => {
    const world = await sentWorld("ses-reject");
    expect(await world.apply("ses-reject")).toMatchObject({ status: "FAILED", effect: "ALARM" });
  });

  it("ignores an event whose mail is not in the outbox or whose SES id is another one", async () => {
    const world = await emailWorld();
    expect(await applyEmailEvent(world.connector, record("ses-delivery"))).toEqual({ applied: false, reason: "UNKNOWN_MAIL" });
    await world.client.send(certificateRequest(world.clockId));
    expect(await applyEmailEvent(world.connector, { ...record("ses-delivery"), providerMessageId: "0100019a2b3c4d5e-another-000000" })).toEqual({ applied: false, reason: "OTHER_MESSAGE" });
  });
});

describe("bounce or complaint of the certificate email [FL-051]", () => {
  it("[FL-051] a permanent bounce marks the delivery BOUNCED and asks for the console-only case, once", async () => {
    const world = await sentWorld("ses-bounce-permanent", { to: BOUNCE_CUSTOMER, workOrderId: "wo-24831" });
    const outcome = await world.apply("ses-bounce-permanent");
    expect(outcome).toMatchObject({ applied: true, status: "BOUNCED", deliveryStatus: "BOUNCED", effect: "CERTIFICATE_UNDELIVERED" });
    expect(await world.mail()).toMatchObject({ status: "BOUNCED", workOrderId: "wo-24831" });
    expect(await world.apply("ses-bounce-permanent")).toMatchObject({ changed: false, effect: "NONE" });
  });

  it("[FL-051] a complaint marks the delivery COMPLAINED and asks for the case", async () => {
    const world = await sentWorld("ses-complaint", { to: COMPLAINT_CUSTOMER, workOrderId: "wo-24832" });
    const outcome = await world.apply("ses-complaint");
    expect(outcome).toMatchObject({ status: "COMPLAINED", deliveryStatus: "COMPLAINED", effect: "CERTIFICATE_UNDELIVERED" });
    expect(outcome).not.toHaveProperty("deliveryLatencyMs");
  });

  it("[FL-051] never sends automatically again to an address that bounced or complained", async () => {
    for (const [event, to, workOrderId] of [["ses-bounce-permanent", BOUNCE_CUSTOMER, "wo-24831"], ["ses-complaint", COMPLAINT_CUSTOMER, "wo-24832"]] as const) {
      const world = await sentWorld(event, { to, workOrderId });
      await world.apply(event);
      const retry = await world.client.send(certificateRequest(world.clockId, { to, workOrderId, mailId: "mail-cert-retry" }));
      expect(retry).toEqual({ ok: false, code: "RECIPIENT_NOT_ALLOWED", reason: "SUPPRESSED", retryable: false });
      expect(world.sent()).toHaveLength(1);
      const denials = await world.connector.audit.listByDecision(world.ispId, "DENY");
      expect(denials).toEqual([expect.objectContaining({ ruleIds: ["CP-RECIPIENT-FENCE"], reason: "SUPPRESSED" })]);
    }
  });
});
