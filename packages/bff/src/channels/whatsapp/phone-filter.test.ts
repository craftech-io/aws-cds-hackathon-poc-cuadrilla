import { describe, expect, it } from "vitest";
import { foreignProbeId } from "../../connector/keys";
import { createLogger } from "../../lib/log";
import { phoneNumberArn } from "./config";
import { processInboundEvent } from "./inbound";
import { type PhoneFilterDeps, recordForeign, screenRecord } from "./phone-filter";
import { buildSimulatedEvent } from "./sim-envelope";
import {
  AWS_ID,
  DEMO,
  FOREIGN_META_ID,
  JUDGE,
  META_ID,
  PEOPLE,
  SIM_KEY,
  inboundHarness,
  liveEvent,
  liveRecord,
  recorder,
  signSns,
  testVerifier,
  waText,
} from "./testing";

const ROGELIO = PEOPLE.rogelio.phone;
const text = waText(ROGELIO, "wamid.HBgMNTI1NTAxMDEwMDAxFQIAEhgUM0EwRkI0RDg3QjM1MUI5N0Y4RjEA", "La ONU no prende la luz PON");

function deps(overrides: Partial<PhoneFilterDeps> = {}): PhoneFilterDeps {
  return {
    verifier: testVerifier(),
    simEnvelopeKey: SIM_KEY,
    numberIds: () => ({ phoneNumberId: AWS_ID, metaPhoneNumberId: META_ID }),
    stageTransports: () => ["simulated", "live"],
    worldMode: async (clockId) => (clockId === JUDGE ? "simulated" : clockId === DEMO ? "live" : undefined),
    ...overrides,
  };
}

function simulated(clockId: string, key: Uint8Array = SIM_KEY) {
  const [record] = buildSimulatedEvent({ clockId, from: PEOPLE.rogelioJ07.phone, wamid: "wamid.SIM.01J9ZQX0000000000000000001", content: { type: "text", body: "hola" }, sentAtReal: new Date("2026-10-13T15:20:00Z") }, key).Records;
  if (record === undefined) throw new Error("no record");
  return record;
}

describe("number filter with the real shape of the event", () => {
  it("[FL-091] [FL-095] lets our own event through: our Meta id with the ARN of our AWS id, in the envelope and in every change", async () => {
    expect(META_ID).not.toBe(AWS_ID);
    const result = await screenRecord(liveRecord({ messages: [text] }), deps());
    expect(result).toMatchObject({ verdict: "ACCEPT", origin: "LIVE" });
    if (result.verdict === "ACCEPT") expect(result.entry.changes[0]?.value.messages).toHaveLength(1);
  });

  it("[FL-095] discards a fixture carrying the AWS id where the Meta id goes: a filter comparing with the AWS id would have let it in", async () => {
    const result = await screenRecord(liveRecord({ messages: [text], contextMetaId: AWS_ID, changeMetaId: AWS_ID }), deps());
    expect(result).toMatchObject({ verdict: "FOREIGN", reason: "ENVELOPE_NUMBER" });
  });

  it("[FL-095] treats our Meta id with another number's ARN, or another account's, as foreign", async () => {
    const otherNumber = phoneNumberArn("phone-number-id-ffffffffffffffffffffffffffffffff");
    const otherAccount = `arn:aws:social-messaging:us-east-1:111122223333:phone-number-id/${AWS_ID.slice("phone-number-id-".length)}`;
    for (const contextArn of [otherNumber, otherAccount]) {
      expect(await screenRecord(liveRecord({ messages: [text], contextArn }), deps())).toMatchObject({ verdict: "FOREIGN", reason: "ENVELOPE_NUMBER" });
    }
    expect(await screenRecord(liveRecord({ messages: [text], contextMetaId: FOREIGN_META_ID }), deps())).toMatchObject({ verdict: "FOREIGN", metaIdTail: "9876" });
  });

  it("[FL-095] checks every change: another metadata.phone_number_id, or none, is foreign", async () => {
    expect(await screenRecord(liveRecord({ messages: [text], changeMetaId: FOREIGN_META_ID }), deps())).toMatchObject({ verdict: "FOREIGN", reason: "CHANGE_NUMBER", metaIdTail: "9876" });
    expect(await screenRecord(liveRecord({ messages: [text], changeMetaId: null }), deps())).toMatchObject({ verdict: "FOREIGN", reason: "CHANGE_WITHOUT_METADATA" });
  });

  it("[FL-095] discards qa-foreign=1 always, also before P-01 when the stage has no live transport", async () => {
    const record = liveRecord({ messages: [text], contextMetaId: FOREIGN_META_ID, attributes: { "qa-foreign": "1" } });
    expect(await screenRecord(record, deps({ stageTransports: () => ["simulated"] }))).toMatchObject({ verdict: "FOREIGN", reason: "QA_FOREIGN", metaIdTail: "9876" });
    expect(await screenRecord(liveRecord({ messages: [text], attributes: { "qa-foreign": "1" } }), deps())).toMatchObject({ verdict: "FOREIGN", reason: "QA_FOREIGN" });
  });

  it("[FL-095] everything is foreign while the number is not connected (P-01 open)", async () => {
    expect(await screenRecord(liveRecord({ messages: [text] }), deps({ numberIds: () => undefined }))).toMatchObject({ verdict: "FOREIGN" });
  });

  it("[FL-091] rejects a SigningCertURL of any other host or scheme, SignatureVersion 1 and a tampered message", async () => {
    for (const certUrl of ["https://sns.us-east-1.amazonaws.com.attacker.example/cert.pem", "http://sns.us-east-1.amazonaws.com/cert.pem", "https://sns.us-west-2.amazonaws.com/cert.pem", "https://sns.us-east-1.amazonaws.com:8443/cert.pem"]) {
      expect(await screenRecord(liveRecord({ messages: [text], certUrl }), deps())).toEqual({ verdict: "REJECT", reason: "BAD_CERT_URL" });
    }
    const record = liveRecord({ messages: [text] });
    expect(await screenRecord({ ...record, Sns: { ...record.Sns, SignatureVersion: "1" } }, deps())).toEqual({ verdict: "REJECT", reason: "BAD_SIGNATURE_VERSION" });
    expect(await screenRecord({ ...record, Sns: { ...record.Sns, Message: record.Sns.Message.replace("La ONU", "Tu ONU") } }, deps())).toEqual({ verdict: "REJECT", reason: "BAD_SIGNATURE" });
  });

  it("[FL-091] needs the live transport in the stage for a live event of our number", async () => {
    expect(await screenRecord(liveRecord({ messages: [text] }), deps({ stageTransports: () => ["simulated"] }))).toEqual({ verdict: "REJECT", reason: "LIVE_TRANSPORT_DISABLED" });
  });

  it("[FL-095] accepts a signed simulated envelope only from a simulated world, and never a forged one", async () => {
    expect(await screenRecord(simulated(JUDGE), deps())).toMatchObject({ verdict: "ACCEPT", origin: "SIMULATED", clockId: JUDGE });
    expect(await screenRecord(simulated(DEMO), deps())).toEqual({ verdict: "REJECT", reason: "SIM_WORLD_NOT_SIMULATED" });
    expect(await screenRecord(simulated("JUDGE#isp-judge-09"), deps())).toEqual({ verdict: "REJECT", reason: "SIM_WORLD_NOT_SIMULATED" });
    expect(await screenRecord(simulated(JUDGE, new Uint8Array(32).fill(1)), deps())).toEqual({ verdict: "REJECT", reason: "BAD_SIM_SIGNATURE" });
    const record = simulated(JUDGE);
    const moved = { ...record, Sns: { ...record.Sns, MessageAttributes: { "sim-clock-id": { Type: "String", Value: "JUDGE#isp-judge-08" } } } };
    expect(await screenRecord(moved, deps())).toEqual({ verdict: "REJECT", reason: "BAD_SIM_SIGNATURE" });
  });

  it("[FL-095] never throws, whatever arrives", async () => {
    const record = liveRecord({ messages: [text] });
    const inputs: unknown[] = [null, 42, {}, { Sns: {} }, { Sns: { ...record.Sns, Message: "{not json" } }];
    for (const input of inputs) await expect(screenRecord(input, deps())).resolves.toMatchObject({ verdict: expect.stringMatching(/REJECT|RETRY/) });
    const failing = deps({ verifier: { verify: async () => Promise.reject(new Error("boom")) } });
    await expect(screenRecord(record, failing)).resolves.toEqual({ verdict: "RETRY", reason: "SCREEN_FAILED" });
    await expect(screenRecord(simulated(JUDGE), deps({ worldMode: async () => Promise.reject(new Error("down")) }))).resolves.toEqual({ verdict: "RETRY", reason: "WORLD_MODE_UNAVAILABLE" });
    const body = JSON.parse(record.Sns.Message) as Record<string, unknown>;
    const { Signature: _signature, ...unsigned } = record.Sns;
    const brokenEntry = { ...record, Sns: signSns({ ...unsigned, Message: JSON.stringify({ ...body, whatsAppWebhookEntry: "{broken" }) }) };
    await expect(screenRecord(brokenEntry, deps())).resolves.toEqual({ verdict: "REJECT", reason: "MALFORMED_ENTRY" });
  });
});

describe("what a foreign event leaves", () => {
  it("[FL-095] writes only the id-and-time probe and the metric with the last four digits, and logs no content", async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "debug", sink: (line) => void lines.push(line) });
    const rec = recorder();
    const probes: Array<{ id: string; detail: unknown }> = [];
    const worlds = { putProbe: async (id: string, detail?: object) => (probes.push({ id, detail }), true) };
    const screened = await screenRecord(liveRecord({ messages: [text], contextMetaId: FOREIGN_META_ID, messageId: "a1b2c3d4-0000-4000-8000-00000000f095" }), deps());
    if (screened.verdict !== "FOREIGN") throw new Error("expected a foreign event");
    await recordForeign(screened, { worlds, metrics: { count: (metric, dimensions = {}) => void rec.metrics.push({ metric, dimensions }) }, logger });
    expect(probes).toEqual([{ id: foreignProbeId("a1b2c3d4-0000-4000-8000-00000000f095"), detail: { reason: "ENVELOPE_NUMBER" } }]);
    expect(rec.metrics).toEqual([{ metric: "ForeignPhoneNumberEvents", dimensions: { metaPhoneNumberId: "9876" } }]);
    const logged = lines.join("\n");
    expect(logged).not.toContain("ONU");
    expect(logged).not.toContain(ROGELIO.slice(1));
    expect(logged).not.toContain(FOREIGN_META_ID);
  });

  it("[FL-095] ends in success without effects: no message, no queue, no reply, only the probe", async () => {
    const { world, rec, deps: inbound } = await inboundHarness();
    const result = await processInboundEvent(liveEvent({ messages: [text], changeMetaId: FOREIGN_META_ID, messageId: "a1b2c3d4-0000-4000-8000-00000000f096" }), inbound);
    expect(result).toEqual({ records: [{ verdict: "FOREIGN", reason: "CHANGE_NUMBER", messages: [], statuses: [] }], retry: false });
    expect(await world.connector.worlds.getProbe(foreignProbeId("a1b2c3d4-0000-4000-8000-00000000f096"))).toBeDefined();
    expect(await world.connector.conversations.listMessages(PEOPLE.rogelio.personId)).toEqual([]);
    expect(rec.queued).toEqual([]);
    expect(rec.notices).toEqual([]);
  });
});
