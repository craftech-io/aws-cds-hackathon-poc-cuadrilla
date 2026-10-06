/// <reference path="../../sst-env.d.ts" />
// `CertificatePort` (agent-tools/common/ports.ts), as `close_installation` uses it from ToolCases or
// from the InstallerWorker (a "Cerrar instalación" tap): the `CertificateWriter` Lambda writes the PDF
// and `CERT` and closes the order (writer.ts), then the deliveries go out from here, through the
// outbound pipeline this Lambda carries (deliveries.ts). A G3 block opens the `OTHER` case here, in the
// caller, which has `Cases` (the writer does not), and answers `POLICY_DENIED`.
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { z } from "zod";
import { ToolError } from "@cuadrilla/shared";
import { type CertificatePort, IssueCertificateRequest, IssuedCertificate } from "../agent-tools/common/ports";
import { CLIENT_TIMEOUTS, awsClientConfig } from "../lib/clients";
import { readLinked } from "../lib/resource";
import { type DeliveryDeps, deliverCertificate, queuedDeliveries } from "./deliveries";
import { type WriterDeps, WriterResult, writeCertificateResult } from "./writer";

/** How the caller reaches the writer: the linked Lambda, or the writer in process (tests, local flows). */
export interface CertificateWriterInvoker {
  write(request: IssueCertificateRequest): Promise<WriterResult>;
}

const LinkedFunction = z.object({ name: z.string().min(1) });
let lambda: LambdaClient | undefined;

/** The linked `CertificateWriter`, invoked synchronously (30 s; lib/clients.ts `lambda` budget). */
export function lambdaCertificateWriter(client?: Pick<LambdaClient, "send">, functionName: () => string = () => readLinked("CertificateWriter", LinkedFunction).name): CertificateWriterInvoker {
  return {
    async write(request) {
      const payload = IssueCertificateRequest.parse(request);
      const sender = client ?? (lambda ??= new LambdaClient(awsClientConfig(CLIENT_TIMEOUTS.lambda)));
      let output;
      try {
        output = await sender.send(new InvokeCommand({ FunctionName: functionName(), InvocationType: "RequestResponse", Payload: new TextEncoder().encode(JSON.stringify(payload)) }));
      } catch (error) {
        throw new ToolError("UNAVAILABLE", "the certificate writer is not available right now", error instanceof Error ? error.name : "INVOKE_FAILED", { cause: error });
      }
      if (output.FunctionError !== undefined || output.Payload === undefined) throw new ToolError("UNAVAILABLE", "the certificate writer failed", output.FunctionError ?? "NO_PAYLOAD");
      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder().decode(output.Payload));
      } catch (error) {
        throw new ToolError("UNAVAILABLE", "the certificate writer answered something else", "PAYLOAD", { cause: error });
      }
      const parsed = WriterResult.safeParse(body);
      if (!parsed.success) throw new ToolError("UNAVAILABLE", "the certificate writer answered something else", "PAYLOAD");
      return parsed.data;
    },
  };
}

/** The writer in process, with its own dependencies (local flows and tests; the stage invokes the Lambda). */
export function inProcessCertificateWriter(deps: WriterDeps): CertificateWriterInvoker {
  return { write: (request) => writeCertificateResult(deps, IssueCertificateRequest.parse(request)) };
}

export interface CertificatePortDeps extends DeliveryDeps {
  readonly writer: CertificateWriterInvoker;
  /** Opens the `OTHER` case of a certificate G3 blocked (open_case of cases/, WP-34). */
  readonly openBlockedCase: (request: IssueCertificateRequest) => Promise<void>;
}

export function createCertificatePort(deps: CertificatePortDeps): CertificatePort {
  return {
    async issue(raw) {
      const request = IssueCertificateRequest.parse(raw);
      const result = await deps.writer.write(request);
      if (!result.ok) {
        if (result.code === "POLICY_DENIED" && result.reason === "G3_BLOCKED") await deps.openBlockedCase(request);
        throw new ToolError(result.code, result.message, result.reason);
      }
      const deliveries = await deliverCertificate(deps, {
        workOrderId: request.workOrderId,
        atSim: request.closedAtSim,
        correlationId: request.correlationId,
        inResponseToInbound: request.closedBy === "CHANNEL",
        ...(request.turnId === undefined ? {} : { turnId: request.turnId }),
        attempt: "FIRST",
      });
      return IssuedCertificate.parse({ certificateId: result.certificateId, sha256: result.sha256, deliveries: queuedDeliveries(deliveries) });
    },
  };
}
