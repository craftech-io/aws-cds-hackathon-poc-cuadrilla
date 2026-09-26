// A generic optical rosette: a white box screwed to the wall, the black drop cable coming in from
// above and, at the bottom, the adapter with the green SC/APC connector of the yellow patch cord.
// With the lid open (ph-rosette-07) the fiber loop and the adapter inside are visible.
import { fmt } from "../prng";
import { type Scene, circle, rect, screw, verticalGradient } from "./common";

export interface RosetteDrawn {
  readonly lidOpen: boolean;
}

const WIDTH = 440;
const HEIGHT = 660;

/** The generic laser warning triangle printed on optical boxes. */
function laserWarning(cx: number, top: number): string {
  const rays = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
    const angle = (i * Math.PI) / 4;
    return `M${fmt(cx + 9 * Math.cos(angle))} ${fmt(top + 46 + 9 * Math.sin(angle))}L${fmt(cx + 17 * Math.cos(angle))} ${fmt(top + 46 + 17 * Math.sin(angle))}`;
  });
  return [
    `<path d="M${fmt(cx)} ${fmt(top)}L${fmt(cx + 40)} ${fmt(top + 70)}L${fmt(cx - 40)} ${fmt(top + 70)}Z" fill="#f2c318" stroke="#1d1d1d" stroke-width="5" stroke-linejoin="round"/>`,
    circle(cx, top + 46, 5, `fill="#1d1d1d"`),
    `<path d="${rays.join("")}M${fmt(cx + 5)} ${fmt(top + 46)}H${fmt(cx + 30)}" stroke="#1d1d1d" stroke-width="3" stroke-linecap="round"/>`,
  ].join("");
}

function openInterior(): string {
  return [
    rect({ x: 62, y: 52, w: 316, h: 406 }, `fill="#e6e6e0" stroke="#cfcfc8" stroke-width="3"`, 16),
    // Fiber tray and the stored loop of fiber.
    rect({ x: 96, y: 150, w: 248, h: 200 }, `fill="#dcdcd5" stroke="#c4c4bd" stroke-width="3"`, 20),
    `<ellipse cx="220" cy="250" rx="96" ry="70" fill="none" stroke="#e9d67e" stroke-width="5"/>`,
    `<ellipse cx="220" cy="250" rx="80" ry="58" fill="none" stroke="#e9d67e" stroke-width="5"/>`,
    `<path d="M220 52 C 220 110 150 140 150 200 M300 290 C 280 350 230 380 222 440" stroke="#e9d67e" stroke-width="5" fill="none"/>`,
    // Inner adapter with the connector seen from inside.
    rect({ x: 196, y: 400, w: 48, h: 56 }, `fill="#1f9d55" stroke="#157a40" stroke-width="3"`, 5),
    // The lid, swung open to the right.
    `<g transform="translate(400 30) skewY(8)">${rect({ x: 0, y: 0, w: 120, h: 450 }, `fill="url(#sc-box)" stroke="#c4c4bd" stroke-width="3"`, 18)}</g>`,
  ].join("");
}

export function rosetteScene(drawn: RosetteDrawn): Scene {
  const svg = [
    `<defs>${verticalGradient("sc-box", "#f7f7f3", "#e2e2dc")}</defs>`,
    // Drop cable from above, clipped to the wall.
    `<path d="M226 -520 C 226 -300 190 -160 220 34" stroke="#1b1b1b" stroke-width="13" fill="none" stroke-linecap="round"/>`,
    ...[-420, -300, -180].map((y) => rect({ x: 206, y, w: 40, h: 16 }, `fill="#efefe9" stroke="#c9c9c2" stroke-width="2"`, 4)),
    rect({ x: 40, y: 30, w: 360, h: 450 }, `fill="url(#sc-box)" stroke="#c5c5be" stroke-width="3"`, 26),
    drawn.lidOpen ? openInterior() : `${rect({ x: 62, y: 52, w: 316, h: 406 }, `fill="none" stroke="#d6d6cf" stroke-width="3"`, 18)}${screw(220, 92, 14)}${screw(220, 418, 14)}${laserWarning(220, 170)}`,
    circle(220, 34, 12, `fill="#2a2a2a"`),
    // Adapter, green SC/APC connector, boot and the yellow patch cord.
    rect({ x: 186, y: 478, w: 68, h: 34 }, `fill="#178a48" stroke="#11683a" stroke-width="2"`, 4),
    rect({ x: 192, y: 508, w: 56, h: 76 }, `fill="#22a35a" stroke="#157a40" stroke-width="3"`, 6),
    rect({ x: 203, y: 580, w: 34, h: 66 }, `fill="#1c8a4b"`, 12),
    `<path d="M220 644 C 220 760 300 830 460 880" stroke="#f0c419" stroke-width="14" fill="none" stroke-linecap="round"/>`,
  ].join("");
  return {
    width: WIDTH,
    height: HEIGHT,
    svg,
    regions: {
      box: { x: 40, y: 30, w: 360, h: 450 },
      connector: { x: 180, y: 470, w: 80, h: 180 },
      body: { x: 40, y: 30, w: 360, h: 620 },
    },
  };
}
