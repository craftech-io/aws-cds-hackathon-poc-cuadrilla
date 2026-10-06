// Dependency-free PDF 1.4 writer of the installation certificate (docs/architecture.md §11): A4
// pages, the standard Helvetica fonts in WinAnsi (pdf-text.ts), a flow of blocks (lines of text,
// label/value fields that wrap, rules and rows of JPEG thumbnails embedded with `DCTDecode`), a header
// and a footer on every page, and an information dictionary without creation or modification dates:
// the same input always gives the same bytes, so the `sha256` of `WorkOrders/CERT` identifies the
// document. Content streams are not compressed (their text is the `Tj` strings). Nothing here knows
// what a certificate says: render.ts lays the certificate out with the texts of copy/.
import { type JpegInfo, jpegInfo } from "./jpeg";
import { num, pdfString, textWidth, wrapText } from "./pdf-text";

export interface PdfTextBlock {
  readonly kind: "text";
  readonly text: string;
  readonly size?: number;
  readonly bold?: boolean;
  /** 0 black … 1 white. */
  readonly gray?: number;
  /** Points from the left margin. */
  readonly indent?: number;
  readonly gapBefore?: number;
}

/** A label in bold and its value beside it; the value wraps under itself. */
export interface PdfFieldBlock {
  readonly kind: "field";
  readonly label: string;
  readonly value: string;
  readonly gapBefore?: number;
}

export interface PdfRuleBlock {
  readonly kind: "rule";
  readonly gapBefore?: number;
}

export interface PdfImage {
  /** JPEG bytes, embedded as they are. */
  readonly jpeg: Uint8Array;
  readonly caption: string;
}

/** Thumbnails in rows of `perRow`, each with its caption under it. */
export interface PdfImagesBlock {
  readonly kind: "images";
  readonly images: readonly PdfImage[];
  readonly perRow?: number;
  readonly gapBefore?: number;
}

export type PdfBlock = PdfTextBlock | PdfFieldBlock | PdfRuleBlock | PdfImagesBlock;

export interface PdfDocumentSpec {
  /** Information dictionary (`Title`, `Producer`, …), in insertion order; never a date. */
  readonly info: Readonly<Record<string, string>>;
  /** Small grey lines at the top of every page. */
  readonly header: readonly string[];
  readonly blocks: readonly PdfBlock[];
  /** Lines at the bottom of every page; the page number goes after them as `n/m`. */
  readonly footer: readonly string[];
}

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN = 56;
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN;
const TOP_Y = 800;
const FOOTER_SIZE = 8;
const FOOTER_STEP = 11;
const FOOTER_BASE_Y = 36;
const HEADER_SIZE = 8;
const DEFAULT_SIZE = 10;
const FIELD_SIZE = 10;
const LABEL_WIDTH = 150;
const LEADING = 1.35;
const IMAGE_GAP = 12;
const MAX_IMAGE_HEIGHT = 150;
const CAPTION_SIZE = 8;

interface PlacedImage {
  readonly index: number;
  readonly info: JpegInfo;
}

class PageFlow {
  readonly pages: string[][] = [[]];
  private y: number;

  constructor(
    private readonly topY: number,
    private readonly bottomY: number,
  ) {
    this.y = topY;
  }

  /** Reserves `height` points (a new page when they do not fit) and returns the top of the space. */
  take(height: number, gapBefore: number): number {
    const gap = this.y === this.topY ? 0 : gapBefore;
    if (this.y - gap - height < this.bottomY && this.y !== this.topY) {
      this.pages.push([]);
      this.y = this.topY;
    } else {
      this.y -= gap;
    }
    const top = this.y;
    this.y -= height;
    return top;
  }

  draw(op: string): void {
    this.pages.at(-1)?.push(op);
  }
}

function textOp(text: string, x: number, baseline: number, size: number, bold = false, gray = 0): string {
  const color = gray === 0 ? "" : `${num(gray)} g `;
  return `${color}BT /${bold ? "F2" : "F1"} ${num(size)} Tf ${num(x)} ${num(baseline)} Td ${pdfString(text)} Tj ET${gray === 0 ? "" : " 0 g"}`;
}

function lineHeight(size: number): number {
  return size * LEADING;
}

function layoutText(flow: PageFlow, block: PdfTextBlock): void {
  const size = block.size ?? DEFAULT_SIZE;
  const indent = Math.min(Math.max(block.indent ?? 0, 0), CONTENT_WIDTH / 2);
  for (const [index, line] of wrapText(block.text, CONTENT_WIDTH - indent, size, block.bold).entries()) {
    const top = flow.take(lineHeight(size), index === 0 ? (block.gapBefore ?? 0) : 0);
    flow.draw(textOp(line, MARGIN + indent, top - size, size, block.bold, block.gray));
  }
}

function layoutField(flow: PageFlow, block: PdfFieldBlock): void {
  const labels = wrapText(block.label, LABEL_WIDTH - 8, FIELD_SIZE, true);
  const values = wrapText(block.value, CONTENT_WIDTH - LABEL_WIDTH, FIELD_SIZE);
  const rows = Math.max(labels.length, values.length);
  for (let row = 0; row < rows; row += 1) {
    const top = flow.take(lineHeight(FIELD_SIZE), row === 0 ? (block.gapBefore ?? 0) : 0);
    const label = labels[row];
    const value = values[row];
    if (label !== undefined && label !== "") flow.draw(textOp(label, MARGIN, top - FIELD_SIZE, FIELD_SIZE, true));
    if (value !== undefined && value !== "") flow.draw(textOp(value, MARGIN + LABEL_WIDTH, top - FIELD_SIZE, FIELD_SIZE));
  }
}

function layoutRule(flow: PageFlow, block: PdfRuleBlock): void {
  const top = flow.take(6, block.gapBefore ?? 0);
  const y = top - 3;
  flow.draw(`0.6 G 0.8 w ${MARGIN} ${num(y)} m ${MARGIN + CONTENT_WIDTH} ${num(y)} l S 0 G`);
}

function layoutImages(flow: PageFlow, block: PdfImagesBlock, placed: readonly PlacedImage[]): void {
  const perRow = Math.max(1, block.perRow ?? 3);
  const cellWidth = (CONTENT_WIDTH - IMAGE_GAP * (perRow - 1)) / perRow;
  for (let start = 0; start < placed.length; start += perRow) {
    const row = placed.slice(start, start + perRow);
    const sizes = row.map(({ info }) => {
      const scale = Math.min(cellWidth / info.width, MAX_IMAGE_HEIGHT / info.height);
      return { width: info.width * scale, height: info.height * scale };
    });
    const imageHeight = Math.max(...sizes.map((size) => size.height));
    const top = flow.take(imageHeight + lineHeight(CAPTION_SIZE) + 4, start === 0 ? (block.gapBefore ?? 0) : IMAGE_GAP);
    row.forEach(({ index }, column) => {
      const size = sizes[column] ?? { width: cellWidth, height: imageHeight };
      const x = MARGIN + column * (cellWidth + IMAGE_GAP);
      flow.draw(`q ${num(size.width)} 0 0 ${num(size.height)} ${num(x)} ${num(top - size.height)} cm /Im${index + 1} Do Q`);
      const caption = wrapText(block.images[start + column]?.caption ?? "", cellWidth, CAPTION_SIZE)[0] ?? "";
      flow.draw(textOp(caption, x, top - imageHeight - CAPTION_SIZE - 2, CAPTION_SIZE, false, 0.3));
    });
  }
}

function imageObject(jpeg: Uint8Array, info: JpegInfo): Buffer {
  const colorSpace = info.components === 1 ? "/DeviceGray" : info.components === 4 ? "/DeviceCMYK /Decode [1 0 1 0 1 0 1 0]" : "/DeviceRGB";
  const head = `<< /Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height} /ColorSpace ${colorSpace} /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.byteLength} >>\nstream\n`;
  return Buffer.concat([Buffer.from(head, "latin1"), Buffer.from(jpeg), Buffer.from("\nendstream", "latin1")]);
}

function pageDecorations(spec: PdfDocumentSpec, pageNo: number, pageCount: number): string[] {
  const ops = spec.header.map((line, index) => textOp(line, MARGIN, PAGE_HEIGHT - 28 - index * (HEADER_SIZE + 3), HEADER_SIZE, false, 0.4));
  const footer = [...spec.footer, `${pageNo}/${pageCount}`];
  footer.forEach((line, index) => {
    const y = FOOTER_BASE_Y + (footer.length - 1 - index) * FOOTER_STEP;
    const width = textWidth(line, FOOTER_SIZE);
    const x = index === footer.length - 1 ? MARGIN + CONTENT_WIDTH - width : MARGIN;
    ops.push(textOp(line, x, y, FOOTER_SIZE, false, 0.35));
  });
  return ops;
}

function infoDictionary(info: Readonly<Record<string, string>>): string {
  const entries = Object.entries(info).map(([key, value]) => {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key)) throw new RangeError(`invalid PDF name ${key}`);
    if (/Date$/.test(key)) throw new RangeError("the certificate carries no dates in its information dictionary");
    return `/${key} ${pdfString(value)}`;
  });
  return `<< ${entries.join(" ")} >>`;
}

/** The PDF bytes of `spec`: identical input, identical bytes. Throws `InvalidJpegError` for a bad image. */
export function writePdf(spec: PdfDocumentSpec): Uint8Array {
  const images = spec.blocks.flatMap((block) => (block.kind === "images" ? block.images : []));
  const infos = images.map((image) => jpegInfo(image.jpeg));
  const headerHeight = spec.header.length * (HEADER_SIZE + 3);
  const footerHeight = (spec.footer.length + 1) * FOOTER_STEP;
  const flow = new PageFlow(TOP_Y - headerHeight, FOOTER_BASE_Y + footerHeight + 12);
  let imageIndex = 0;
  for (const block of spec.blocks) {
    if (block.kind === "text") layoutText(flow, block);
    else if (block.kind === "field") layoutField(flow, block);
    else if (block.kind === "rule") layoutRule(flow, block);
    else {
      const placed = block.images.map((_, offset) => ({ index: imageIndex + offset, info: infos[imageIndex + offset] as JpegInfo }));
      imageIndex += block.images.length;
      layoutImages(flow, block, placed);
    }
  }

  // Objects: 1 catalog, 2 page tree, 3-4 fonts, the images, then a page and its content per page, the info.
  const firstImage = 5;
  const firstPage = firstImage + images.length;
  const pageCount = flow.pages.length;
  const pageRefs = flow.pages.map((_, index) => firstPage + index * 2);
  const xObjects = images.map((_, index) => `/Im${index + 1} ${firstImage + index} 0 R`).join(" ");
  const resources = `<< /Font << /F1 3 0 R /F2 4 0 R >>${images.length === 0 ? "" : ` /XObject << ${xObjects} >>`} >>`;
  const objects: Buffer[] = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "latin1"),
    Buffer.from(`<< /Type /Pages /Kids [${pageRefs.map((ref) => `${ref} 0 R`).join(" ")}] /Count ${pageCount} >>`, "latin1"),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>", "latin1"),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>", "latin1"),
    ...images.map((image, index) => imageObject(image.jpeg, infos[index] as JpegInfo)),
  ];
  flow.pages.forEach((ops, index) => {
    const content = `${[...pageDecorations(spec, index + 1, pageCount), ...ops].join("\n")}\n`;
    objects.push(Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources ${resources} /Contents ${firstPage + index * 2 + 1} 0 R >>`, "latin1"));
    objects.push(Buffer.from(`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}endstream`, "latin1"));
  });
  objects.push(Buffer.from(infoDictionary(spec.info), "latin1"));
  const infoRef = objects.length;

  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  let length = chunks[0]?.byteLength ?? 0;
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(length);
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`, "latin1"), body, Buffer.from("\nendobj\n", "latin1")]);
    chunks.push(chunk);
    length += chunk.byteLength;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)].join("");
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${infoRef} 0 R >>\nstartxref\n${length}\n%%EOF\n`;
  chunks.push(Buffer.from(xref + trailer, "latin1"));
  return new Uint8Array(Buffer.concat(chunks));
}
