import type { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../lib/log";
import type { LeadConfigValue } from "../lib/secret-schemas";
import type { LeadNotifyChannel } from "./config";
import { type NotifyDeps, notifyConfirmedLead } from "./notify";
import type { LeadStore } from "./store";
import { NOTIFY_FIXTURE, T0, confirmedLead, hashOf, leadHarness, startLead } from "./testing";

const CHANNEL: LeadNotifyChannel = { identityDomain: "cuadrilla.demo.craftech.io", configurationSetName: "cuadrilla-email-test", sender: "leads@cuadrilla.demo.craftech.io" };
const CONFIG: LeadConfigValue = { notifyRecipients: [NOTIFY_FIXTURE] };

interface Harness {
  readonly store: LeadStore;
  readonly deps: NotifyDeps;
  readonly sent: SendEmailCommand["input"][];
  readonly lines: string[];
  readonly send: ReturnType<typeof vi.fn>;
}

function harness(config: LeadConfigValue = CONFIG): Harness {
  const { store } = leadHarness();
  const sent: SendEmailCommand["input"][] = [];
  const lines: string[] = [];
  const send = vi.fn(async (command: SendEmailCommand) => {
    sent.push(command.input);
    return { MessageId: `msg-${sent.length}` };
  });
  const deps: NotifyDeps = {
    store,
    ses: { send } as unknown as NotifyDeps["ses"],
    channel: () => CHANNEL,
    config: () => config,
    now: () => T0,
    stage: "poc",
    log: createLogger({ level: "debug", sink: (line) => lines.push(line) }),
  };
  return { store, deps, sent, lines, send };
}

const HOSTILE = { name: '<a href="https://phish.example.com">Ana</a>', company: "<script>alert(1)</script> https://ejemplo.com", jobTitle: "Jefa www.ejemplo.com" };

describe("notice of a new lead to Craftech [FL-116]", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("[FL-116] sends exactly one notice per confirmed lead: a retry of the stream never duplicates it", async () => {
    await confirmedLead(h.store, { contact: true, company: "Fibra Demo" });
    expect(await notifyConfirmedLead(h.deps, hashOf("ana.prueba@example.com"))).toBe("SENT");
    expect(await notifyConfirmedLead(h.deps, hashOf("ana.prueba@example.com"))).toBe("ALREADY_NOTIFIED");
    expect(h.sent).toHaveLength(1);
    const lead = await h.store.get(hashOf("ana.prueba@example.com"));
    expect(lead).toMatchObject({ notifiedAt: T0.toISOString(), notifyOutcome: "SENT" });
    expect((await h.store.listEvents(hashOf("ana.prueba@example.com"))).map((event) => event.kind)).toContain("NOTIFIED");
  });

  it("[FL-116] goes from leads@ to the fenced Craftech mailboxes, through the app's configuration set, tagged LEAD_NOTIFY", async () => {
    await confirmedLead(h.store);
    await notifyConfirmedLead(h.deps, hashOf("ana.prueba@example.com"));
    const [input] = h.sent;
    expect(input?.FromEmailAddress).toMatch(/<leads@cuadrilla\.demo\.craftech\.io>$/);
    expect(input?.Destination).toEqual({ ToAddresses: [NOTIFY_FIXTURE] });
    expect(input?.ConfigurationSetName).toBe("cuadrilla-email-test");
    expect(input?.EmailTags).toEqual([
      { Name: "kind", Value: "LEAD_NOTIFY" },
      { Name: "stage", Value: "poc" },
    ]);
  });

  it("[FL-116] never reaches a recipient outside craftech.io, even if the secret was set by hand", async () => {
    const bad = harness({ notifyRecipients: ["leads@craftech.io.evil.test"] } as LeadConfigValue);
    await confirmedLead(bad.store);
    await expect(notifyConfirmedLead(bad.deps, hashOf("ana.prueba@example.com"))).rejects.toThrow(RangeError);
    expect(bad.sent).toHaveLength(0);
    expect((await bad.store.get(hashOf("ana.prueba@example.com")))?.notifiedAt).toBeUndefined();
  });

  it("[FL-116] suppresses the leads of the QA seam (SUPPRESSED_QA) and sends nothing", async () => {
    await confirmedLead(h.store, { email: "success+qa-run-1@simulator.amazonses.com" });
    expect(await notifyConfirmedLead(h.deps, hashOf("success+qa-run-1@simulator.amazonses.com"))).toBe("SUPPRESSED_QA");
    expect(h.sent).toHaveLength(0);
    expect((await h.store.get(hashOf("success+qa-run-1@simulator.amazonses.com")))?.notifyOutcome).toBe("SUPPRESSED_QA");
  });

  it("[FL-116] does nothing for a lead that is not confirmed", async () => {
    await startLead(h.store);
    expect(await notifyConfirmedLead(h.deps, hashOf("ana.prueba@example.com"))).toBe("NOT_CONFIRMED");
    expect(await notifyConfirmedLead(h.deps, hashOf("nadie@example.com"))).toBe("NOT_CONFIRMED");
    expect(h.sent).toHaveLength(0);
  });

  it("[FL-116] escapes the visitor's fields, turns nothing into a link and neutralizes every domain, under 'sin verificar'", async () => {
    await confirmedLead(h.store, HOSTILE);
    await notifyConfirmedLead(h.deps, hashOf("ana.prueba@example.com"));
    const simple = h.sent[0]?.Content?.Simple;
    const text = simple?.Body?.Text?.Data ?? "";
    const html = simple?.Body?.Html?.Data ?? "";
    expect(text).toContain("Datos declarados por el visitante, sin verificar:");
    expect(text).toContain("ejemplo[.]com");
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toContain("ejemplo.com");
    expect(html).not.toMatch(/<a[\s>]/i);
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toMatch(/https?:\/\//);
    expect(simple?.Subject?.Data).not.toContain("<script>");
  });

  it("[FL-116] without the contact consent, the subject and the first line say NO CONTACTAR", async () => {
    await confirmedLead(h.store, { contact: false, company: "Fibra Demo" });
    await notifyConfirmedLead(h.deps, hashOf("ana.prueba@example.com"));
    const simple = h.sent[0]?.Content?.Simple;
    expect(simple?.Subject?.Data?.startsWith("NO CONTACTAR · ")).toBe(true);
    expect(simple?.Body?.Text?.Data?.split("\n")[0]).toMatch(/^NO CONTACTAR/);
  });

  it("[FL-116] a failed send gives the claim back (FAILED) and throws, so the stream retries and sends once", async () => {
    await confirmedLead(h.store);
    h.send.mockRejectedValueOnce(Object.assign(new Error("throttled"), { name: "TooManyRequestsException" }));
    await expect(notifyConfirmedLead(h.deps, hashOf("ana.prueba@example.com"))).rejects.toThrow("throttled");
    expect((await h.store.get(hashOf("ana.prueba@example.com")))).toMatchObject({ notifyOutcome: "FAILED" });
    expect(h.lines.some((line) => line.includes('"metric":"LeadNotifyFailures"'))).toBe(true);
    expect(await notifyConfirmedLead(h.deps, hashOf("ana.prueba@example.com"))).toBe("SENT");
    expect(h.send).toHaveBeenCalledTimes(2);
  });

  it("[FL-116] never writes the lead's email in a log line (only the leadId and emailHash[0:8])", async () => {
    await confirmedLead(h.store, { email: "Ana.Prueba@Example.com" });
    await notifyConfirmedLead(h.deps, hashOf("ana.prueba@example.com"));
    const all = h.lines.join("\n");
    expect(all).not.toMatch(/ana\.prueba/i);
    expect(all).not.toContain("@example.com");
    expect(all).toContain(hashOf("ana.prueba@example.com").slice(0, 8));
    expect(all).not.toContain(hashOf("ana.prueba@example.com"));
  });
});

describe("the notice as the reference of an erasure [FL-118]", () => {
  it("[FL-118] carries the leadId, so the operator finds and deletes it from the mailboxes after a deletion", async () => {
    const h = harness();
    const lead = await confirmedLead(h.store);
    await notifyConfirmedLead(h.deps, hashOf("ana.prueba@example.com"));
    expect(h.sent[0]?.Content?.Simple?.Body?.Text?.Data).toContain(`Referencia: ${lead.leadId}`);
  });
});
