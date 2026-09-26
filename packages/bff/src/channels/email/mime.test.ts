import { describe, expect, it } from "vitest";
import { ChannelError } from "@cuadrilla/shared";
import { EMAIL_SENDER_NAMES } from "../../copy/es-MX-documents";
import { assertAsciiHeader, assertHeaderText, encodeWords, formatMailbox } from "./mime";

/** Decodes `=?UTF-8?B?…?=` words back to text (what a mail client shows). */
function decodeWords(header: string): string {
  return header.replace(/=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=\s?/g, (_, base64: string) => Buffer.from(base64, "base64").toString("utf8"));
}

describe("encodeWords", () => {
  it("encodes the generic visible senders as RFC 2047 words that decode back exactly", () => {
    for (const name of Object.values(EMAIL_SENDER_NAMES)) {
      const encoded = encodeWords(name);
      expect(encoded).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
      expect(decodeWords(encoded)).toBe(name);
    }
    expect(encodeWords("Cuadrilla")).toBe("Cuadrilla");
  });

  it("splits a long name into words of at most 75 characters without cutting a character", () => {
    const name = "Operación de instalaciones ñandú · ".repeat(4).trim();
    const encoded = encodeWords(name);
    const words = encoded.split(" ");
    expect(words.length).toBeGreaterThan(1);
    for (const word of words) expect(word.length).toBeLessThanOrEqual(75);
    expect(decodeWords(encoded)).toBe(name);
  });
});

describe("header values", () => {
  it("formats the sender with its encoded name and its address", () => {
    expect(formatMailbox(EMAIL_SENDER_NAMES.certificates, "actas@cuadrilla.demo.craftech.io")).toBe(`${encodeWords(EMAIL_SENDER_NAMES.certificates)} <actas@cuadrilla.demo.craftech.io>`);
  });

  it("refuses line breaks and control characters (header injection) and non-ASCII raw headers", () => {
    expect(() => assertHeaderText("Acta\r\nBcc: otro@simulator.amazonses.com", "subject")).toThrow(ChannelError);
    expect(() => assertHeaderText(`Acta${String.fromCodePoint(0x2028)}x`, "subject")).toThrow(ChannelError);
    expect(() => assertHeaderText("", "subject")).toThrow(/empty/);
    expect(() => encodeWords("Cuadrilla\n· Actas")).toThrow(ChannelError);
    expect(() => assertAsciiHeader("mail-ñ", "mail id")).toThrow(/printable ASCII/);
    expect(assertAsciiHeader("mail-01K5B7", "mail id")).toBe("mail-01K5B7");
    expect(() => formatMailbox("Cuadrilla", "actas@cuadrilla.demo.craftech.io\r\n")).toThrow(ChannelError);
  });
});
