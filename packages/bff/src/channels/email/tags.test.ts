import { describe, expect, it } from "vitest";
import { IspId, MessageKind, WorkOrderId, clockIdOfIsp } from "@cuadrilla/shared";
import type { EmailChannelConfig } from "./config";
import { buildSendEmailInput, type EmailSendRequest } from "./request";
import { MAX_TAG_LENGTH, emailTags, normalizeTagValue } from "./tags";

const CONFIG: EmailChannelConfig = { identityDomain: "cuadrilla.demo.craftech.io", configurationSetName: "aws-cds-hackathon-poc-cuadrilla-email-poc", evidenceBucket: "evidence-bucket", stage: "poc" };
const SES_TAG = /^[A-Za-z0-9_-]{1,256}$/;

// Operators and orders of every kind of world (docs/seed-spec.md §2-§3).
const WORLDS = [
  { ispId: "isp-demo", workOrderId: "wo-24817" },
  { ispId: "isp-guest-07", workOrderId: "wo-24817-g07" },
  { ispId: "isp-guest-test", workOrderId: "wo-24817-gtest" },
  { ispId: "isp-qa-812-1-sc-05", workOrderId: "wo-70012" },
  { ispId: "isp-eval-812-1", workOrderId: "wo-80001" },
];

describe("normalizeTagValue", () => {
  it("turns every character SES refuses into '-', clips at 256 and never answers empty", () => {
    expect(normalizeTagValue("GLOBAL#isp-demo")).toBe("GLOBAL-isp-demo");
    expect(normalizeTagValue("GUEST#isp-guest-07")).toBe("GUEST-isp-guest-07");
    expect(normalizeTagValue("wamid.HBgM=+/x")).toBe("wamid-HBgM---x");
    expect(normalizeTagValue("señal @ 2026-10-13T15:20:00Z")).toBe("se-al---2026-10-13T15-20-00Z");
    expect(normalizeTagValue("x".repeat(300))).toHaveLength(MAX_TAG_LENGTH);
    expect(normalizeTagValue("")).toBe("-");
  });
});

describe("emailTags", () => {
  it.each(WORLDS)("keeps the ids of $ispId unchanged, so an SES event parses back to the same ids", ({ ispId, workOrderId }) => {
    const tags = emailTags({ ispId, workOrderId, mailId: "mail-01K5B7Q2N6ZC3V8X4R1T9M0PDE", kind: "CERTIFICATE_EMAIL", stage: "poc" });
    expect(tags).toEqual([
      { Name: "ispId", Value: ispId },
      { Name: "workOrderId", Value: workOrderId },
      { Name: "mailId", Value: "mail-01K5B7Q2N6ZC3V8X4R1T9M0PDE" },
      { Name: "kind", Value: "CERTIFICATE_EMAIL" },
      { Name: "stage", Value: "poc" },
    ]);
    for (const tag of tags) expect(tag.Value).toMatch(SES_TAG);
    expect(IspId.parse(tags[0]?.Value)).toBe(ispId);
    expect(WorkOrderId.parse(tags[1]?.Value)).toBe(workOrderId);
    expect(MessageKind.parse(tags[3]?.Value)).toBe("CERTIFICATE_EMAIL");
  });

  it("normalizes a clock id of the demo and of a guest world should one ever travel as a tag", () => {
    for (const { ispId } of WORLDS) {
      const [tag] = emailTags({ ispId: clockIdOfIsp(ispId) });
      expect(tag?.Value).toMatch(SES_TAG);
    }
    expect(emailTags({ ispId: "GLOBAL#isp-demo", workOrderId: undefined })).toEqual([{ Name: "ispId", Value: "GLOBAL-isp-demo" }]);
  });
});

describe("SendEmail content", () => {
  const request: EmailSendRequest = {
    clockId: "GUEST#isp-guest-07",
    kind: "ZONE_CHIEF_ALERT",
    toRole: "ZONE_CHIEF",
    to: "success+g07-zc-marisol@simulator.amazonses.com",
    subject: "[Cuadrilla] Alerta de seguridad · Orden 24819 · Zona Norte",
    bodyText: "Hola Marisol:\n\nRogelio reportó un riesgo de seguridad en la orden 24819: cable de energía dañado.",
    workOrderId: "wo-24819-g07",
    caseId: "case-01J9ZQX0000000000000000000",
    sentAtSim: "2026-10-13T15:10:00-06:00",
    actor: "SYSTEM",
  };

  it("sends the subject and both body parts with Charset UTF-8 and tags every world's ids", () => {
    const input = buildSendEmailInput({ request, to: request.to, mailId: "mail-01", config: CONFIG });
    const simple = input.Content?.Simple;
    expect(simple?.Subject).toEqual({ Data: request.subject, Charset: "UTF-8" });
    expect(simple?.Body?.Text).toEqual({ Data: request.bodyText, Charset: "UTF-8" });
    expect(simple?.Body?.Html?.Charset).toBe("UTF-8");
    expect(simple?.Body?.Html?.Data).toContain('<meta charset="utf-8">');
    expect(input.EmailTags).toEqual([
      { Name: "ispId", Value: "isp-guest-07" },
      { Name: "workOrderId", Value: "wo-24819-g07" },
      { Name: "mailId", Value: "mail-01" },
      { Name: "kind", Value: "ZONE_CHIEF_ALERT" },
      { Name: "stage", Value: "poc" },
    ]);
  });
});
