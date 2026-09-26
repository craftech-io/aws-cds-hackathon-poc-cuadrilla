import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MARKER_NAMES, TemplateError, capsOf, fillTemplate, markersFor, readTemplate } from "./template";
import { SIGNUP_ISP, TEMPLATE_TEXT } from "./testing";

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

describe("[FL-107] guest world template", () => {
  it("[FL-107] fills the four markers per origin: invited, rehearsal and sign-up generation", () => {
    expect(markersFor("isp-guest-07")).toEqual({ ispId: "isp-guest-07", clockTag: "g07", phoneBlock: "0207", capsProfile: "INVITED" });
    expect(markersFor("isp-guest-test")).toEqual({ ispId: "isp-guest-test", clockTag: "gtest", phoneBlock: "0299", capsProfile: "TEST" });
    expect(markersFor(SIGNUP_ISP)).toEqual({ ispId: SIGNUP_ISP, clockTag: "gs261001abcde", phoneBlock: "0300", capsProfile: "SIGNUP" });
    for (const other of ["isp-demo", "isp-qa-812-1-sc-02", "isp-guest-s261001ABCDE"]) expect(() => markersFor(other), other).toThrow();
  });

  it("[FL-107] the seed's template uses every marker, and a filled template keeps none", () => {
    for (const name of MARKER_NAMES) expect(TEMPLATE_TEXT).toContain(`{{${name}}}`);
    const filled = fillTemplate(TEMPLATE_TEXT, markersFor(SIGNUP_ISP));
    expect(JSON.stringify(filled)).not.toContain("{{");
    expect(filled).toMatchObject({ template: "guest", ispId: SIGNUP_ISP, clockId: `GUEST#${SIGNUP_ISP}`, startAtSim: "2026-10-13T07:00:00-06:00", whatsappMode: "simulated" });
  });

  it("an unknown marker, a template of another operator or a broken one fails before any world is built", () => {
    const markers = markersFor(SIGNUP_ISP);
    expect(() => fillTemplate(TEMPLATE_TEXT.replace("{{phoneBlock}}", "{{phoneBlok}}"), markers)).toThrow(TemplateError);
    expect(() => fillTemplate(TEMPLATE_TEXT.replace('"ispId": "{{ispId}}"', '"ispId": "isp-guest-08"'), markers)).toThrow(TemplateError);
    expect(() => fillTemplate("{", markers)).toThrow(TemplateError);
    expect(() => fillTemplate(JSON.stringify({ template: "demo" }), markers)).toThrow(TemplateError);
  });

  it("the caps of each profile are the ones of docs/seed-spec.md §4", () => {
    const filled = fillTemplate(TEMPLATE_TEXT, markersFor(SIGNUP_ISP));
    expect(capsOf(filled, "SIGNUP")).toEqual({
      simulatorCaps: { turnsPerHour: 20, turnsPerDay: 60, validationsPerDay: 20, transcribeSecPerDay: 300, emailsPerDay: 10, messagesPerRealHourPerIdentity: 15, sceneJumpsPerRealHour: 15 },
      turnCaps: { perHour: 20, perDay: 60 },
    });
    expect(capsOf(filled, "TEST").simulatorCaps).toMatchObject({ messagesPerRealHourPerIdentity: 80, turnsPerHour: 180, emailsPerDay: 60 });
    expect(capsOf(filled, "INVITED").simulatorCaps).toMatchObject({ turnsPerHour: 60, turnsPerDay: 300, validationsPerDay: 100 });
  });

  it("reads the template only with the digest the IaC uploaded it with", async () => {
    const source = (digest: string) => ({ locate: (name: string) => ({ key: `worlds/${name}.json`, sha256: digest }), read: async () => TEMPLATE_TEXT });
    await expect(readTemplate(source(sha(TEMPLATE_TEXT)))).resolves.toBe(TEMPLATE_TEXT);
    await expect(readTemplate(source(sha(`${TEMPLATE_TEXT} `)))).rejects.toThrow(TemplateError);
  });
});
