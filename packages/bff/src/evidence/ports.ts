// Ports of the evidence (docs/build-plan.md WP-30). The validation reaches four things it does not own,
// each behind an interface so the target runs over fakes in the unit tests and the local flows:
//
//   PhotoModelPort          the isolated `Converse` call (converse-client.ts over Bedrock)
//   EvidenceObjectStore     the candidate's bytes in `Media` and the evidence copy in `Evidence`
//                           (object-store.ts over S3)
//   PhotoAttemptsCasePort   `open_case(PHOTO_ATTEMPTS)` of the ladder, idempotent by order and reason
//                           (cases/, WP-34)
//   EvidenceOutboundPort    the `VERDICT_REACTION` to the photo message and the fixed notice of a photo
//                           that cannot be kept, through the outbound pipeline (outbound/, WP-28)
import type { PhotoItem, Verdict } from "@cuadrilla/shared";
import type { Logger } from "../lib/log";
import type { TokenUsage } from "../domain/common";
import type { Rubric } from "../domain/reference";
import type { ReadingProblem } from "./converse-request";
import type { RecordVerdict } from "./record-verdict";

// ---- Model ---------------------------------------------------------------------------------------

export interface PhotoModelCall {
  readonly clockId: string;
  readonly item: PhotoItem;
  readonly rubric: Rubric;
  readonly jpeg: Uint8Array;
  readonly logger: Logger;
}

/** Where a reading came from: Bedrock, or the scripted fake of the tests and local flows. */
export type ReadingSource = "MODEL" | "SCRIPTED";

export type PhotoModelResult =
  | {
      readonly kind: "READ";
      readonly source: ReadingSource;
      /** Absent when the response had no valid `record_verdict` (`problem` says why): UNSURE. */
      readonly record?: RecordVerdict;
      readonly problem?: ReadingProblem;
      readonly stopReason?: string;
      readonly usage?: TokenUsage;
      readonly latencyMs: number;
    }
  /** Bedrock could not answer within the budget (throttling, timeout, outage): no verdict at all. */
  | { readonly kind: "UNAVAILABLE"; readonly reason: string; readonly latencyMs: number };

export interface PhotoModelPort {
  /** What decides with this port: `PhotoValidation.source` of every validation, a duplicate's included. */
  readonly source: ReadingSource;
  read(call: PhotoModelCall): Promise<PhotoModelResult>;
}

// ---- Objects -------------------------------------------------------------------------------------

export type MediaRead = { readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly problem: "MISSING" | "TOO_LARGE" };

export interface EvidenceObjectStore {
  /** The candidate photo in `Media`; refuses to read past `maxBytes`. */
  readMedia(key: string, maxBytes: number): Promise<MediaRead>;
  /** The evidence copy (JPEG without metadata) in `Evidence`. */
  putEvidencePhoto(key: string, jpeg: Uint8Array): Promise<void>;
}

// ---- Cases ---------------------------------------------------------------------------------------

export interface PhotoAttemptsCaseRequest {
  readonly ispId: string;
  readonly clockId: string;
  readonly workOrderId: string;
  readonly installerId: string;
  readonly item: PhotoItem;
  /** The evidence of the rejected attempts, most recent first (at most three). */
  readonly evidenceIds: readonly string[];
  readonly validationIds: readonly string[];
  readonly atSim: string;
  readonly turnId?: string;
  readonly correlationId: string;
}

export interface PhotoAttemptsCasePort {
  /** `open_case(PHOTO_ATTEMPTS)`: the open case of the order and reason, or a new one on the ladder. */
  openPhotoAttemptsCase(request: PhotoAttemptsCaseRequest): Promise<{ readonly caseId: string; readonly reason: "PHOTO_ATTEMPTS" }>;
}

// ---- Outbound ------------------------------------------------------------------------------------

/** ✅ for PASS, 🔁 for REJECT and UNSURE (docs/design-brief.md §5.10, FL-103). */
export type VerdictEmoji = "✅" | "🔁";

interface InstallerMessageRef {
  readonly ispId: string;
  readonly clockId: string;
  readonly installerId: string;
  readonly workOrderId: string;
  /** The photo's inbound message. */
  readonly messageId: string;
  readonly turnId?: string;
  readonly atSim: string;
  readonly correlationId: string;
}

export interface VerdictReactionRequest extends InstallerMessageRef {
  readonly emoji: VerdictEmoji;
  readonly verdict: Verdict;
  readonly validationId: string;
}

export interface PhotoNoticeRequest extends InstallerMessageRef {
  /** Fixed text of copy/es-MX.ts. */
  readonly notice: "imageUnreadable" | "imageTooLarge";
}

export interface EvidenceOutboundPort {
  /** `VERDICT_REACTION` (a system message) to the photo, by the outbound pipeline. */
  reactToPhoto(request: VerdictReactionRequest): Promise<void>;
  /** `SYSTEM_NOTICE` with the fixed text, when the photo cannot be kept as evidence. */
  photoNotice(request: PhotoNoticeRequest): Promise<void>;
}
