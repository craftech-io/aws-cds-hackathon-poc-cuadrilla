// The local stand-in of S3 for the UI server (docs/test-plan.md §2, level UI): the presigned links the
// console ports issue point here (`<origin>/s3/<bucket>/<key>`), over the same memory the BFF reads.
//
//   GET  /s3/<bucket>/<key>?response-content-type=…[&response-content-disposition=…]
//        the object with the type the link fixed (never the stored one) and `nosniff`
//   POST /s3/Media   multipart/form-data with the presigned fields and `file` last, checked as the
//        policy of a presigned POST is: the key the link names, `Content-Type` equal to the field, a
//        size between 1 and `x-max-bytes`; 204 on success, 403 otherwise, as S3 answers
import type { IncomingMessage, ServerResponse } from "node:http";
import type { BucketName } from "../../packages/bff/src/lib/resource";
import type { MemoryObjects } from "../../packages/bff/src/routers/console-testing";

const BUCKETS: readonly BucketName[] = ["Media", "Evidence", "Manual", "Seed"];
const MAX_BODY_BYTES = 20 * 1024 * 1024;

async function bodyOf(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new RangeError("body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

interface Part {
  readonly name: string;
  readonly contentType?: string;
  readonly data: Buffer;
}

/** The parts of a multipart/form-data body. */
export function multipartParts(body: Buffer, contentType: string): Part[] {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const marker = boundary?.[1] ?? boundary?.[2];
  if (marker === undefined) return [];
  const delimiter = Buffer.from(`--${marker}`);
  const parts: Part[] = [];
  let start = body.indexOf(delimiter);
  while (start !== -1) {
    const next = body.indexOf(delimiter, start + delimiter.length);
    if (next === -1) break;
    const chunk = body.subarray(start + delimiter.length + 2, next - 2);
    const headerEnd = chunk.indexOf("\r\n\r\n");
    if (headerEnd !== -1) {
      const headers = chunk.subarray(0, headerEnd).toString("utf8");
      const name = /name="([^"]+)"/i.exec(headers)?.[1];
      const type = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim();
      if (name !== undefined) parts.push({ name, ...(type === undefined ? {} : { contentType: type }), data: chunk.subarray(headerEnd + 4) });
    }
    start = next;
  }
  return parts;
}

function refuse(response: ServerResponse, status: number): void {
  response.writeHead(status, { "content-type": "application/xml" });
  response.end(status === 403 ? "<Error><Code>AccessDenied</Code></Error>" : "<Error><Code>NoSuchKey</Code></Error>");
}

async function serveObject(objects: MemoryObjects, url: URL, response: ServerResponse): Promise<void> {
  const [, , bucket, ...rest] = url.pathname.split("/");
  const key = rest.map(decodeURIComponent).join("/");
  if (!BUCKETS.includes(bucket as BucketName) || key === "") return refuse(response, 404);
  const blob = await objects.get(bucket as BucketName, key);
  if (blob === undefined) return refuse(response, 404);
  const disposition = url.searchParams.get("response-content-disposition");
  response.writeHead(200, {
    "content-type": url.searchParams.get("response-content-type") ?? "application/octet-stream",
    "content-length": String(blob.bytes.length),
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
    ...(disposition === null ? {} : { "content-disposition": disposition }),
  });
  response.end(Buffer.from(blob.bytes));
}

async function receiveUpload(objects: MemoryObjects, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const parts = multipartParts(await bodyOf(request), request.headers["content-type"] ?? "");
  const field = (name: string) => parts.find((part) => part.name === name)?.data.toString("utf8");
  const key = field("key");
  const declared = field("Content-Type");
  const maxBytes = Number(field("x-max-bytes"));
  const file = parts.find((part) => part.name === "file");
  if (key === undefined || declared === undefined || file === undefined || !Number.isFinite(maxBytes)) return refuse(response, 403);
  if (file.data.length < 1 || file.data.length > maxBytes) return refuse(response, 403);
  objects.put("Media", key, new Uint8Array(file.data), declared);
  response.writeHead(204, { "access-control-allow-origin": request.headers.origin ?? "*" });
  response.end();
}

/** Answers `/s3/…`; false for any other path. */
export async function handleS3(objects: MemoryObjects, request: IncomingMessage, response: ServerResponse, origin: string): Promise<boolean> {
  const url = new URL(request.url ?? "/", origin);
  if (!url.pathname.startsWith("/s3/")) return false;
  if (request.method === "GET" || request.method === "HEAD") await serveObject(objects, url, response);
  else if (request.method === "POST" && url.pathname === "/s3/Media") await receiveUpload(objects, request, response);
  else refuse(response, 403);
  return true;
}
