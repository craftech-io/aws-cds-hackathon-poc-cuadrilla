// Text of the certificate PDF: the standard Helvetica fonts in WinAnsiEncoding, so no font is
// embedded. Every character is written as its WinAnsi byte (a character outside the encoding becomes
// "?", never an error: a name or a reason may carry anything), string literals stay pure ASCII
// (bytes above 0x7E in octal) and lines wrap by the fonts' metrics. Pure functions, shared by the
// writer (pdf.ts) and its tests.

// WinAnsiEncoding: Latin-1 above 0xA0 plus a few code points of 0x80-0x9F.
const WIN_ANSI_EXTRA: Readonly<Record<string, number>> = { "€": 0x80, "…": 0x85, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "−": 0x2d };

/** The WinAnsi byte of one character; `?` when the encoding has none. */
function winAnsiByte(char: string): number {
  const code = char.codePointAt(0) ?? 0x3f;
  if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) return code;
  return WIN_ANSI_EXTRA[char] ?? 0x3f;
}

/** Whitespace and control characters collapse to one space: a field never breaks the layout. */
export function cleanText(text: string): string {
  return text.replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
}

export function winAnsiBytes(text: string): number[] {
  return [...cleanText(text)].map(winAnsiByte);
}

/** A PDF literal string in pure ASCII: parentheses and backslash escaped, bytes above 0x7E in octal. */
export function pdfString(text: string): string {
  let out = "(";
  for (const byte of winAnsiBytes(text)) {
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) out += `\\${String.fromCharCode(byte)}`;
    else if (byte > 0x7e) out += `\\${byte.toString(8).padStart(3, "0")}`;
    else out += String.fromCharCode(byte);
  }
  return `${out})`;
}

// Advance widths of Helvetica (AFM, 1/1000 em) for 0x20-0x7E; Helvetica-Bold is close enough to
// wrap with the same table scaled up, which only makes bold lines wrap a little earlier.
const HELVETICA_ASCII = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
  611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
  222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const BOLD_SCALE = 1.06;
const DEFAULT_WIDTH = 556;

function charWidth(byte: number): number {
  if (byte >= 0x20 && byte <= 0x7e) return HELVETICA_ASCII[byte - 0x20] ?? DEFAULT_WIDTH;
  if (byte === 0xb7) return 278;
  // Accented letters of Latin-1 take the width of their base letter.
  const base = String.fromCharCode(byte).normalize("NFD").charCodeAt(0);
  return base >= 0x20 && base <= 0x7e ? (HELVETICA_ASCII[base - 0x20] ?? DEFAULT_WIDTH) : DEFAULT_WIDTH;
}

/** Width of `text` in points at `size`. */
export function textWidth(text: string, size: number, bold = false): number {
  const units = winAnsiBytes(text).reduce((total, byte) => total + charWidth(byte), 0);
  return (units * size * (bold ? BOLD_SCALE : 1)) / 1000;
}

/** Splits a word wider than the line into pieces that fit. */
function breakWord(word: string, maxWidth: number, size: number, bold: boolean): string[] {
  const pieces: string[] = [];
  let piece = "";
  for (const char of word) {
    if (piece !== "" && textWidth(piece + char, size, bold) > maxWidth) {
      pieces.push(piece);
      piece = "";
    }
    piece += char;
  }
  if (piece !== "") pieces.push(piece);
  return pieces;
}

/** `text` in lines no wider than `maxWidth` points; an empty text is one empty line. */
export function wrapText(text: string, maxWidth: number, size: number, bold = false): string[] {
  const words = cleanText(text).split(" ").filter((word) => word !== "");
  const lines: string[] = [];
  let line = "";
  for (const word of words.flatMap((candidate) => (textWidth(candidate, size, bold) > maxWidth ? breakWord(candidate, maxWidth, size, bold) : [candidate]))) {
    const next = line === "" ? word : `${line} ${word}`;
    if (line !== "" && textWidth(next, size, bold) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  lines.push(line);
  return lines;
}

/** Two decimals at most, no exponent: coordinates written the same way on every machine. */
export function num(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError("a PDF number must be finite");
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}
