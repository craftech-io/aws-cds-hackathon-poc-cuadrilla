// Frame and crop of a capture (docs/landing-spec.md §6.2, step 4): how the screenshot of a view becomes
// the picture the landing shows.
//
//   full   the whole viewport, as the person sees it
//   crop   the box of one element of the view, with a margin, clamped to the page
//   card   that same box set on a card of the landing's own theme (its radius and floating shadow over
//          the paper colour), for a piece of the console that stands on its own (a case, a checklist)
//
// The phone of the simulator brings its own frame: it is captured with `crop`, never drawn here. The
// card's colours, radius and shadow are read from packages/web/src/index.css (@theme), where every
// value of the landing's identity lives; the card is drawn by the same browser that took the
// screenshot, from a page served in memory (nothing is fetched).
import { readFileSync } from "node:fs";
import type { Browser, Page } from "@playwright/test";
import { DEVICE_SCALE, type Visual, pngSize } from "./captures";

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Custom properties of the `@theme` block of the web's stylesheet, by name (`--color-paper` → `#…`). */
export function themeTokens(css: string): Record<string, string> {
  const start = css.indexOf("@theme");
  const body = start < 0 ? "" : css.slice(start, css.indexOf("\n}", start));
  return Object.fromEntries([...body.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gm)].map((match) => [match[1] ?? "", (match[2] ?? "").trim()]));
}

/** The tokens the card uses: all of them must be in the theme. */
export const CARD_TOKENS = ["--color-paper", "--color-mist", "--color-white", "--radius-card", "--shadow-float"] as const;

/** The box of `selector` with `margin` around it, clamped to the page (CSS pixels, page coordinates). */
export async function boxOf(page: Page, selector: string, margin: number): Promise<Box> {
  const target = page.locator(selector).first();
  await target.waitFor({ state: "visible" });
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error(`${selector} is not rendered`);
  // Evaluated in the page (a string: this program has no DOM types).
  const extent = await page.evaluate("({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight, x: window.scrollX, y: window.scrollY })");
  const { width, height, x: scrollX, y: scrollY } = extent as { width: number; height: number; x: number; y: number };
  const left = Math.max(0, Math.floor(box.x + scrollX - margin));
  const top = Math.max(0, Math.floor(box.y + scrollY - margin));
  const right = Math.min(width, Math.ceil(box.x + scrollX + box.width + margin));
  const bottom = Math.min(height, Math.ceil(box.y + scrollY + box.height + margin));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Space around the card, in CSS pixels: room for its shadow. */
const CARD_PADDING = 40;

/** `png` set on a card of the theme, at the device scale it was taken at. */
export async function composeCard(browser: Browser, png: Buffer, cssFile: string): Promise<Buffer> {
  const theme = themeTokens(readFileSync(cssFile, "utf8"));
  const missing = CARD_TOKENS.filter((token) => theme[token] === undefined);
  if (missing.length > 0) throw new Error(`the web's theme lacks ${missing.join(", ")}`);
  const size = pngSize(png);
  const width = Math.round(size.width / DEVICE_SCALE);
  const height = Math.round(size.height / DEVICE_SCALE);
  const root = CARD_TOKENS.map((token) => `${token}: ${theme[token]};`).join(" ");
  const html = `<!doctype html><html><head><style>
    :root { ${root} }
    html, body { margin: 0; background: var(--color-paper); }
    .card { margin: ${CARD_PADDING}px; width: ${width}px; height: ${height}px; overflow: hidden; background: var(--color-white);
            border: 1px solid var(--color-mist); border-radius: var(--radius-card); box-shadow: var(--shadow-float); }
    img { display: block; width: ${width}px; height: ${height}px; }
  </style></head><body><div class="card"><img alt="" src="data:image/png;base64,${png.toString("base64")}"></div></body></html>`;
  const page = await browser.newPage({ viewport: { width: width + CARD_PADDING * 2 + 2, height: height + CARD_PADDING * 2 + 2 }, deviceScaleFactor: DEVICE_SCALE });
  try {
    await page.route("**/*", (route) => route.abort());
    await page.setContent(html, { waitUntil: "load" });
    return await page.screenshot({ type: "png", fullPage: true, animations: "disabled" });
  } finally {
    await page.close();
  }
}

/** The picture of `page` as `visual` asks: the viewport, a box of it, or that box on a card. */
export async function renderVisual(browser: Browser, page: Page, visual: Visual, cssFile: string): Promise<Buffer> {
  const options = { type: "png", animations: "disabled", caret: "hide" } as const;
  if (visual.kind === "full") return page.screenshot(options);
  const clip = await boxOf(page, visual.selector, visual.margin);
  const shot = await page.screenshot({ ...options, clip, fullPage: true });
  return visual.kind === "card" ? composeCard(browser, shot, cssFile) : shot;
}
