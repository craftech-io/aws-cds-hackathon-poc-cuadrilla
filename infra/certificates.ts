// `CertificateWriter`, the installation certificate (docs/architecture.md §11 and §14, docs/build-plan.md
// WP-38; the code is WP-35's packages/bff/src/certificates/ behind handlers/certificate-writer.ts).
// `close_installation` invokes it (ToolCases, and the InstallerWorker for a "Cerrar instalación" tap):
// both link it, which grants `lambda:InvokeFunction` on it alone. It builds the content from the work
// order (never from the model's text), masks it and passes it through G3, writes the PDF with JPEG
// thumbnails to `Evidence/certificates/<workOrderId>/` and its `sha256` to `WorkOrders/CERT`; the caller
// enqueues the deliveries through the outbound pipeline.
//
// Least privilege (infra/iam-capabilities.ts): WorkOrders (read and CERT), People and Isps (read) by
// name with `storagePermissions`; `s3:GetObject` of `Evidence/photos/*` and `s3:PutObject` of
// `Evidence/certificates/*` only (Evidence linked by name); `bedrock:ApplyGuardrail` on G3 with the
// `GuardrailG3` link. BrandConfig for the brand line of `resolveBrand` (ADR-0018). No SES, no WhatsApp,
// no queue. 1024 MB, 30 s, reserved concurrency 5 (§12).
//
// Verify:
//   aws --profile craftech-demos lambda get-function-configuration --function-name <CertificateWriter name>   → Timeout 30, MemorySize 1024
//   aws --profile craftech-demos lambda get-function-concurrency --function-name <CertificateWriter name>   → 5

import { GuardrailG3 } from "./guardrail";
import { CERTIFICATE_WRITER, WP38_HANDLERS, statementGrants } from "./observability-spec";
import { BrandConfig } from "./secrets";
import { evidenceBucket, storageLinks, storagePermissions, storageResource } from "./storage";

const WRITER = "CertificateWriter";

/** Its object prefixes of Evidence (every other grant is G3, carried by the GuardrailG3 link). */
function prefixStatements(): Array<{ actions: string[]; resources: $util.Output<string>[] }> {
  return statementGrants(WRITER).map((grant) => ({
    actions: [...grant.actions],
    resources: grant.resources.map((resource) => {
      const resolved = storageResource(resource);
      if (resolved === undefined) throw new Error(`${WRITER}: "${resource}" is neither storage nor carried by a link (infra/certificates.ts).`);
      return resolved;
    }),
  }));
}

export const CertificateWriter = new sst.aws.Function(WRITER, {
  description: "Installation certificate: content from the order, masked and checked by G3, PDF with JPEG thumbnails in Evidence.",
  handler: WP38_HANDLERS.CertificateWriter,
  timeout: `${CERTIFICATE_WRITER.timeoutSeconds} seconds`,
  memory: `${CERTIFICATE_WRITER.memoryMb} MB`,
  concurrency: { reserved: CERTIFICATE_WRITER.reservedConcurrency },
  link: [...storageLinks(WRITER), evidenceBucket, GuardrailG3, BrandConfig],
  permissions: [...storagePermissions(WRITER), ...prefixStatements()],
});
