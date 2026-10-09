// Flags of `seed:load` (docs/seed-spec.md §15): the only stage (`poc`, also when absent), a forced
// reload, and the two logos of the design partner, which are local paths outside the repository (never
// committed, docs/pending.md §5).
import { resolve } from "node:path";
import { parseFlags } from "../../channels/cli-args";
import { REPO_ROOT } from "../lib/paths";

export const STAGE = "poc";

export interface LoadArgs {
  readonly stage: string;
  /** Load even when the fingerprint did not change (the demo world is reset: its epoch goes up). */
  readonly force: boolean;
  readonly logoOnLight?: string;
  readonly logoOnDark?: string;
}

/** A logo inside the repository would end in git: refused. */
function outsideRepo(flag: string, path: string): string {
  const absolute = resolve(path);
  if (absolute === REPO_ROOT || absolute.startsWith(`${REPO_ROOT}/`)) throw new RangeError(`${flag} takes a local path outside the repository`);
  return absolute;
}

export function parseLoadArgs(argv: readonly string[]): LoadArgs {
  const args: { stage?: string; force?: boolean; logoOnLight?: string; logoOnDark?: string } = {};
  parseFlags(argv, {
    "--stage": (value) => void (args.stage = value()),
    "--force": () => void (args.force = true),
    "--brand-logo-on-light": (value) => void (args.logoOnLight = outsideRepo("--brand-logo-on-light", value())),
    "--brand-logo-on-dark": (value) => void (args.logoOnDark = outsideRepo("--brand-logo-on-dark", value())),
  });
  // CI runs `npm run seed:load` (the package script already runs inside `sst shell --stage poc`).
  if (args.stage !== undefined && args.stage !== STAGE) throw new RangeError(`--stage takes ${STAGE} (the only stage)`);
  return {
    stage: STAGE,
    force: args.force === true,
    ...(args.logoOnLight === undefined ? {} : { logoOnLight: args.logoOnLight }),
    ...(args.logoOnDark === undefined ? {} : { logoOnDark: args.logoOnDark }),
  };
}
