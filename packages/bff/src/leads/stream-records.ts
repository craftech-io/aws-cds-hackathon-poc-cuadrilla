// The records `LeadStream` receives (ADR-0026, infra/leads-spec.ts `LEAD_STREAM_FILTERS`): DynamoDB
// stream records of the `Leads` table with both images, or the daily `{kind: "UNCONFIRMED_SWEEP"}` of
// its schedule. Everything is parsed with zod before it is used: the images become `Lead` items
// (a record whose image is not a lead is refused, never guessed), and only the two shapes the
// filters let through are actionable.
import type { AttributeValue as StreamAttributeValue, DynamoDBRecord } from "aws-lambda";
import { z } from "zod";
import { LEAD_META, LEAD_PARTITION_PREFIX, Lead } from "./model";

export const SweepEvent = z.object({ kind: z.literal("UNCONFIRMED_SWEEP") }).strict();
export type SweepEvent = z.infer<typeof SweepEvent>;

/** The subset of a DynamoDB record `LeadStream` reads. */
const StreamRecord = z.object({
  eventName: z.enum(["INSERT", "MODIFY", "REMOVE"]),
  userIdentity: z.object({ type: z.string(), principalId: z.string() }).optional(),
  dynamodb: z.object({
    Keys: z.record(z.string(), z.unknown()).optional(),
    NewImage: z.record(z.string(), z.unknown()).optional(),
    OldImage: z.record(z.string(), z.unknown()).optional(),
  }),
});

export const StreamEvent = z.object({ Records: z.array(z.unknown()) });

/** A plain value of one stream attribute (S, N, BOOL, NULL, M, L, SS, NS); binary never appears in `Leads`. */
export function fromAttribute(value: StreamAttributeValue): unknown {
  if (value.S !== undefined) return value.S;
  if (value.N !== undefined) return Number(value.N);
  if (value.BOOL !== undefined) return value.BOOL;
  if (value.NULL !== undefined) return null;
  if (value.M !== undefined) return fromImage(value.M);
  if (value.L !== undefined) return value.L.map(fromAttribute);
  if (value.SS !== undefined) return [...value.SS];
  if (value.NS !== undefined) return value.NS.map(Number);
  throw new RangeError("unsupported attribute type in a Leads stream image");
}

export function fromImage(image: Readonly<Record<string, StreamAttributeValue>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(image).map(([key, value]) => [key, fromAttribute(value)]));
}

export type LeadChange =
  | { readonly kind: "CONFIRMED"; readonly lead: Lead }
  | { readonly kind: "EXPIRED"; readonly lead: Lead }
  | { readonly kind: "IGNORED"; readonly why: "NOT_A_LEAD" | "NOT_A_CONFIRMATION" | "NOT_A_TTL_REMOVE" | "INSERT" };

function leadOf(image: Record<string, unknown> | undefined): Lead {
  if (image === undefined) throw new RangeError("a lead record without its image");
  return Lead.parse(fromImage(image as Record<string, StreamAttributeValue>));
}

/** What one record means for the lead lifecycle. A malformed lead image throws (the batch is retried, then dead-lettered). */
export function classifyRecord(raw: DynamoDBRecord | unknown): LeadChange {
  const record = StreamRecord.parse(raw);
  const keys = record.dynamodb.Keys === undefined ? undefined : fromImage(record.dynamodb.Keys as Record<string, StreamAttributeValue>);
  if (typeof keys?.PK !== "string" || !keys.PK.startsWith(LEAD_PARTITION_PREFIX) || keys.SK !== LEAD_META) return { kind: "IGNORED", why: "NOT_A_LEAD" };
  if (record.eventName === "INSERT") return { kind: "IGNORED", why: "INSERT" };
  if (record.eventName === "MODIFY") {
    const before = leadOf(record.dynamodb.OldImage);
    const after = leadOf(record.dynamodb.NewImage);
    return before.status === undefined && after.status === "CONFIRMED" ? { kind: "CONFIRMED", lead: after } : { kind: "IGNORED", why: "NOT_A_CONFIRMATION" };
  }
  const byTtl = record.userIdentity?.type === "Service" && record.userIdentity.principalId === "dynamodb.amazonaws.com";
  return byTtl ? { kind: "EXPIRED", lead: leadOf(record.dynamodb.OldImage) } : { kind: "IGNORED", why: "NOT_A_TTL_REMOVE" };
}
