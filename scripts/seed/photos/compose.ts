// Turns a photo spec into the HTML page Chromium screenshots: procedural background, the subject
// with its framing (tilt, offset, perspective, rotation, zoom, crop, close-up), glare over a target
// region, and the camera-level degradations (gaussian and motion blur, underexposure), then the
// vignette and the color cast of a phone camera. Framing comes from the photo's own stream and is
// recorded in the datasheet; the JPEG quality is the last degradation, applied by the screenshot.
import { createRng, fmt, seedFor } from "./prng";
import { backgroundSvg } from "./scenes/background";
import type { Rect, Scene } from "./scenes/common";
import { labelScene } from "./scenes/label";
import { meterScene } from "./scenes/meter";
import { cableReelScene, fakeCertificateScene, onuDeviceScene, routerScene } from "./scenes/props";
import { rosetteScene } from "./scenes/rosette";
import { type BackgroundKind, type Degradation, type Drawn, type Framing, PHOTO_FORMAT, type PhotoSpec } from "./schema";

const W = PHOTO_FORMAT.width;
const H = PHOTO_FORMAT.height;
const DEFAULT_QUALITY = 80;

/** The scene of a photo; an occlusion is drawn by the scene itself (the finger over the digits). */
export function sceneFor(drawn: Drawn, degradations: readonly Degradation[] = []): Scene {
  switch (drawn.template) {
    case "meter":
      return meterScene({ ...drawn, finger: degradations.some((d) => d.kind === "occlusion") });
    case "label":
      return labelScene(drawn);
    case "rosette":
      return rosetteScene(drawn);
    case "onu-device":
      return onuDeviceScene();
    case "router":
      return routerScene();
    case "cable-reel":
      return cableReelScene();
    case "fake-certificate":
      return fakeCertificateScene();
  }
}

function find<K extends Degradation["kind"]>(spec: PhotoSpec, kind: K): Extract<Degradation, { kind: K }> | undefined {
  return spec.degradations.find((d): d is Extract<Degradation, { kind: K }> => d.kind === kind);
}

function region(scene: Scene, name: string): Rect {
  const found = scene.regions[name];
  if (found === undefined) throw new RangeError(`scene has no region "${name}"`);
  return found;
}

/** The random part of a render, from the photo's stream: background, tilt, offset, fill, cast. */
export function planFraming(spec: PhotoSpec): Framing {
  const rng = createRng(seedFor("photo", spec.photoId));
  const fullFrame = spec.drawn.template === "fake-certificate";
  const pinned = find(spec, "crop") !== undefined || find(spec, "close-up") !== undefined || fullFrame;
  const defaultBackground: BackgroundKind = spec.drawn.template === "rosette" ? "wall" : rng.pick(["wood", "sidewalk", "wall", "wood"] as const);
  const background = fullFrame ? "none" : (spec.background ?? defaultBackground);
  const round = (value: number) => Math.round(value * 100) / 100;
  const tiltDeg = pinned ? 0 : round(rng.range(-4, 4));
  const offsetX = pinned ? 0 : round(rng.range(-40, 40));
  const offsetY = pinned ? 0 : round(rng.range(-26, 26));
  const fill = fullFrame ? 1 : (find(spec, "zoom-out")?.fill ?? round(rng.range(0.74, 0.84)));
  const cast = rng.pick(["neutral", "warm", "cool", "neutral"] as const);
  const jpegQuality = find(spec, "jpeg-quality")?.quality ?? DEFAULT_QUALITY;
  return { background, backgroundSeed: rng.int(1, 99999), tiltDeg, offsetX, offsetY, fill, cast, jpegQuality };
}

interface Placement {
  readonly centerX: number;
  readonly centerY: number;
  readonly scale: number;
}

function placement(spec: PhotoSpec, scene: Scene, framing: Framing): Placement {
  if (spec.drawn.template === "fake-certificate") return { centerX: W / 2, centerY: H / 2, scale: 1 };
  const rotation = find(spec, "rotation")?.angleDeg ?? 0;
  const quarter = Math.abs(Math.round(rotation / 90)) % 2 === 1;
  const [bw, bh] = quarter ? [scene.height, scene.width] : [scene.width, scene.height];
  const closeUp = find(spec, "close-up");
  if (closeUp !== undefined) {
    const target = region(scene, closeUp.target);
    const scale = (0.9 * H) / target.h;
    return { centerX: W / 2 - (target.x + target.w / 2 - scene.width / 2) * scale, centerY: H / 2 - (target.y + target.h / 2 - scene.height / 2) * scale, scale };
  }
  const scale = framing.fill * Math.min(W / bw, H / bh);
  const crop = find(spec, "crop");
  if (crop === undefined) return { centerX: W / 2 + framing.offsetX, centerY: H / 2 + framing.offsetY, scale };
  const target = region(scene, crop.target);
  const left = (target.x - scene.width / 2) * scale;
  const top = (target.y - scene.height / 2) * scale;
  const visibleW = crop.visibleFraction * target.w * scale;
  const visibleH = crop.visibleFraction * target.h * scale;
  switch (crop.edge) {
    case "right":
      return { centerX: W - visibleW - left, centerY: H / 2, scale };
    case "left":
      return { centerX: -(target.w * scale - visibleW) - left, centerY: H / 2, scale };
    case "bottom":
      return { centerX: W / 2, centerY: H - visibleH - top, scale };
    case "top":
      return { centerX: W / 2, centerY: -(target.h * scale - visibleH) - top, scale };
  }
}

function glareOverlay(spec: PhotoSpec, scene: Scene): string {
  const glare = find(spec, "glare");
  if (glare === undefined) return "";
  const target = region(scene, glare.target);
  const cx = target.x + target.w / 2;
  const cy = target.y + target.h / 2;
  return [
    `<defs><radialGradient id="sc-glare"><stop offset="0" stop-color="#ffffff" stop-opacity="${fmt(glare.opacity)}"/>`,
    `<stop offset="0.55" stop-color="#ffffff" stop-opacity="${fmt(glare.opacity)}"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient></defs>`,
    `<ellipse cx="${fmt(cx)}" cy="${fmt(cy)}" rx="${fmt((target.w / 2) * glare.spread)}" ry="${fmt((target.h / 2) * glare.spread * 1.3)}" fill="url(#sc-glare)"/>`,
  ].join("");
}

function cameraFilter(spec: PhotoSpec): string {
  const parts: string[] = [];
  const motion = find(spec, "motion-blur");
  if (motion !== undefined) parts.push("url(#motion)");
  const blur = find(spec, "gaussian-blur");
  if (blur !== undefined) parts.push(`blur(${fmt(blur.radiusPx)}px)`);
  const dark = find(spec, "underexposure");
  if (dark !== undefined) parts.push(`brightness(${fmt(dark.brightness)})`, "contrast(0.92)");
  return parts.length === 0 ? "none" : parts.join(" ");
}

/** Sensor noise of a photo taken in the dark: it swamps what little contrast is left. */
function darkGrain(spec: PhotoSpec, seed: number): string {
  const dark = find(spec, "underexposure");
  if (dark === undefined || dark.brightness >= 0.2) return "";
  return [
    `<svg class="over" width="${W}" height="${H}"><filter id="grain" x="0" y="0" width="100%" height="100%">`,
    `<feTurbulence type="fractalNoise" baseFrequency="0.55" numOctaves="1" seed="${seed}"/>`,
    `<feColorMatrix type="matrix" values="0 0 0 0 0.5 0 0 0 0 0.5 0 0 0 0 0.52 1.1 0 0 0 -0.47"/></filter>`,
    `<rect width="${W}" height="${H}" filter="url(#grain)"/></svg>`,
  ].join("");
}

const CAST: Readonly<Record<Framing["cast"], string>> = {
  neutral: "rgba(0,0,0,0)",
  warm: "rgba(255,170,80,0.06)",
  cool: "rgba(80,140,255,0.05)",
};

/** The full page for one photo: a 1280 × 960 frame, nothing else, no text nodes. */
export function composeHtml(spec: PhotoSpec, framing: Framing): string {
  const scene = sceneFor(spec.drawn, spec.degradations);
  const place = placement(spec, scene, framing);
  const perspective = find(spec, "perspective")?.angleDeg ?? 0;
  const rotation = (find(spec, "rotation")?.angleDeg ?? 0) + framing.tiltDeg;
  const fullFrame = spec.drawn.template === "fake-certificate";
  const transform = `perspective(1800px) rotateY(${fmt(perspective)}deg) rotate(${fmt(rotation)}deg) scale(${fmt(place.scale)})`;
  const motion = find(spec, "motion-blur");
  const shadow = fullFrame ? "none" : "drop-shadow(10px 16px 18px rgba(0,0,0,0.45))";
  return [
    `<!doctype html><html><head><meta charset="utf-8"><style>`,
    `html,body{margin:0;padding:0;background:#000;overflow:hidden}`,
    `#frame{position:relative;width:${W}px;height:${H}px;overflow:hidden}`,
    `#camera{position:absolute;left:0;top:0;width:${W}px;height:${H}px;filter:${cameraFilter(spec)}}`,
    `#subject{position:absolute;left:${fmt(place.centerX - scene.width / 2)}px;top:${fmt(place.centerY - scene.height / 2)}px;width:${scene.width}px;height:${scene.height}px;transform-origin:50% 50%;transform:${transform};filter:${shadow}}`,
    `svg{display:block;overflow:visible}`,
    `.over{position:absolute;left:0;top:0;width:${W}px;height:${H}px}`,
    `</style></head><body>`,
    `<svg width="0" height="0" style="position:absolute"><filter id="motion" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="${fmt(motion?.lengthPx ?? 0)} 0"/></filter></svg>`,
    `<div id="frame"><div id="camera">`,
    backgroundSvg(framing.background, framing.backgroundSeed),
    `<div id="subject"><svg width="${scene.width}" height="${scene.height}" viewBox="0 0 ${scene.width} ${scene.height}">${scene.svg}${glareOverlay(spec, scene)}</svg></div>`,
    fullFrame ? "" : `<div class="over" style="background:radial-gradient(ellipse at 46% 42%,rgba(255,255,255,0.06) 0%,rgba(0,0,0,0) 55%,rgba(0,0,0,0.32) 100%)"></div>`,
    `<div class="over" style="background:${CAST[framing.cast]}"></div>`,
    `</div>`,
    darkGrain(spec, framing.backgroundSeed),
    `</div></body></html>`,
  ].join("");
}
