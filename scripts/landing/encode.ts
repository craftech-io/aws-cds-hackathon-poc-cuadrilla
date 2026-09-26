// From the PNG of a picture to what the landing serves, with the ffmpeg build the repository already
// carries (ffmpeg-static, a dev dependency): the hash of its pixels (decoded to raw RGBA, so the PNG
// encoder never decides whether a picture changed) and each AVIF and WebP file of its `srcset`. Each
// run of ffmpeg is a local process with a deadline; nothing leaves the machine.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegPath from "ffmpeg-static";
import { type Variant, pngSize, sha256 } from "./captures";

const DEADLINE_MS = 120_000;

// Screens are text and flat colour: full chroma (4:4:4) keeps small letters sharp.
const ENCODER_ARGS: Readonly<Record<Variant["format"], readonly string[]>> = {
  avif: ["-c:v", "libaom-av1", "-still-picture", "1", "-crf", "30", "-b:v", "0", "-cpu-used", "4", "-pix_fmt", "yuv444p", "-f", "avif"],
  webp: ["-c:v", "libwebp", "-quality", "82", "-compression_level", "6", "-f", "webp"],
};

function ffmpeg(args: readonly string[], input?: Buffer): Promise<Buffer> {
  const binary = ffmpegPath as unknown as string | null;
  if (!binary) return Promise.reject(new Error("ffmpeg-static has no binary for this platform"));
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ["-hide_banner", "-loglevel", "error", ...args], { stdio: ["pipe", "pipe", "pipe"], timeout: DEADLINE_MS });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg ${signal ? `stopped by ${signal}` : `exited ${String(code)}`}: ${Buffer.concat(err).toString("utf8").trim().slice(0, 500)}`));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

/** Hash of the picture's pixels (raw RGBA) and its size. */
export async function pixelsOf(png: Buffer): Promise<{ readonly sha256: string; readonly width: number; readonly height: number }> {
  const size = pngSize(png);
  const raw = await ffmpeg(["-f", "png_pipe", "-i", "pipe:0", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], png);
  if (raw.byteLength !== size.width * size.height * 4) throw new Error("the decoded picture does not have the PNG's size");
  return { sha256: sha256(raw), ...size };
}

/** One file of the picture's `srcset`: scaled with Lanczos when it is not the full size, without metadata. */
export async function encodeVariant(png: Buffer, variant: Variant): Promise<Buffer> {
  // The AVIF muxer writes its index at the end of the file, so it needs a seekable output.
  const dir = mkdtempSync(join(tmpdir(), "landing-capture-"));
  const input = join(dir, "in.png");
  const output = join(dir, `out.${variant.format}`);
  try {
    writeFileSync(input, png);
    const { width } = pngSize(png);
    const scale = variant.width === width ? [] : ["-vf", `scale=${variant.width}:${variant.height}:flags=lanczos`];
    await ffmpeg(["-y", "-i", input, ...scale, "-map_metadata", "-1", ...ENCODER_ARGS[variant.format], output]);
    return readFileSync(output);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
