// Chromium through Playwright: renders a photo spec to JPEG bytes and compares two JPEGs by their
// decoded pixels. Byte-identical renders are only expected on the same Chromium build and fonts-free
// page on the same OS (the pinned container image); across machines the check is by pixels with a
// tolerance (docs/seed-spec.md §10).
import { createRequire } from "node:module";
import { type Browser, type Page, chromium } from "playwright";
import { composeHtml, planFraming } from "./compose";
import { type Framing, PHOTO_FORMAT, type PhotoSpec } from "./schema";

const RENDER_TIMEOUT_MS = 30_000;

export interface PixelDiff {
  /** Mean absolute difference per channel, 0-255. */
  readonly meanAbs: number;
  /** Share of pixels with some channel off by more than 32. */
  readonly farShare: number;
}

export interface PhotoRenderer {
  readonly browserVersion: string;
  readonly playwrightVersion: string;
  render(spec: PhotoSpec): Promise<{ bytes: Buffer; framing: Framing }>;
  compare(a: Uint8Array, b: Uint8Array): Promise<PixelDiff>;
  close(): Promise<void>;
}

function playwrightVersion(): string {
  const require = createRequire(import.meta.url);
  const pkg = require("playwright/package.json") as { version: string };
  return pkg.version;
}

async function withRetry<T>(action: () => Promise<T>, attempts = 2): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    }
  }
  throw last;
}

// Runs in the page (the scripts are type-checked without DOM types, so it travels as source).
const COMPARE_IN_PAGE = `async (first, second) => {
  const load = async (src) => {
    const image = new Image();
    image.src = src;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    return context.getImageData(0, 0, canvas.width, canvas.height).data;
  };
  const [x, y] = await Promise.all([load(first), load(second)]);
  if (x.length !== y.length) return { meanAbs: 255, farShare: 1 };
  let sum = 0;
  let far = 0;
  for (let i = 0; i < x.length; i += 4) {
    let worst = 0;
    for (let c = 0; c < 3; c += 1) {
      const delta = Math.abs(x[i + c] - y[i + c]);
      sum += delta;
      worst = Math.max(worst, delta);
    }
    if (worst > 32) far += 1;
  }
  const pixels = x.length / 4;
  return { meanAbs: sum / (pixels * 3), farShare: far / pixels };
}`;

async function comparePixels(page: Page, a: Uint8Array, b: Uint8Array): Promise<PixelDiff> {
  const toUrl = (bytes: Uint8Array) => JSON.stringify(`data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`);
  return (await page.evaluate(`(${COMPARE_IN_PAGE})(${toUrl(a)}, ${toUrl(b)})`)) as PixelDiff;
}

/** Opens Chromium (Playwright's pinned build, or `executablePath`) with a 1280 × 960 page. */
export async function openRenderer(executablePath?: string): Promise<PhotoRenderer> {
  const browser: Browser = await chromium.launch(executablePath === undefined ? {} : { executablePath });
  const page = await browser.newPage({ viewport: { width: PHOTO_FORMAT.width, height: PHOTO_FORMAT.height }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(RENDER_TIMEOUT_MS);
  return {
    browserVersion: browser.version(),
    playwrightVersion: playwrightVersion(),
    async render(spec) {
      const framing = planFraming(spec);
      const bytes = await withRetry(async () => {
        await page.setContent(composeHtml(spec, framing), { waitUntil: "load" });
        return page.screenshot({ type: "jpeg", quality: framing.jpegQuality, clip: { x: 0, y: 0, width: PHOTO_FORMAT.width, height: PHOTO_FORMAT.height }, animations: "disabled", caret: "hide" });
      });
      return { bytes, framing };
    },
    compare: (a, b) => comparePixels(page, a, b),
    close: () => browser.close(),
  };
}
