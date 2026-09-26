// Header values of an outbound email (docs/architecture-integrations.md §1, "Encabezados"). Every
// value built from a record is checked before it reaches SES: no CR, LF or any other control
// character (header injection), printable ASCII only in raw headers; a visible sender name with
// non-ASCII characters ("Cuadrilla · Actas") is encoded as RFC 2047 encoded-words, which the
// `FromEmailAddress` of SES requires.
import { ChannelError } from "@cuadrilla/shared";

/** Header that ties an email to its outbox row and its pending mark. */
export const MAIL_ID_HEADER = "X-Cuadrilla-Mail-Id";

// RFC 2047 §2: an encoded-word is at most 75 characters; `=?UTF-8?B?` + `?=` take 12 of them.
const MAX_ENCODED_WORD = 75;
const ENCODED_WORD_OVERHEAD = "=?UTF-8?B??=".length;
// Base64 turns every 3 bytes into 4 characters.
const MAX_BYTES_PER_WORD = Math.floor((MAX_ENCODED_WORD - ENCODED_WORD_OVERHEAD) / 4) * 3;

function invalid(message: string): ChannelError {
  return new ChannelError("INVALID", "EMAIL", message, { retryable: false });
}

/** A header value built from data: one line, no control characters. */
export function assertHeaderText(value: string, what: string): string {
  if (value.length === 0) throw invalid(`${what} is empty`);
  if (/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/.test(value)) throw invalid(`${what} has a line break or a control character`);
  return value;
}

/** A raw header value (`X-Cuadrilla-Mail-Id`): printable ASCII, one line, ≤ 995 characters (SES). */
export function assertAsciiHeader(value: string, what: string): string {
  assertHeaderText(value, what);
  if (!/^[\x20-\x7E]{1,995}$/.test(value)) throw invalid(`${what} is not printable ASCII`);
  return value;
}

/**
 * `text` as one or more RFC 2047 `B` encoded-words, split on character boundaries so no word cuts a
 * UTF-8 sequence in half; a name of plain letters, digits, spaces, `_` and `-` goes as it is.
 */
export function encodeWords(text: string): string {
  assertHeaderText(text, "display name");
  if (/^[A-Za-z0-9 _-]+$/.test(text)) return text;
  const words: string[] = [];
  let chunk = "";
  for (const character of text) {
    if (Buffer.byteLength(chunk + character, "utf8") > MAX_BYTES_PER_WORD) {
      words.push(chunk);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk.length > 0) words.push(chunk);
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word, "utf8").toString("base64")}?=`).join(" ");
}

/** `From` with a visible name: `=?UTF-8?B?…?= <actas@…>`; the address is already fenced ASCII. */
export function formatMailbox(displayName: string, address: string): string {
  assertAsciiHeader(address, "sender address");
  return `${encodeWords(displayName)} <${address}>`;
}
