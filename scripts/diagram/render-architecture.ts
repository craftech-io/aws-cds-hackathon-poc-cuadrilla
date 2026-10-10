// Renders the AWS architecture diagram of the README (docs/assets/architecture/architecture.html →
// docs/assets/architecture.png) with Playwright's Chromium, at twice the page size so it stays sharp
// when zoomed. Run it after changing the HTML:
//
//   npm run diagram:architecture
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

const SOURCE = resolve("docs/assets/architecture/architecture.html");
const OUTPUT = resolve("docs/assets/architecture.png");
const VIEWPORT = { width: 1920, height: 1400 };

async function main(): Promise<void> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 2 });
    await page.goto(pathToFileURL(SOURCE).href, { waitUntil: "networkidle" });
    const broken = await page.$$eval("img", (images) => images.filter((image) => !image.complete || image.naturalWidth === 0).map((image) => image.getAttribute("src") ?? ""));
    if (broken.length > 0) throw new Error(`icons that did not load: ${broken.join(", ")}`);
    await page.locator("#canvas").screenshot({ path: OUTPUT });
    console.log(`render-architecture: wrote ${OUTPUT}`);
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  console.error(`render-architecture: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
