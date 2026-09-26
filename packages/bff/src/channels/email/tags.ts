// `EmailTags` of every `SendEmail` (docs/architecture-integrations.md §1): `ispId`, `workOrderId`,
// `mailId`, `kind` and `stage`, whose values come back in each SES event so `ChannelEvents` can route
// it to the queue of the order's installer. SES accepts only `[A-Za-z0-9_-]` and 256 characters in a
// tag name or value; one function normalizes every value (anything else becomes `-`), so an id of any
// world (`GLOBAL#isp-demo`, `JUDGE#isp-judge-07`, `qa-812-1-sc-02`) never fails a send. The app's
// own ids are already in that alphabet, so they come back unchanged and parse with their zod schema.
import type { MessageTag } from "@aws-sdk/client-sesv2";

export const EMAIL_TAG_NAMES = ["ispId", "workOrderId", "mailId", "kind", "stage"] as const;
export type EmailTagName = (typeof EMAIL_TAG_NAMES)[number];

export const MAX_TAG_LENGTH = 256;

/** A tag value SES accepts: every character outside `[A-Za-z0-9_-]` turned into `-`, at most 256. */
export function normalizeTagValue(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, MAX_TAG_LENGTH);
  return normalized.length > 0 ? normalized : "-";
}

export type EmailTagValues = Readonly<Partial<Record<EmailTagName, string>>>;

/** The tags of one email, in a fixed order; an absent value (an email without an order) has no tag. */
export function emailTags(values: EmailTagValues): MessageTag[] {
  return EMAIL_TAG_NAMES.flatMap((name) => {
    const value = values[name];
    return value === undefined ? [] : [{ Name: name, Value: normalizeTagValue(value) }];
  });
}
