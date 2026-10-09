// The design partner's logos (docs/pending.md §5, ADR-0018): two public SVGs the operator downloads with
// the CTO's approval, outside the repository, and `seed:load --brand-logo-on-light/--brand-logo-on-dark`
// uploads to `Seed/brand/`. A logo reaches every visitor's browser, so it is checked before upload:
//
//   size          at most 50 KB
//   well formed   one `<svg>` root, every element closed in order, no stray `<`
//   inert         no `<script>`, `<foreignObject>`, `<iframe>`, `<object>`, `<embed>`, no `on*` attribute,
//                 no DOCTYPE or entity, no `javascript:`
//   self-contained  no external reference: `href`/`xlink:href` only to `#fragment`s or an embedded
//                 raster (`data:image/png|jpeg|gif|webp;base64,…`), no `url(` that is not `url(#…)`, no `@import`
//
// A logo that fails is never uploaded; the reason names the rule, never the file's content.

export const MAX_LOGO_BYTES = 50 * 1024;

export class LogoRejected extends Error {
  override readonly name = "LogoRejected";
}

const FORBIDDEN_ELEMENTS = new Set(["script", "foreignobject", "iframe", "object", "embed", "handler", "listener"]);
const TAG = /<\s*(\/?)\s*([A-Za-z_][\w:.-]*)([^<>]*?)(\/?)\s*>/g;
const ATTRIBUTE = /([A-Za-z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
/** An image embedded in the file itself (a raster inside the logo): not a reference to anything outside. */
const EMBEDDED_RASTER = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/;

function stripInert(text: string): string {
  // Comments and the XML declaration carry no element; CDATA may only hold style text (checked below).
  return text.replace(/<!--[\s\S]*?-->/g, "").replace(/^﻿?\s*<\?xml[^?]*\?>/, "");
}

function checkAttributes(element: string, raw: string): void {
  for (const match of raw.matchAll(ATTRIBUTE)) {
    const name = (match[1] ?? "").toLowerCase();
    const value = (match[3] ?? match[4] ?? "").trim();
    if (name.startsWith("on")) throw new LogoRejected(`event handler attribute on <${element}>`);
    const local = value.startsWith("#") || EMBEDDED_RASTER.test(value);
    if ((name === "href" || name.endsWith(":href") || name === "src") && !local) throw new LogoRejected(`external reference on <${element}>`);
    if (/javascript:/i.test(value)) throw new LogoRejected(`script URL on <${element}>`);
    if (/url\(\s*['"]?(?!#)/i.test(value)) throw new LogoRejected(`external url() on <${element}>`);
  }
  const leftover = raw.replace(ATTRIBUTE, "").trim();
  if (leftover !== "" && leftover !== "/") throw new LogoRejected(`malformed attributes on <${element}>`);
}

/** Throws `LogoRejected` unless the bytes are a small, well-formed, inert and self-contained SVG. */
export function validateLogoSvg(bytes: Uint8Array): string {
  if (bytes.length === 0 || bytes.length > MAX_LOGO_BYTES) throw new LogoRejected(`a logo is 1 byte to ${MAX_LOGO_BYTES / 1024} KB`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new LogoRejected("not UTF-8 text");
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new LogoRejected("DOCTYPE or entity declarations");
  if (/@import|javascript:/i.test(text)) throw new LogoRejected("@import or a script URL");
  if (/url\(\s*['"]?(?!#)/i.test(text)) throw new LogoRejected("external url()");
  const body = stripInert(text).replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  const stack: string[] = [];
  let roots = 0;
  let cursor = 0;
  for (const match of body.matchAll(TAG)) {
    const between = body.slice(cursor, match.index);
    if (between.includes("<") || between.includes(">")) throw new LogoRejected("not well formed");
    cursor = (match.index ?? 0) + match[0].length;
    const [, closing, name = "", attributes = "", selfClosing] = match;
    const element = name.toLowerCase();
    if (FORBIDDEN_ELEMENTS.has(element.replace(/^.*:/, ""))) throw new LogoRejected(`<${name}> is not allowed`);
    if (closing === "/") {
      if (stack.pop() !== name) throw new LogoRejected("not well formed");
      continue;
    }
    checkAttributes(name, attributes);
    if (stack.length === 0) {
      roots += 1;
      if (element !== "svg") throw new LogoRejected("the root element is not <svg>");
    }
    if (selfClosing !== "/") stack.push(name);
  }
  const tail = body.slice(cursor);
  if (tail.includes("<") || tail.includes(">") || stack.length > 0 || roots !== 1) throw new LogoRejected("not well formed");
  return text;
}
