// How the operator's lead scripts receive a person's address (ADR-0026): from standard input or from
// `--email-file <path>`, NEVER as a command-line argument, so it stays out of the shell history and of
// the process list. Any argument that looks like an address is refused before anything runs.
import { readFile } from "node:fs/promises";
import { parseFlags } from "../channels/cli-args";

export const EMAIL_INPUT_USAGE = "the address is read from standard input (echo … | npm run …) or from --email-file <path>, never from an argument";

export interface EmailInputOptions {
  /** Extra flags of the script (`--email-file` is always known). */
  readonly flags?: Readonly<Record<string, (value: () => string) => void>>;
}

export interface EmailSource {
  readonly readStdin: () => Promise<string>;
  readonly readFile: (path: string) => Promise<string>;
}

export const processEmailSource: EmailSource = {
  readStdin: async () => {
    if (process.stdin.isTTY) throw new RangeError(EMAIL_INPUT_USAGE);
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    return Buffer.concat(chunks).toString("utf8");
  },
  readFile: (path) => readFile(path, "utf8"),
};

/** Parses the flags and returns the one address given out of band. */
export async function readEmailInput(argv: readonly string[], source: EmailSource, options: EmailInputOptions = {}): Promise<string> {
  if (argv.some((arg) => arg.includes("@"))) throw new RangeError(EMAIL_INPUT_USAGE);
  let emailFile: string | undefined;
  parseFlags(argv, {
    ...options.flags,
    "--email-file": (value) => {
      emailFile = value();
    },
  });
  const raw = emailFile === undefined ? await source.readStdin() : await source.readFile(emailFile);
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length !== 1) throw new RangeError(`expected exactly one address; ${EMAIL_INPUT_USAGE}`);
  const [email = ""] = lines;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) throw new RangeError("that is not an email address");
  return email;
}
