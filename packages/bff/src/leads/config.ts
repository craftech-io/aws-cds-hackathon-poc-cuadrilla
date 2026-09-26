// What `LeadStream` reads from the stage to send the notice (ADR-0026): the `LeadNotifyChannel`
// Linkable of infra/leads.ts (identity domain, configuration set, sender; `SEND_LEAD_NOTIFY` rides on
// it) and the `LeadConfig` secret (the Craftech mailboxes, never in the code), both through the SST
// link and zod. The secret is checked again against the notice fence at load: a value set by hand
// outside `@craftech.io` fails here, before any send. Its values are never logged.
import { ToolError } from "@cuadrilla/shared";
import { z } from "zod";
import { readLinked } from "../lib/resource";
import { LeadConfigValue } from "../lib/secret-schemas";
import { secretValue } from "../lib/secrets";

const Domain = z.string().regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/);

export const LeadNotifyChannelResource = z.object({
  identityDomain: Domain,
  configurationSetName: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  /** `leads@<identity domain>`: the only sender `SEND_LEAD_NOTIFY` allows. */
  sender: z.string().regex(/^leads@[a-z0-9.-]+$/),
});
export type LeadNotifyChannel = z.infer<typeof LeadNotifyChannelResource>;

export function leadNotifyChannel(): LeadNotifyChannel {
  const channel = readLinked("LeadNotifyChannel", LeadNotifyChannelResource);
  if (channel.sender !== `leads@${channel.identityDomain}`) throw new ToolError("UNAVAILABLE", "the lead notice sender is not leads@ of the identity domain");
  return channel;
}

/** `LeadConfig` parsed and fenced; `UNAVAILABLE` when it is missing or outside its shape (values never echoed). */
export function leadConfig(read: (name: "LeadConfig") => string = secretValue): LeadConfigValue {
  let raw: unknown;
  try {
    raw = JSON.parse(read("LeadConfig"));
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError("UNAVAILABLE", 'secret "LeadConfig" is not valid JSON');
  }
  const parsed = LeadConfigValue.safeParse(raw);
  if (!parsed.success) {
    const paths = parsed.error.issues.map((issue) => issue.path.join(".") || "(root)").join(", ");
    throw new ToolError("UNAVAILABLE", `secret "LeadConfig" does not match its schema at ${paths}`);
  }
  return parsed.data;
}
