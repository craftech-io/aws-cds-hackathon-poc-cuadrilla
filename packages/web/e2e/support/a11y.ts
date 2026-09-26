// The checks every console spec runs on each screen it visits (docs/test-plan.md §3, "Consola"):
// basic accessibility (a page language, a main heading, every control and image with an accessible
// name) and texts a person can read (no raw codes, ids or tokens on screen).
import { expect, type Page } from "@playwright/test";

interface Findings {
  readonly lang: string;
  readonly headings: number;
  readonly unnamed: readonly string[];
  readonly text: string;
}

async function inspect(page: Page): Promise<Findings> {
  return page.evaluate(() => {
    const visible = (element: Element) => {
      const box = (element as HTMLElement).getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const named = (element: Element) => {
      if (element.getAttribute("aria-label")?.trim() || element.getAttribute("aria-labelledby")) return true;
      if (element instanceof HTMLImageElement) return element.alt.trim().length > 0;
      if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
        return (element.labels?.length ?? 0) > 0 || Boolean(element.title.trim());
      }
      return (element.textContent ?? "").trim().length > 0;
    };
    const controls = [...document.querySelectorAll("a[href], button, input:not([type=hidden]), select, textarea, img, [role=button]")].filter(visible);
    return {
      lang: document.documentElement.lang,
      headings: [...document.querySelectorAll("h1")].filter(visible).length,
      unnamed: controls.filter((element) => !named(element)).map((element) => element.outerHTML.slice(0, 120)),
      text: document.body.innerText,
    };
  });
}

// Enum codes (IN_REVIEW, WORLD_BUSY), ids with their prefix (isp-demo, wo-24817, usr-…), UUIDs
// (a Cognito sub) and JWTs are for machines; a screen shows their meaning.
const RAW = [
  /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/,
  /\b(?:isp|usr|wo|case|per|inst|sup|zc|crew|zone|ev|val|ph|vn)-[a-z0-9]+(?:-[a-z0-9]+)*\b/,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
  /\beyJ[A-Za-z0-9_-]{10,}\./,
];

/** Language, a main heading and a name on every visible control; nothing raw in the visible text. */
export async function expectReadableScreen(page: Page): Promise<void> {
  const findings = await inspect(page);
  expect(findings.lang, "the page declares its language").not.toBe("");
  expect(findings.headings, "the screen has a main heading").toBeGreaterThanOrEqual(1);
  expect(findings.unnamed, "every visible control and image has an accessible name").toEqual([]);
  for (const pattern of RAW) expect(findings.text, `no raw code or id on screen (${pattern.source})`).not.toMatch(pattern);
}
