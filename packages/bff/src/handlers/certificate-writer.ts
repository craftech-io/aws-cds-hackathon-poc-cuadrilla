/// <reference path="../../sst-env.d.ts" />
// `CertificateWriter` (docs/architecture.md §11, infra/certificates.ts): invoked synchronously by
// `close_installation` (ToolCases, or the InstallerWorker for a tap) with an `IssueCertificateRequest`
// and nothing else. It answers a `WriterResult`: the written certificate, or the code of an expected
// refusal (`NOT_COMPLETE`, `POLICY_DENIED` / `G3_BLOCKED`, `FORBIDDEN`). An unexpected failure throws,
// so the caller sees `FunctionError` and answers `UNAVAILABLE`; the writer is idempotent, so a retry
// returns the certificate already written. The deliveries are the caller's (certificates/port.ts).
import { IssueCertificateRequest } from "../agent-tools/common/ports";
import { bedrockG3 } from "../certificates/g3";
import { s3CertificateObjects } from "../certificates/store";
import { type WriterDeps, type WriterResult, writeCertificateResult } from "../certificates/writer";
import { connector } from "../connector/index";
import { type Logger, correlationIdFrom, createLogger } from "../lib/log";
import type { BrandConfigValue } from "../lib/secret-schemas";
import { brandConfig } from "../lib/secrets";

/** `BrandConfig`, or `undefined` (logged) when it cannot be read: the certificate then carries the neutral brand. */
function brandReader(logger: Logger): () => BrandConfigValue | undefined {
  return () => {
    try {
      return brandConfig();
    } catch (error) {
      logger.warn("certificate.brand_unavailable", { error });
      return undefined;
    }
  };
}

export async function handleCertificateWriter(deps: (logger: Logger) => WriterDeps, event: unknown): Promise<WriterResult> {
  const parsed = IssueCertificateRequest.safeParse(event);
  if (!parsed.success) return { ok: false, code: "INVALID", message: "CertificateWriter takes an IssueCertificateRequest and nothing else" };
  const logger = createLogger({ correlationId: correlationIdFrom(parsed.data.correlationId), bindings: { service: "certificate-writer" } });
  return writeCertificateResult(deps(logger), parsed.data);
}

function defaultDeps(logger: Logger): WriterDeps {
  return { connector: connector(), objects: s3CertificateObjects(), g3: bedrockG3(), brand: brandReader(logger), logger };
}

export async function handler(event: unknown): Promise<WriterResult> {
  return handleCertificateWriter(defaultDeps, event);
}
