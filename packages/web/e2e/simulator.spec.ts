// FL-082, FL-083 and FL-101 in the browser (docs/test-plan.md §3, level UI): the phone simulator against
// the local UI server of tests/ui-server (the real `appRouter`, the real `InboundWhatsApp` in process, the
// S3 emulator of the presigned POST), started in each worker on a free port with this run's JWKS. The
// sign-in is the console's own against the route mock of Cognito, as a guest of `isp-guest-07`. What the
// agent would have written (buttons, lists, a template, a document, a reaction) is put in the server's
// memory as the worker writes it, so the phone draws it and a tap goes back through the router.
//
// Voice: Chromium records from its fake microphone (`--use-fake-device-for-media-stream`); the WebKit
// case (`@webkit`) records MP4 from a synthetic stream. Nothing reaches AWS.
import { type Page, test as base, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";
import { createServer as createViteServer } from "vite";
import type { UiApp } from "../../../tests/ui-server/app";
import { simulatorCopy as copy } from "../src/views/simulator/copy";
import { loginCopy } from "../src/views/login/copy";
import { expectReadableScreen } from "./support/a11y";
import { E2E_CLIENT_ID, E2E_POOL_ID, createPool, randomPassword } from "./support/accounts";
import { routeCognito } from "./support/cognito";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = resolve(HERE, "..");
const REPO = resolve(WEB_DIR, "../..");
const GUEST_ISP = "isp-guest-07";
const CLOCK = `GUEST#${GUEST_ISP}`;
const ROGELIO = "inst-rogelio-g07";
const ADRIANA = "sup-adriana-g07";
const TO = "5215500000000";

type Render = typeof import("../../bff/src/channels/whatsapp/render");

interface UiServer {
  readonly origin: string;
  readonly app: UiApp;
  readonly render: Render;
}

async function startUiServer(): Promise<{ readonly ui: UiServer; close(): Promise<void> }> {
  // The build variables the console reads; the Vite of this server takes them from the environment.
  process.env.VITE_COGNITO_USER_POOL_ID = E2E_POOL_ID;
  process.env.VITE_COGNITO_CLIENT_ID = E2E_CLIENT_ID;
  const { createUiApp } = (await tsImport(join(REPO, "tests/ui-server/app.ts"), import.meta.url)) as typeof import("../../../tests/ui-server/app");
  const { runJwks } = (await tsImport(join(REPO, "tests/ui-server/main.ts"), import.meta.url)) as typeof import("../../../tests/ui-server/main");
  const render = (await tsImport(join(REPO, "packages/bff/src/channels/whatsapp/render.ts"), import.meta.url)) as Render;
  let handle: (request: IncomingMessage, response: ServerResponse) => void = (_request, response) => void response.writeHead(503).end();
  const server: Server = createServer((request, response) => handle(request, response));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const app = await createUiApp({ origin, pool: { userPoolId: E2E_POOL_ID, clientIds: [E2E_CLIENT_ID, "fake-client"] }, jwks: runJwks(process.env.E2E_ID_TOKEN_PRIVATE_KEY ?? "") });
  const vite = await createViteServer({ root: WEB_DIR, configFile: join(WEB_DIR, "vite.config.ts"), logLevel: "warn", clearScreen: false, appType: "spa", server: { middlewareMode: true, hmr: false } });
  handle = (request, response) => {
    app
      .handle(request, response)
      .then((handled) => (handled ? undefined : vite.middlewares(request, response)))
      .catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
  };
  return { ui: { origin, app, render }, close: async () => void (await Promise.all([vite.close(), new Promise((done) => server.close(done))])) };
}

const test = base.extend<object, { ui: UiServer }>({
  ui: [
    async ({}, use) => {
      const server = await startUiServer();
      await use(server.ui);
      await server.close();
    },
    { scope: "worker", timeout: 240_000 },
  ],
  // Chromium records from its fake microphone; WebKit takes no such switches.
  launchOptions: [
    async ({ launchOptions, browserName }, use) => {
      const args = browserName === "chromium" ? ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] : [];
      await use({ ...launchOptions, args: [...(launchOptions.args ?? []), ...args] });
    },
    { scope: "worker" },
  ],
});

test.describe.configure({ timeout: 120_000 });

async function openSimulator(page: Page, ui: UiServer, query = ""): Promise<void> {
  const pool = createPool();
  const password = randomPassword();
  const email = `guest-sim-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  await pool.addUser({ email, password, role: "GUEST", ispId: GUEST_ISP, status: "CONFIRMED" });
  await routeCognito(page, pool);
  await page.goto(`${ui.origin}/login?returnTo=${encodeURIComponent(`/app/simulator${query}`)}`);
  await page.getByLabel(loginCopy.credentials.email).fill(email);
  await page.getByLabel(loginCopy.credentials.password, { exact: true }).fill(password);
  await page.getByRole("button", { name: loginCopy.credentials.submit }).click();
  await expect(page).toHaveURL(/\/app\/simulator/, { timeout: 30_000 });
  await expect(page.getByText(copy.frameLabel)).toBeVisible({ timeout: 30_000 });
}

const phoneOf = (page: Page) => page.getByRole("log", { name: copy.phone.messages });

async function choose(page: Page, label: RegExp): Promise<void> {
  const select = page.getByLabel(copy.identity.label);
  const option = (await select.locator("option").allTextContents()).find((text) => label.test(text));
  if (option === undefined) throw new Error(`no identity ${label.source}`);
  await select.selectOption({ label: option });
}

/** A message of Cuadrilla to a person of the guest's world, stored as the worker stores it. */
async function storeOut(ui: UiServer, personId: string, id: string, payload: object, extra: Record<string, unknown> = {}): Promise<void> {
  await ui.app.memory.connector.conversations.appendMessage({
    messageId: id,
    personId,
    ispId: GUEST_ISP,
    clockId: CLOCK,
    direction: "OUT",
    channel: "WHATSAPP",
    content: "INTERACTIVE",
    kind: "REPLY",
    status: "DELIVERED",
    author: "AGENT",
    simulated: true,
    transport: "simulated",
    providerMessageId: `wamid.SIM.${id}`,
    sentAtSim: "2026-10-13T06:55:00-06:00",
    refs: { whatsapp: payload },
    ...extra,
  } as never);
}

const lastEnvelope = (ui: UiServer): string => JSON.stringify(ui.app.ports.envelopes.at(-1) ?? null);

function storedAudio(ui: UiServer): Array<{ readonly key: string; readonly contentType: string; readonly bytes: Uint8Array }> {
  return [...ui.app.ports.objects.blobs.entries()].filter(([key, blob]) => key.startsWith("Media/") && blob.contentType.startsWith("audio/")).map(([key, blob]) => ({ key, ...blob }));
}

test.describe("phone simulator", () => {
  test("[FL-082] the phone of the story's installer: labelled simulator, the world's identities and the unknown number, the chat with its English gloss", async ({ page, ui }) => {
    await openSimulator(page, ui);
    const options = await page.getByLabel(copy.identity.label).locator("option").allTextContents();
    expect(options.some((text) => text.startsWith("Rogelio Méndez · instalador"))).toBe(true);
    expect(options.some((text) => text.startsWith("Adriana Solís · supervisor"))).toBe(true);
    expect(options).toContain(copy.identity.unknown);
    const phone = phoneOf(page);
    await expect(phone.getByText(/¡Listo, Rogelio! Ya tienes activo Cuadrilla/)).toBeVisible();
    await expect(phone.getByText(copy.phone.template).first()).toBeVisible();
    await phone.getByRole("button", { name: copy.phone.glossShow }).first().click();
    await expect(phone.getByRole("note", { name: copy.phone.glossLabel }).first()).toContainText("All set, Rogelio!");
    await expect(page.getByRole("heading", { name: copy.live.title })).toHaveCount(0);
    await expectReadableScreen(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });

  test("[FL-082] [FL-102] a text enters as the chosen identity and Cuadrilla reads it; the unknown number only writes", async ({ page, ui }) => {
    await openSimulator(page, ui);
    const queued = ui.app.inbound.queued.length;
    await page.getByRole("textbox", { name: copy.composer.label, exact: true }).fill("Ya llegué al domicilio de la orden 24817.");
    await page.getByRole("button", { name: copy.composer.send, exact: true }).click();
    const phone = phoneOf(page);
    await expect(phone.getByText("Ya llegué al domicilio de la orden 24817.")).toBeVisible();
    await expect(phone.getByRole("img", { name: copy.ticks.READ_BY_CUADRILLA }).last()).toBeVisible();
    expect(ui.app.inbound.queued.length).toBeGreaterThan(queued);
    expect(lastEnvelope(ui)).toContain("Ya llegué al domicilio de la orden 24817.");

    await choose(page, new RegExp(`^${copy.identity.unknown}$`));
    await expect(phone.getByText(copy.identity.unknownNote)).toBeVisible();
    const notices = ui.app.inbound.notices.length;
    await page.getByRole("textbox", { name: copy.composer.label, exact: true }).fill("Hola, ¿quién es?");
    await page.getByRole("button", { name: copy.composer.send, exact: true }).click();
    await expect(page.getByText(copy.done)).toBeVisible();
    await expect.poll(() => ui.app.inbound.notices.slice(notices).map((notice) => notice.notice)).toContain("unknownNumber");
    await expect(page.getByRole("button", { name: copy.composer.photo, exact: true })).toHaveCount(0);
  });

  test("[FL-082] buttons, lists, templates, documents and reactions as WhatsApp draws them; a tap goes back with the button's nonce", async ({ page, ui }) => {
    const { render } = ui;
    await storeOut(ui, ADRIANA, "e2e-template-01", render.renderTemplate(TO, { name: "caso_escalado", params: ["C-0412", "Rogelio", "24818", "potencia fuera de rango después de 3 pasos"], buttonNonces: ["e2e-take-nonce", "e2e-decline-nonce"] }), {
      content: "TEMPLATE",
      kind: "CASE_REQUEST",
      templateName: "caso_escalado",
      author: "SYSTEM",
    });
    await storeOut(ui, ROGELIO, "e2e-buttons-01", render.renderReplyButtons(TO, "¿El cliente quedó conforme con la instalación?", [{ id: "e2e-ok-nonce", title: "Cliente conforme" }]));
    await storeOut(ui, ROGELIO, "e2e-list-01", render.renderList(TO, "Tienes varias órdenes pendientes hoy. ¿Sobre cuál es tu mensaje?", "Elegir orden", [{ id: "e2e-row-nonce", title: "OT 24818", description: "11:30 a 13:30 · El Mirador" }]), { kind: "ORDER_CHOICE", author: "SYSTEM" });
    ui.app.ports.objects.put("Evidence", "certificates/e2e/acta-24817.pdf", new TextEncoder().encode("%PDF-1.7 e2e"), "application/pdf");
    await storeOut(ui, ROGELIO, "e2e-document-01", render.renderDocument(TO, "sim-s3:Evidence:certificates/e2e/acta-24817.pdf", "acta-24817.pdf"), { content: "DOCUMENT", kind: "CERTIFICATE", author: "SYSTEM" });
    const alta = (await ui.app.memory.connector.conversations.listMessages(ROGELIO)).find((message) => message.direction === "IN");
    await storeOut(ui, ROGELIO, "e2e-reaction-01", render.renderReaction(TO, alta?.providerMessageId ?? "", "✅"), { content: "REACTION", kind: "VERDICT_REACTION", author: "SYSTEM" });

    await openSimulator(page, ui, `?identity=${ADRIANA}`);
    const phone = phoneOf(page);
    await expect(phone.getByText(/Tienes un caso nuevo de tu equipo: C-0412/)).toBeVisible();
    await phone.getByRole("button", { name: copy.phone.glossShow }).last().click();
    await expect(phone.getByRole("note", { name: copy.phone.glossLabel }).last()).toContainText("[Take case] [Can't]");
    await phone.getByRole("button", { name: copy.phone.tap("Tomar caso") }).click();
    await expect(page.getByText(copy.done)).toBeVisible();
    expect(lastEnvelope(ui)).toContain("e2e-take-nonce");

    await choose(page, /^Rogelio Méndez/);
    await expect(phone.getByRole("img", { name: copy.phone.reaction("✅") })).toBeVisible();
    await expect(phone.getByRole("group", { name: copy.phone.listHint }).getByRole("button", { name: copy.phone.tap("OT 24818") })).toBeVisible();
    const document = phone.getByRole("link", { name: copy.phone.openDocument("acta-24817.pdf") });
    await expect(document).toHaveAttribute("href", /\/s3\/Evidence\/certificates\/e2e\/acta-24817\.pdf\?/);
    const pdf = await page.request.get((await document.getAttribute("href")) ?? "");
    expect(pdf.headers()["content-type"]).toBe("application/pdf");
    await phone.getByRole("button", { name: copy.phone.tap("Cliente conforme") }).click();
    await expect.poll(() => lastEnvelope(ui)).toContain("e2e-ok-nonce");
    await expectReadableScreen(page);
  });

  test("[FL-082] photos: one of the synthetic set, and one's own JPEG by the presigned POST; a wrong file is refused before any upload", async ({ page, ui }) => {
    await openSimulator(page, ui);
    const phone = phoneOf(page);
    const images = await phone.getByRole("img", { name: copy.phone.photoAlt }).count();
    await page.getByRole("button", { name: copy.composer.photo, exact: true }).click();
    await page.getByRole("button", { name: /^Enviar Medidor/ }).first().click();
    await expect(phone.getByRole("img", { name: copy.phone.photoAlt })).toHaveCount(images + 1);

    await page.getByLabel(copy.photos.own).setInputFiles({ name: "captura.png", mimeType: "image/png", buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
    await expect(page.getByText(copy.photos.notJpeg)).toBeVisible();
    await expect(page.getByRole("button", { name: copy.photos.sendOwn })).toBeDisabled();
    const jpeg = await readFile(join(REPO, "scripts/seed/photos/out/ph-label-01.jpg"));
    await page.getByLabel(copy.photos.own).setInputFiles({ name: "etiqueta.jpg", mimeType: "image/jpeg", buffer: jpeg });
    await page.getByLabel(copy.photos.caption).fill("Etiqueta de la ONU");
    const upload = page.waitForResponse((response) => response.url().endsWith("/s3/Media") && response.request().method() === "POST");
    await page.getByRole("button", { name: copy.photos.sendOwn }).click();
    expect((await upload).status()).toBe(204);
    await expect(phone.getByRole("img", { name: copy.phone.photoAlt })).toHaveCount(images + 2);
    await expect(phone.getByText("Etiqueta de la ONU")).toBeVisible();
    expect(lastEnvelope(ui)).toContain("image");
  });

  test("[FL-082] a voice note recorded from Chromium's fake microphone goes up as Ogg or WebM and enters as a voice note", async ({ page, ui, browserName, context }) => {
    test.skip(browserName !== "chromium", "Chromium's fake microphone");
    // Headless Chrome on macOS never starts the fake audio capture (getUserMedia({ audio }) stays pending);
    // CI runs this test on Linux, where it does.
    test.skip(process.platform === "darwin" && !process.env.CI, "no fake audio capture in headless Chrome on macOS");
    await context.grantPermissions(["microphone"]);
    await openSimulator(page, ui);
    const before = storedAudio(ui).length;
    await page.getByRole("button", { name: copy.composer.voice, exact: true }).click();
    await page.getByRole("button", { name: copy.voice.record }).click();
    await expect(page.getByText(/Grabando… \d+ de 60 s/)).toBeVisible();
    await page.waitForTimeout(1_500);
    const upload = page.waitForResponse((response) => response.url().endsWith("/s3/Media") && response.request().method() === "POST");
    await page.getByRole("button", { name: copy.voice.stop }).click();
    expect((await upload).status()).toBe(204);
    await expect(phoneOf(page).locator("audio").last()).toBeVisible();
    const note = storedAudio(ui).slice(before).at(-1);
    expect(note?.contentType).toMatch(/^audio\/(?:ogg|webm)$/);
    const magic = Buffer.from(note?.bytes.slice(0, 4) ?? []).toString("hex");
    expect(note?.contentType === "audio/ogg" ? magic === "4f676753" : magic === "1a45dfa3").toBe(true);
  });

  test("@webkit [FL-082] WebKit records the voice note as MP4", async ({ page, ui, browserName }) => {
    test.skip(browserName !== "webkit", "WebKit only");
    // A synthetic microphone, and only MP4 offered, as Safari records. Playwright's Linux WebKit (CI's) has no
    // `MediaRecorder`: an MP4-only stand-in then proves the app's MP4 path in WebKit (type, upload, voice note);
    // a WebKit with its own recorder (macOS) records for real. The annotation says which one ran.
    await page.addInitScript(() => {
      const getUserMedia = async () => {
        try {
          const context = new AudioContext();
          const oscillator = context.createOscillator();
          const destination = context.createMediaStreamDestination();
          oscillator.connect(destination);
          oscillator.start();
          void context.resume().catch(() => undefined); // never awaited: a runner without audio may never resume
          return destination.stream;
        } catch {
          return { getTracks: () => [] } as unknown as MediaStream; // this WebKit allows no stream at all: the stand-in needs none
        }
      };
      const own = { configurable: true, writable: true, value: getUserMedia };
      if (typeof MediaDevices !== "undefined") Object.defineProperty(MediaDevices.prototype, "getUserMedia", own); // WebKit's own refuses here
      if (navigator.mediaDevices === undefined) Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
      else Object.defineProperty(navigator.mediaDevices, "getUserMedia", own);
      if (typeof MediaRecorder === "undefined") {
        const MP4_HEADER = [0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20, 0, 0, 0, 0, 0x4d, 0x34, 0x41, 0x20, 0x69, 0x73, 0x6f, 0x6d];
        class Mp4StandIn {
          static isTypeSupported(type: string): boolean {
            return type.startsWith("audio/mp4");
          }
          state: "inactive" | "recording" = "inactive";
          ondataavailable: ((event: { data: Blob }) => void) | null = null;
          onstop: (() => void) | null = null;
          readonly mimeType: string;
          constructor(_stream: MediaStream, options?: { mimeType?: string }) {
            this.mimeType = options?.mimeType ?? "audio/mp4";
          }
          start(): void { this.state = "recording"; }
          stop(): void {
            if (this.state !== "recording") return;
            this.state = "inactive";
            setTimeout(() => {
              this.ondataavailable?.({ data: new Blob([new Uint8Array(MP4_HEADER)], { type: this.mimeType }) });
              this.onstop?.();
            }, 0);
          }
        }
        Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, writable: true, value: Mp4StandIn });
        Object.defineProperty(globalThis, "__voiceRecorder", { configurable: true, value: "stand-in" });
        return;
      }
      const supported = MediaRecorder.isTypeSupported.bind(MediaRecorder);
      MediaRecorder.isTypeSupported = (type: string) => type.startsWith("audio/mp4") && supported(type);
    });
    await openSimulator(page, ui);
    const offered = await page.evaluate(async () => ({
      recorder: (globalThis as { __voiceRecorder?: string }).__voiceRecorder ?? "webkit",
      mp4: MediaRecorder.isTypeSupported("audio/mp4"),
      otherTypes: ["audio/ogg;codecs=opus", "audio/webm;codecs=opus"].some((type) => MediaRecorder.isTypeSupported(type)),
      microphone: await Promise.race([navigator.mediaDevices.getUserMedia({ audio: true }).then(() => "stream", (error: unknown) => `error ${String((error as Error).name)}`), new Promise<string>((done) => setTimeout(() => done("no answer in 5 s"), 5_000))]),
    }));
    test.info().annotations.push({ type: "recorder", description: offered.recorder === "webkit" ? "WebKit's own MediaRecorder" : "MP4-only stand-in (this WebKit has no MediaRecorder)" });
    expect({ mp4: offered.mp4, otherTypes: offered.otherTypes, microphone: offered.microphone }, "MP4 only, and the synthetic microphone").toEqual({ mp4: true, otherTypes: false, microphone: "stream" });
    const before = storedAudio(ui).length;
    await page.getByRole("button", { name: copy.composer.voice, exact: true }).click();
    await page.getByRole("button", { name: copy.voice.record }).click();
    await page.waitForTimeout(1_500);
    await page.getByRole("button", { name: copy.voice.stop }).click();
    await expect.poll(() => storedAudio(ui).length).toBeGreaterThan(before);
    const note = storedAudio(ui).slice(before).at(-1);
    expect(note?.contentType).toBe("audio/mp4");
    expect(Buffer.from(note?.bytes.slice(4, 8) ?? []).toString("latin1")).toBe("ftyp");
  });

  test("[FL-082] without MediaRecorder the record button is hidden and the sample notes are offered", async ({ page, ui }) => {
    await page.addInitScript(() => {
      Reflect.deleteProperty(window, "MediaRecorder");
    });
    await openSimulator(page, ui);
    await page.getByRole("button", { name: copy.composer.voice, exact: true }).click();
    await expect(page.getByText(copy.voice.unsupported)).toBeVisible();
    await expect(page.getByRole("button", { name: copy.voice.record })).toHaveCount(0);
    const voices = await phoneOf(page).locator("audio").count();
    await page.getByRole("button", { name: /^Enviar Nota 1 · / }).click();
    await expect(phoneOf(page).locator("audio")).toHaveCount(voices + 1);
  });

  test("[FL-082] the tour's quick messages send the story's lines, with the physical action on the ONU", async ({ page, ui }) => {
    await openSimulator(page, ui);
    const quick = page.getByRole("region", { name: copy.quick.title });
    await expect(quick.getByText(copy.quick.physical)).toBeVisible();
    const actions = ui.app.ports.network.calls.filter((call) => call.op === "action").length;
    await quick.getByRole("button", { name: copy.quick.send("Ya limpié el conector, ya prende.") }).click();
    await expect(phoneOf(page).getByText("Ya limpié el conector, ya prende.")).toBeVisible();
    await expect.poll(() => ui.app.ports.network.calls.filter((call) => call.op === "action").length).toBe(actions + 1);
    await quick.getByRole("button", { name: copy.quick.send("La señora quiere la roseta en el otro cuarto, ¿se le cobra?") }).click();
    await expect(phoneOf(page).getByText("La señora quiere la roseta en el otro cuarto, ¿se le cobra?")).toBeVisible();
  });

  test("[FL-083] the limits are on screen before they bite; over the hourly limit the simulator says which one and when it frees", async ({ page, ui }) => {
    const isps = ui.app.memory.connector.isps;
    const settings = await isps.getSettings(GUEST_ISP);
    if (settings === undefined) throw new Error("no settings");
    await openSimulator(page, ui);
    await expect(page.getByText(copy.caps.perHour(settings.simulatorCaps.messagesPerRealHourPerIdentity ?? 0))).toBeVisible();
    try {
      // One message per real hour: the second one (or the first, if this identity already wrote this hour) is refused.
      await isps.updateSettings(GUEST_ISP, { simulatorCaps: { ...settings.simulatorCaps, messagesPerRealHourPerIdentity: 1 } });
      const composer = page.getByRole("textbox", { name: copy.composer.label, exact: true });
      await composer.fill("Primer mensaje de la hora.");
      await page.getByRole("button", { name: copy.composer.send, exact: true }).click();
      await expect(page.getByRole("button", { name: copy.composer.send, exact: true })).toBeDisabled();
      await composer.fill("¿Sigo aquí?");
      await page.getByRole("button", { name: copy.composer.send, exact: true }).click();
      const notice = page.getByRole("alert").filter({ hasText: copy.caps.reasons.RATE_LIMIT ?? "" });
      await expect(notice).toBeVisible();
      await expect(notice).toContainText(/Se libera a las \d{2}:\d{2}\./);
      await expect(phoneOf(page).getByText("¿Sigo aquí?")).toHaveCount(0);
    } finally {
      await isps.updateSettings(GUEST_ISP, { simulatorCaps: settings.simulatorCaps });
    }
  });

  test("[FL-101] with the live channel in the stage: a one-use join code with its QR, and the guest's kit with the script's pronunciation", async ({ page, ui }) => {
    const ports = ui.app.ports as { stageTransports: () => readonly string[] };
    const stage = ports.stageTransports;
    ports.stageTransports = () => ["simulated", "live"];
    try {
      await openSimulator(page, ui);
      await expect(page.getByRole("heading", { name: copy.live.title })).toBeVisible();
      await page.getByLabel(copy.live.person).selectOption({ label: "Rogelio Méndez" });
      await page.getByRole("button", { name: copy.live.generate }).click();
      await expect(page.getByText(/^ALTA [A-Z0-9]+-[A-Z0-9]{4}$/)).toBeVisible();
      await expect(page.getByRole("img", { name: copy.live.qrText })).toBeVisible();
      await expect(page.getByRole("heading", { name: copy.kit.title })).toBeVisible();
      await expect(page.getByRole("link", { name: copy.kit.download(copy.kit.photo(1)) })).toHaveAttribute("href", /\/s3\/Seed\/photos\//);
      await page.getByRole("button", { name: copy.kit.showQr(copy.kit.voice(1)) }).click();
      await expect(page.getByRole("img", { name: copy.kit.qrOf(copy.kit.voice(1)) })).toBeVisible();
      await expect(page.getByText(`${copy.kit.phonetic}:`).first()).toBeVisible();
      await expectReadableScreen(page);
    } finally {
      ports.stageTransports = stage;
    }
  });
});
