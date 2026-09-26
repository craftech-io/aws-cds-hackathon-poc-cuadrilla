// HTTP transport to a Lambda Function URL with `AuthType AWS_IAM`: every request is signed with AWS
// Signature V4 (service `lambda`, the region of the URL) using the function's own role credentials.
// The client (client.ts) owns timeouts, retries and error mapping; this module only signs and sends,
// so tests and local flows swap it for an in-process transport with the same shape.
import { Sha256 } from "@aws-crypto/sha256-js";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { SignatureV4 } from "@smithy/signature-v4";

export interface HttpRequest {
  readonly method: "GET" | "POST";
  /** Absolute path, no query string: `/v1/onus/DEMO3F2C19A0`. */
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface HttpResponse {
  readonly status: number;
  /** Lower-case header names. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export type HttpTransport = (request: HttpRequest, signal: AbortSignal) => Promise<HttpResponse>;

type Credentials = ConstructorParameters<typeof SignatureV4>[0]["credentials"];

export interface SigV4TransportOptions {
  /** The Function URL, e.g. `https://abc123.lambda-url.us-east-1.on.aws/`. */
  readonly baseUrl: string;
  /** Defaults to the Lambda role's credentials (the Node provider chain). */
  readonly credentials?: Credentials;
  readonly fetch?: typeof fetch;
  /** Signing time is real time by definition (SigV4 rejects skews over 5 min); tests fix it. */
  readonly now?: () => Date;
}

const FUNCTION_URL_HOST = /^[a-z0-9]+\.lambda-url\.([a-z0-9-]+)\.on\.aws$/;

/** Region of a Function URL, which is also its signing region. */
export function functionUrlRegion(url: URL): string {
  const region = FUNCTION_URL_HOST.exec(url.hostname)?.[1];
  if (region === undefined) throw new RangeError("not a Lambda Function URL");
  return region;
}

export function sigv4Transport(options: SigV4TransportOptions): HttpTransport {
  const base = new URL(options.baseUrl);
  if (base.protocol !== "https:") throw new RangeError("a Function URL is https");
  const signer = new SignatureV4({
    service: "lambda",
    region: functionUrlRegion(base),
    credentials: options.credentials ?? defaultProvider(),
    sha256: Sha256,
  });
  const send = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());

  return async (request, signal) => {
    const headers: Record<string, string> = { host: base.host };
    for (const [name, value] of Object.entries(request.headers)) headers[name.toLowerCase()] = value;
    if (request.body !== undefined) headers["content-type"] ??= "application/json";
    const signed = await signer.sign(
      { method: request.method, protocol: base.protocol, hostname: base.hostname, path: request.path, query: {}, headers, ...(request.body === undefined ? {} : { body: request.body }) },
      { signingDate: now() },
    );
    // fetch sets Host from the URL itself (the same value that was signed).
    const { host: _host, ...sent } = signed.headers;
    const response = await send(new URL(request.path, base), {
      method: request.method,
      headers: sent,
      ...(request.body === undefined ? {} : { body: request.body }),
      signal,
    });
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      responseHeaders[name.toLowerCase()] = value;
    });
    return { status: response.status, headers: responseHeaders, body: await response.text() };
  };
}
