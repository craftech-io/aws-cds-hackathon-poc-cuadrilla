import { describe, expect, it } from "vitest";
import { MemoryTableClient } from "../connector/memory/table-client";
import { EMAIL_HASH_KEY, SIGNUP_T0, TICKET_KEY } from "./testing";
import { leadEmailHash } from "../leads/keys";
import { SIGNUP_TICKET_TTL_MS, issueTicket, readTicket, spendTicketUse, ticketUseKey } from "./ticket";

const TICKET = {
  nonce: "01K80000000000000000000042",
  emailHash: leadEmailHash(EMAIL_HASH_KEY, "ana.prueba@example.com"),
  username: "gst-01K80000000000000000000001",
  exp: Math.floor((SIGNUP_T0.getTime() + SIGNUP_TICKET_TTL_MS) / 1000),
};

describe("the sign-up ticket [FL-114]", () => {
  it("[FL-114] binds the nonce, the email's hash, the user and the expiry under the signup-ticket subkey", () => {
    const raw = issueTicket(TICKET_KEY, TICKET);
    expect(readTicket(TICKET_KEY, raw, SIGNUP_T0)).toEqual({ ok: true, ticket: TICKET });
    // No address in it: only the hash.
    expect(Buffer.from(raw.split(".")[0] ?? "", "base64url").toString()).not.toContain("@");
  });

  it("[FL-114] refuses another key, a changed part, an expired ticket and anything that is not one", () => {
    const raw = issueTicket(TICKET_KEY, TICKET);
    expect(readTicket(EMAIL_HASH_KEY, raw, SIGNUP_T0)).toEqual({ ok: false, reason: "SIGNATURE" });
    const [payload, signature] = raw.split(".");
    const swapped = Buffer.from(Buffer.from(payload ?? "", "base64url").toString().replace(TICKET.username, "gst-01K80000000000000000000002")).toString("base64url");
    expect(readTicket(TICKET_KEY, `${swapped}.${signature}`, SIGNUP_T0)).toEqual({ ok: false, reason: "SIGNATURE" });
    expect(readTicket(TICKET_KEY, raw, new Date(TICKET.exp * 1000))).toEqual({ ok: false, reason: "EXPIRED" });
    for (const junk of [undefined, 42, "", "no-dot", "a.b.c", "x".repeat(2_000)]) expect(readTicket(TICKET_KEY, junk, SIGNUP_T0).ok).toBe(false);
    expect(() => issueTicket(TICKET_KEY, { ...TICKET, username: "admin" })).toThrow();
  });

  it("[FL-114] a ticket has two uses, always for its user; the third is refused", async () => {
    const client = new MemoryTableClient();
    expect(await spendTicketUse(client, TICKET, SIGNUP_T0)).toBe(true);
    expect(await spendTicketUse(client, TICKET, SIGNUP_T0)).toBe(true);
    expect(await spendTicketUse(client, TICKET, SIGNUP_T0)).toBe(false);
    expect(await client.get("Runtime", ticketUseKey(TICKET.nonce))).toMatchObject({ uses: 2, username: TICKET.username, entity: "SignupTicket" });
  });
});
