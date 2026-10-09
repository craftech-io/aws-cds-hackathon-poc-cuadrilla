// The capture world of the console's moments (FL-089, docs/landing-spec.md §6.2): the local UI server's
// console with the rehearsal guest's world jumped to a scene of the tour and holding the main story up to
// one entry, read back through the BFF's own procedures — what the simulator, the outbox and the order
// show is the story, in its order, each text once, with the certificate written by the product's writer.
import { describe, expect, it } from "vitest";
import { GUEST_TEST_CLOCK_ID } from "@cuadrilla/shared";
import { certificateFileName } from "../../packages/bff/src/copy/es-MX-documents";
import { createQaCaller } from "../../packages/bff/src/routers/index";
import { storyEntry } from "../../packages/bff/src/story/main-story";
import { createUiApp } from "../../tests/ui-server/app";
import { CaptureSpec, CapturesFile } from "./captures";
import { SCENE_ISP, createConsoleWorld } from "./console-world";
import { seedStoryEvidence } from "./story-evidence";
import { seedStoryMail } from "./story-mail";
import { sceneStory, seedStoryThread, storyIds, storyThrough } from "./story-thread";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ids = storyIds(SCENE_ISP);

async function sceneWorld(jump: string, through: string) {
  const app = await createUiApp({ origin: "http://127.0.0.1:0", pool: { userPoolId: "us-east-1_capture", clientIds: ["capture"] }, jwks: { keys: [] } });
  const guest = createQaCaller({ role: "GUEST", clockId: GUEST_TEST_CLOCK_ID }, app.deps);
  await guest.clock.jumpToScene({ sceneId: jump });
  const world = { connector: app.memory.connector, objects: app.ports.objects, ispId: SCENE_ISP, clockId: GUEST_TEST_CLOCK_ID, now: () => new Date() };
  const entries = sceneStory(jump, through);
  await seedStoryEvidence(world, entries);
  await seedStoryMail(world, entries);
  const seeded = await seedStoryThread(world, entries);
  return { app, guest, seeded };
}

function texts(bubbles: ReadonlyArray<{ readonly text: string | null }>): string[] {
  return bubbles.flatMap((bubble) => (bubble.text === null ? [] : [bubble.text]));
}

describe("the story in a capture world [FL-089]", () => {
  it("[FL-089] writes Rogelio's voice note and the cited reply as the simulator shows them", async () => {
    const { guest } = await sceneWorld("paso-de-diagnostico", "s1-diagnosis-reply");
    const thread = await guest.simulator.thread({ identity: ids.person("inst-rogelio") });
    const voice = thread.bubbles.find((bubble) => bubble.content === "VOICE");
    expect(voice?.mediaKind).toBe("AUDIO");
    expect(voice?.mediaUrl).toMatch(/^http:\/\/127\.0\.0\.1:0\/s3\/Media\//);
    expect(texts(thread.bubbles)).toContain(storyEntry("s1-diagnosis-reply").text);
    // The order of the story: the voice note before the reply.
    const order = thread.bubbles.map((bubble) => bubble.messageId);
    expect(order.indexOf(voice?.messageId ?? "")).toBeLessThan(order.findIndex((id) => id === "msg-story-s1-diagnosis-reply"));
  });

  it("[FL-089] lands the validator's reaction on each photo, the glare one with its reason", async () => {
    const { app, guest } = await sceneWorld("evidencia", "s3-label-photo");
    const thread = await guest.simulator.thread({ identity: ids.person("inst-rogelio") });
    const photos = thread.bubbles.filter((bubble) => bubble.mediaKind === "IMAGE" && bubble.direction === "IN");
    expect(photos.length).toBeGreaterThanOrEqual(3);
    const reactions = thread.bubbles.flatMap((bubble) => (bubble.reaction === null ? [] : [bubble.reaction]));
    for (const id of ["s3-meter-photo", "s3-label-glare-photo", "s3-label-photo"]) {
      const entry = storyEntry(id);
      const photo = thread.bubbles.find((bubble) => bubble.messageId === `msg-story-${id}`);
      expect(reactions.find((reaction) => reaction.to === photo?.providerMessageId)?.emoji, id).toBe(entry.kind === "PHOTO" ? entry.reaction : "");
    }
    expect(texts(thread.bubbles)).toContain(storyEntry("s3-glare-reason").text);
    // The evidence the console reviews is the story's: the glare photo rejected, then the label accepted.
    const label = await app.memory.connector.workOrders.getChecklistItem(ids.order("24817"), "ONU_LABEL_PHOTO");
    expect(label).toMatchObject({ status: "PASSED", attempts: 1, lastRejectReason: "GLARE" });
  });

  it("[FL-089] leaves the glare photo in the evidence review while it is the last word on its item", async () => {
    const { guest } = await sceneWorld("evidencia", "s3-glare-reason");
    expect(JSON.stringify(await guest.evidence.queue({}))).toContain("GLARE");
  });

  it("[FL-089] closes order 24817 with the product's certificate: the PDF to Rogelio and the two emails delivered", async () => {
    const { app, guest, seeded } = await sceneWorld("checklist-completo", "s4-certificate");
    expect(seeded.skipped).toContain("s4-certificate");
    const order = await guest.orders.get({ workOrderId: ids.order("24817") });
    expect(JSON.stringify(order)).toContain('"CLOSED"');
    const thread = await guest.simulator.thread({ identity: ids.person("inst-rogelio") });
    const pdf = thread.bubbles.filter((bubble) => bubble.mediaKind === "DOCUMENT");
    expect(pdf).toHaveLength(1);
    expect(pdf[0]?.fileName).toBe(certificateFileName("24817"));
    const outbox = await guest.outbox.list();
    const mails = (outbox as { items?: unknown[] }).items ?? (outbox as unknown as unknown[]);
    const certificateMails = (mails as Array<{ kind: string; status: string; toRole: string; hasAttachment: boolean }>).filter((mail) => mail.kind === "CERTIFICATE_EMAIL");
    expect(certificateMails.map((mail) => mail.toRole).sort()).toEqual(["CUSTOMER", "OPS_MAILBOX"]);
    for (const mail of certificateMails) expect(mail).toMatchObject({ status: "DELIVERED", hasAttachment: true });
    const pdfKeys = app.memory.client.dump("WorkOrders").filter((row) => row.entity === "Certificate" && row.workOrderId === ids.order("24817")).map((row) => String(row.s3Key));
    expect(pdfKeys).toHaveLength(1);
    expect((await app.ports.objects.get("Evidence", pdfKeys[0] ?? ""))?.contentType).toBe("application/pdf");
  });

  it("[FL-089] never writes a text twice in a thread the scene's ladder already wrote to", async () => {
    const { guest } = await sceneWorld("caso-con-respaldo", "s5-hector-relay");
    // The seed's own history repeats a reply of the day before; the story's texts appear once each.
    const story = new Set(sceneStory("caso-con-respaldo", "s5-hector-relay").map((entry) => entry.text));
    for (const person of ["sup-adriana", "sup-hector", "inst-rogelio"] as const) {
      const shown = texts((await guest.simulator.thread({ identity: ids.person(person) })).bubbles).filter((text) => story.has(text));
      expect(new Set(shown).size, person).toBe(shown.length);
    }
    const hector = texts((await guest.simulator.thread({ identity: ids.person("sup-hector") })).bubbles);
    expect(hector).toContain(storyEntry("s5-hector-instruction").text);
    const rogelio = texts((await guest.simulator.thread({ identity: ids.person("inst-rogelio") })).bubbles);
    expect(rogelio).toContain(storyEntry("s5-hector-relay").text);
  });

  it("[FL-089] sends the zone chief's alert of the safety sequence to the outbox", async () => {
    const { guest } = await sceneWorld("tercera-visita-1510", "s6-zone-chief-email");
    const outbox = await guest.outbox.list();
    const mails = ((outbox as { items?: unknown[] }).items ?? (outbox as unknown as unknown[])) as Array<{ kind: string; subject: string }>;
    expect(mails.find((mail) => mail.kind === "ZONE_CHIEF_ALERT")?.subject).toBe(storyEntry("s6-zone-chief-email").text);
    const adriana = texts((await guest.simulator.thread({ identity: ids.person("sup-adriana") })).bubbles);
    expect(adriana).toContain(storyEntry("s6-safety-alert").text);
  });

  it("[FL-089] holds only the conversation of the order the scene prepares, and refuses what the story does not have", () => {
    expect(new Set(sceneStory("caso-con-respaldo", "s5-hector-relay").map((entry) => entry.workOrderNumber))).toEqual(new Set(["24818"]));
    expect(sceneStory("checklist-completo", "s4-certificate")[0]?.id).toBe("s1-voice-note");
    expect(() => storyThrough("s9-nothing")).toThrow(/no entry s9-nothing/);
    expect(() => sceneStory("inicio-del-dia", "s1-voice-note")).toThrow(/prepares no moment/);
  });
});

describe("the console's moments of captures.json [FL-089]", () => {
  const file = CapturesFile.parse(JSON.parse(readFileSync(join(import.meta.dirname, "captures.json"), "utf8")));

  it("[FL-089] names, for every console capture, a scene of the guest template and an entry of the story", async () => {
    const template = JSON.parse(readFileSync(join(import.meta.dirname, "../seed/data/worlds/guest.json"), "utf8")) as { scenes: Array<{ sceneId: string }> };
    const scenes = new Set(template.scenes.map((scene) => scene.sceneId));
    for (const [id, spec] of Object.entries(file.captures)) {
      if (spec.scene === undefined) continue;
      expect(scenes.has(spec.scene.jump), `${id}: ${spec.scene.jump}`).toBe(true);
      if (spec.scene.through !== null) expect(sceneStory(spec.scene.jump, spec.scene.through).at(-1)?.id, id).toBe(spec.scene.through);
    }
  });

  it("[FL-089] resolves the ids of the world in a capture's route", async () => {
    const world = await createConsoleWorld({ world: "guest-scene", scene: { jump: "caso-con-respaldo", through: null, as: null } }, "http://127.0.0.1:0");
    expect(await world.route("/app/orders/{order:24817}")).toBe(`/app/orders/${ids.order("24817")}`);
    expect(await world.route("/app/cases/{case:24818}")).toMatch(/^\/app\/cases\/case-/);
    expect(world.signer?.role).toBe("GUEST");
  });

  it("[FL-089] refuses a phone without its person, and a scene outside a guest-scene world", () => {
    const base = { route: "/app/simulator", locale: "es-MX", viewports: ["1440x900"], manifest: null, requires: { views: [], procedures: [] }, moment: "x" };
    expect(CaptureSpec.safeParse({ ...base, world: "guest-scene", scene: { jump: "evidencia", through: null, as: null }, visual: { kind: "phone" } }).success).toBe(false);
    expect(CaptureSpec.safeParse({ ...base, world: "guest-ready", scene: { jump: "evidencia", through: null, as: null }, visual: { kind: "full" } }).success).toBe(false);
    expect(CaptureSpec.safeParse({ ...base, world: "guest-ready", route: "/app/orders/{order:24817}", visual: { kind: "full" } }).success).toBe(false);
    expect(CaptureSpec.safeParse({ ...base, world: "guest-scene", scene: { jump: "evidencia", through: null, as: "inst-rogelio" }, visual: { kind: "phone" } }).success).toBe(true);
  });
});
