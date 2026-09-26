// Wrong subjects of the set (docs/seed-spec.md §10): the front of a generic ONU without its label, a
// generic router, a reel of drop cable and the screenshot of a fake approval certificate (ph-adv-03).
// All generic and unbranded; their texts come from texts.ts.
import { strokeText } from "../glyphs";
import { ADVERSARIAL_TEXTS, CABLE_REEL_TEXTS, ONU_DEVICE_LEDS, ROUTER_PORTS } from "../texts";
import { type Scene, circle, rect, verticalGradient } from "./common";

export function onuDeviceScene(): Scene {
  const lit = new Set(["PWR", "PON", "LAN", "WIFI"]);
  const leds = ONU_DEVICE_LEDS.map((name, index) => {
    const cx = 200 + index * 150;
    const on = lit.has(name);
    return `${circle(cx, 160, 16, on ? `fill="#3ad35c" stroke="#1f8f3a" stroke-width="3"` : `fill="#5a2a2a" stroke="#3b1c1c" stroke-width="3"`)}${strokeText(name, cx, 206, 26, { color: "#4b4b47", weight: 0.14, anchor: "middle" })}`;
  });
  const slits = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => `M${300 + i * 55} 44v34`).join("");
  const svg = [
    `<defs>${verticalGradient("sc-onu", "#f2f1ec", "#d4d3cd")}</defs>`,
    rect({ x: 0, y: 0, w: 1000, h: 340 }, `fill="url(#sc-onu)" stroke="#b7b6af" stroke-width="3"`, 34),
    `<path d="${slits}" stroke="#bdbcb5" stroke-width="10" stroke-linecap="round"/>`,
    ...leds,
    rect({ x: 60, y: 300, w: 880, h: 20 }, `fill="#c9c8c1"`, 8),
  ].join("");
  return { width: 1000, height: 340, svg, regions: { body: { x: 0, y: 0, w: 1000, h: 340 } } };
}

export function routerScene(): Scene {
  const antennas = [150, 550, 950].map((x) => rect({ x: x - 23, y: 0, w: 46, h: 430 }, `fill="#26292d" stroke="#141618" stroke-width="3"`, 22));
  const leds = [0, 1, 2, 3, 4, 5].map((i) => circle(250 + i * 120, 470, 11, i === 4 ? `fill="#2a3a2c"` : `fill="#39d353"`));
  const ports = ROUTER_PORTS.map((name, index) => strokeText(name, 310 + index * 160, 560, 24, { color: "#8e949a", weight: 0.14, anchor: "middle" }));
  const svg = [
    `<defs>${verticalGradient("sc-router", "#2b2e33", "#16181b")}</defs>`,
    ...antennas,
    rect({ x: 0, y: 390, w: 1100, h: 290 }, `fill="url(#sc-router)" stroke="#0e0f11" stroke-width="4"`, 30),
    ...leds,
    ...ports,
  ].join("");
  return { width: 1100, height: 680, svg, regions: { body: { x: 0, y: 390, w: 1100, h: 290 } } };
}

export function cableReelScene(): Scene {
  const rings = Array.from({ length: 24 }, (_, i) => circle(410, 410, 110 + i * 8, `fill="none" stroke="#2e2e2e" stroke-width="2"`));
  const bolts = [0, 1, 2, 3].map((i) => circle(410 + 150 * Math.cos((i * Math.PI) / 2 + 0.6), 410 + 150 * Math.sin((i * Math.PI) / 2 + 0.6), 10, `fill="#3b2a18"`));
  const svg = [
    circle(410, 410, 404, `fill="#c79c66" stroke="#8f6a3c" stroke-width="6"`),
    circle(410, 410, 306, `fill="#161616"`),
    ...rings,
    circle(410, 410, 104, `fill="#c79c66" stroke="#8f6a3c" stroke-width="4"`),
    circle(410, 410, 40, `fill="#3b2a18"`),
    ...bolts,
    strokeText(CABLE_REEL_TEXTS[0], 410, 44, 30, { color: "#3a2a17", weight: 0.15, anchor: "middle" }),
    strokeText(CABLE_REEL_TEXTS[1], 410, 744, 30, { color: "#3a2a17", weight: 0.15, anchor: "middle" }),
  ].join("");
  return { width: 820, height: 820, svg, regions: { body: { x: 0, y: 0, w: 820, h: 820 } } };
}

/** Full-frame screenshot of a document viewer: no background, no framing (ph-adv-03). */
export function fakeCertificateScene(): Scene {
  const text = ADVERSARIAL_TEXTS.fakeCertificate;
  const lines = text.lines.map((line, index) => strokeText(line, 180, 300 + index * 74, 28, { color: "#23272b", weight: 0.13 }));
  const svg = [
    rect({ x: 0, y: 0, w: 1280, h: 960 }, `fill="#eef1f4"`),
    rect({ x: 0, y: 0, w: 1280, h: 60 }, `fill="#111418"`),
    strokeText(text.statusBar, 40, 18, 24, { color: "#f2f2f2", weight: 0.14 }),
    rect({ x: 1170, y: 20, w: 60, h: 24 }, `fill="none" stroke="#f2f2f2" stroke-width="3"`, 4),
    rect({ x: 1174, y: 24, w: 40, h: 16 }, `fill="#f2f2f2"`, 2),
    rect({ x: 0, y: 60, w: 1280, h: 110 }, `fill="#3b4b5c"`),
    strokeText(text.title, 640, 92, 42, { color: "#ffffff", weight: 0.15, anchor: "middle" }),
    rect({ x: 120, y: 210, w: 1040, h: 700 }, `fill="#ffffff" stroke="#d3d8de" stroke-width="3"`, 12),
    ...lines,
    circle(960, 690, 118, `fill="none" stroke="#1f9d55" stroke-width="16"`),
    strokeText("✓", 960, 630, 120, { color: "#1f9d55", weight: 0.16, anchor: "middle" }),
    strokeText(text.seal, 640, 836, 30, { color: "#1f9d55", weight: 0.15, anchor: "middle" }),
  ].join("");
  return { width: 1280, height: 960, svg, regions: { body: { x: 0, y: 0, w: 1280, h: 960 } } };
}
