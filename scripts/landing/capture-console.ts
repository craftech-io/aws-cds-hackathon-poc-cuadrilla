// Captures of the product for the landing, taken from the real console over a synthetic world, on this
// machine only (docs/landing-spec.md §6.2):
//
//   npx tsx scripts/landing/capture-console.ts
//     --only signup-form,signup-code   take only these (ids of scripts/landing/captures.json)
//     --viewport 390x844               only this viewport
//     --out <dir>                      write the pictures under <dir>/landing/captures and their ledger
//                                      to <dir>/captures.json, leaving the repository as it is
//
// For each capture and viewport: a fresh world (console-world.ts); the console and its BFF on one
// localhost port (console-server.ts); Chrome at the viewport's size and device scale 2, light scheme and
// reduced motion (the landing's still frames), with the session of the world's signer planted the way
// the console keeps it; the route in the capture's language; the scene (scenes.ts); the frame
// (render-visuals.ts). A frame is kept only if no request left localhost (Cognito's calls are answered
// in memory), the BFF never failed, the brand stayed neutral and the page's text shows no word the
// landing never says, no term of the operator's forbidden list, no address but the synthetic visitor's
// and no token. Its pixels are hashed: when the ledger holds them and every file is in place, nothing
// is written; otherwise each AVIF and WebP of its srcset is, the ledger is updated and, for a capture
// that replaces a render, the manifest entry becomes `capture`.
//
// It runs by hand on an operator's machine: never in CI, never with AWS credentials, never against a
// deployed stage (there is no option for a URL). A capture whose view or BFF procedure is not in the
// tree yet is reported as pending and skipped.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { type Browser, type Response, chromium } from "@playwright/test";
import { appRouter } from "../../packages/bff/src/routers/index";
import { LandingManifest } from "../../packages/web/src/views/landing/media";
import { listFromEnv } from "../lint/forbidden-terms";
import {
  CaptureViewport,
  type CapturePicture,
  type CaptureSpec,
  CapturesFile,
  DEVICE_SCALE,
  type FrameRules,
  type FramedVisual,
  VIEWPORT_SIZE,
  capturedEntry,
  formatJson,
  frameProblems,
  hashUnder,
  isCobrandAnswer,
  pictureKey,
  planPicture,
  sha256,
  variantsOf,
  withCaptures,
} from "./captures";
import { type ConsoleWorld, TEST_POOL, createConsoleWorld } from "./console-world";
import { startConsoleServer } from "./console-server";
import { encodeVariant, pixelsOf } from "./encode";
import { composeCard, renderVisual } from "./render-visuals";
import { COGNITO_ORIGIN, SCENES, answerCognito, framed, plantSession, stageConsole } from "./scenes";

const ROOT = resolve(import.meta.dirname, "../..");
const WEB = join(ROOT, "packages/web");
const PUBLIC = join(WEB, "public");
const CSS_FILE = join(WEB, "src/index.css");
const CAPTURES_FILE = join(ROOT, "scripts/landing/captures.json");
const MANIFEST_FILE = join(PUBLIC, "landing/manifest.json");
/** No file of a picture may weigh more (the landing's performance budget, docs/landing-spec.md §5.2). */
const MAX_FILE_BYTES = 600 * 1024;
// Software rasterisation, one colour profile and greyscale text: the same page gives the same pixels on
// every run, so an unchanged view never makes a new file.
const DETERMINISTIC_CHROME = ["--disable-gpu", "--force-color-profile=srgb", "--disable-partial-raster", "--disable-skia-runtime-opts", "--disable-lcd-text"];
/** A scene that met a busy world is tried again this many times in all, this far apart. */
const QUIET_ATTEMPTS = 3;
const QUIET_WAIT_MS = 2_000;
const AWS_CREDENTIALS = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE", "AWS_DEFAULT_PROFILE"];

interface Options {
  readonly only: ReadonlySet<string> | undefined;
  readonly viewports: readonly CaptureViewport[] | undefined;
  /** Root the public paths are written under; `undefined` is the repository (packages/web/public). */
  readonly out: string | undefined;
}

function options(): Options {
  const { values } = parseArgs({ options: { only: { type: "string" }, viewport: { type: "string" }, out: { type: "string" } }, strict: true });
  return {
    only: values.only ? new Set(values.only.split(",").map((id) => id.trim())) : undefined,
    viewports: values.viewport ? [CaptureViewport.parse(values.viewport)] : undefined,
    out: values.out ? resolve(values.out) : undefined,
  };
}

/** Local, by hand, without credentials: the process refuses CI and SST's shell, and drops AWS credentials. */
function isolate(): void {
  if (process.env.CI) throw new Error("the capture pipeline never runs in CI");
  if (Object.keys(process.env).some((name) => name.startsWith("SST_RESOURCE_"))) throw new Error("the capture pipeline never runs inside `sst shell`");
  for (const name of AWS_CREDENTIALS) delete process.env[name];
}

/** What a capture needs that the tree does not have yet (a web view, a BFF procedure). */
function missingFor(spec: CaptureSpec): string[] {
  const procedures = new Set(Object.keys(appRouter._def.procedures));
  const views = new Set(readdirSync(join(WEB, "src/views")));
  return [...spec.requires.views.filter((view) => !views.has(view)).map((view) => `view ${view}`), ...spec.requires.procedures.filter((name) => !procedures.has(name)).map((name) => `procedure ${name}`)];
}

function frameRules(world: ConsoleWorld, forRepository: boolean): FrameRules {
  const list = listFromEnv(process.env);
  if (!list.ok && forRepository) throw new Error(`the pictures go into the repository, so the operator's list is required: ${list.message}`);
  return { allowedEmails: world.syntheticEmails, forbidden: list.ok ? list.terms : [] };
}

/** What the BFF answered during a scene: failures, a busy world, and whether the brand left the neutral one. */
interface ApiAnswers {
  readonly failures: string[];
  busy: boolean;
  cobrand: boolean;
  readonly reads: Array<Promise<void>>;
}

function watchAnswer(origin: string, response: Response, answers: ApiAnswers): void {
  const url = new URL(response.url());
  if (url.origin !== origin || !url.pathname.startsWith("/api/")) return;
  if (response.status() >= 500) answers.failures.push(`${url.pathname} answered ${response.status()}`);
  answers.reads.push(
    response.text().then(
      (body) => {
        answers.busy ||= body.includes('"WORLD_BUSY"');
        if (url.pathname.includes("brand.get")) answers.cobrand ||= isCobrandAnswer(body);
      },
      () => undefined,
    ),
  );
}

async function takePicture(browser: Browser, origin: string, world: ConsoleWorld, id: string, spec: CaptureSpec, viewport: CaptureViewport, rules: FrameRules): Promise<Buffer> {
  const mobile = viewport === "390x844";
  const context = await browser.newContext({
    viewport: VIEWPORT_SIZE[viewport],
    deviceScaleFactor: DEVICE_SCALE,
    isMobile: mobile,
    hasTouch: mobile,
    locale: spec.locale,
    timezoneId: "America/Mexico_City",
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  const escaped = new Set<string>();
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    if (url.origin === COGNITO_ORIGIN) return answerCognito(route);
    // Only the origin is kept: a URL may carry data.
    escaped.add(url.origin);
    return route.abort();
  });
  try {
    const page = await context.newPage();
    const scene = SCENES[id];
    if (!scene) throw new Error(`${id}: no scene in scenes.ts`);
    await plantSession(page, world);
    const route = await world.route(spec.route);
    const fresh = (): ApiAnswers => ({ failures: [], busy: false, cobrand: false, reads: [] });
    let answers = fresh();
    page.on("response", (response) => watchAnswer(origin, response, answers));
    // The world is quiet when no answer of the scene was WORLD_BUSY; a busy world gets another try.
    for (let attempt = 1; ; attempt += 1) {
      await page.goto(`${origin}${route}?lang=${spec.locale}`);
      await scene.stage({ page, world, spec });
      await Promise.all(answers.reads);
      if (!answers.busy) break;
      if (attempt === QUIET_ATTEMPTS) throw new Error(`${id} ${viewport}: the world stayed busy`);
      answers = fresh();
      await page.waitForTimeout(QUIET_WAIT_MS);
    }
    const check = async (): Promise<void> => {
      const problems = [...frameProblems(await page.locator("body").innerText(), rules), ...answers.failures];
      if (escaped.size > 0) problems.push(`requests left localhost for ${[...escaped].join(", ")}`);
      if (answers.cobrand) problems.push("the brand was not the neutral one");
      if (problems.length > 0) throw new Error(`${id} ${viewport}: ${problems.join("; ")}`);
    };
    await check();
    const visual = framed(spec.visual, spec.scene?.as ?? null);
    if (spec.beside === undefined) return await renderVisual(browser, page, visual, CSS_FILE);
    // A pair: both views as they are on screen, then one card with the two side by side.
    const raw = (shot: FramedVisual): FramedVisual => (shot.kind === "card" ? { ...shot, kind: "crop" } : shot);
    const first = await renderVisual(browser, page, raw(visual), CSS_FILE);
    await page.goto(`${origin}${await world.route(spec.beside.route)}?lang=${spec.locale}`);
    await stageConsole(page, spec.beside.as);
    await Promise.all(answers.reads);
    await check();
    const second = await renderVisual(browser, page, raw(framed(spec.beside.visual, spec.beside.as)), CSS_FILE);
    return await composeCard(browser, [first, second], CSS_FILE);
  } finally {
    await context.close();
  }
}

async function main(): Promise<void> {
  isolate();
  const opts = options();
  const root = opts.out ?? PUBLIC;
  const ledgerFile = opts.out ? join(opts.out, "captures.json") : CAPTURES_FILE;
  const file = CapturesFile.parse(JSON.parse(readFileSync(CAPTURES_FILE, "utf8")));
  const images = opts.out && existsSync(ledgerFile) ? CapturesFile.parse(JSON.parse(readFileSync(ledgerFile, "utf8"))).images : opts.out ? {} : file.images;
  const unknown = [...(opts.only ?? [])].filter((id) => file.captures[id] === undefined);
  if (unknown.length > 0) throw new Error(`no capture ${unknown.join(", ")} in captures.json`);

  const wanted: Array<[string, CaptureSpec]> = [];
  for (const [id, spec] of Object.entries(file.captures)) {
    if (opts.only && !opts.only.has(id)) continue;
    const missing = missingFor(spec);
    if (missing.length > 0) console.log(`${id}  pending: needs ${missing.join(", ")}`);
    else wanted.push([id, spec]);
  }
  if (opts.only && wanted.length < opts.only.size) throw new Error("a capture asked for with --only is pending");

  const saveLedger = (): void => {
    const ledger: CapturesFile = { ...file, images: Object.fromEntries(Object.entries(images).sort(([a], [b]) => a.localeCompare(b))) };
    mkdirSync(dirname(ledgerFile), { recursive: true });
    writeFileSync(ledgerFile, formatJson(ledger));
  };
  let world: ConsoleWorld | undefined;
  const server = await startConsoleServer({
    webDir: WEB,
    pool: TEST_POOL,
    handler: () => {
      if (!world) throw new Error("no capture world yet");
      return world.handle;
    },
  });
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome", args: DETERMINISTIC_CHROME });
  const captured: Record<string, CapturePicture> = {};
  const rawManifest: unknown = JSON.parse(readFileSync(MANIFEST_FILE, "utf8"));
  const manifest = LandingManifest.parse(rawManifest);
  try {
    for (const [id, spec] of wanted) {
      for (const viewport of spec.viewports.filter((candidate) => !opts.viewports || opts.viewports.includes(candidate))) {
        world = await createConsoleWorld(spec, server.origin);
        const png = await takePicture(browser, server.origin, world, id, spec, viewport, frameRules(world, opts.out === undefined)).catch((error: unknown) => {
          throw new Error(`${id} ${viewport}: ${error instanceof Error ? error.message : String(error)}`);
        });
        const pixels = await pixelsOf(png);
        const variants = variantsOf(id, viewport, pixels);
        const key = pictureKey(id, viewport);
        const plan = planPicture(images[key], pixels.sha256, variants.map((variant) => variant.path), hashUnder(root));
        if (plan.action === "write") {
          const files: Record<string, string> = {};
          for (const variant of variants) {
            const bytes = await encodeVariant(png, variant);
            if (bytes.byteLength > MAX_FILE_BYTES) throw new Error(`${variant.path}: ${Math.round(bytes.byteLength / 1024)} KB, over the ${MAX_FILE_BYTES / 1024} KB budget`);
            mkdirSync(dirname(join(root, variant.path)), { recursive: true });
            writeFileSync(join(root, variant.path), bytes);
            files[variant.path] = sha256(bytes);
          }
          images[key] = { pixels: pixels.sha256, width: pixels.width, height: pixels.height, files };
          // The ledger follows every picture written, so a run that stops halfway leaves both in step.
          saveLedger();
        }
        console.log(`${key}  ${plan.action === "keep" ? "unchanged, nothing written" : `written (${plan.reason})`}`);
        const entry = images[key];
        if (spec.manifest?.viewport === viewport && entry) {
          const previous = manifest.media[spec.manifest.id];
          if (!previous) throw new Error(`${id}: the manifest has no entry ${spec.manifest.id}`);
          captured[spec.manifest.id] = capturedEntry(previous, variants, entry.files);
        }
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }
  if (!opts.out && Object.keys(captured).length > 0) writeFileSync(MANIFEST_FILE, formatJson(withCaptures(rawManifest, captured)));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
