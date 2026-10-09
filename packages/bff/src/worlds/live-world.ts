// The single live world (ADR-0002, docs/seed-spec.md §3): every template runs `whatsappMode: simulated`
// and only the world of `SeedOverrides.liveWorldClockId` runs `live`, marked by the singleton
// `Runtime/LIVEWORLD`. Only the operator's demo world may be live: a guest, QA or evaluation world never
// is (their people are synthetic phones of a block, and the simulator is what they use). Changing the
// overrides moves the mark: the previous live world goes back to `simulated` before the new one goes live.
import { ToolError, parseClockId } from "@cuadrilla/shared";
import type { Connector } from "../connector/ports";
import type { Actor } from "../domain/common";
import type { WhatsAppMode } from "@cuadrilla/shared";

/** The mode a world's settings carry: `live` only for the configured live world, and only a demo world. */
export function whatsappModeOf(clockId: string, liveWorldClockId: string | undefined): WhatsAppMode {
  if (liveWorldClockId === undefined || clockId !== liveWorldClockId) return "simulated";
  return parseClockId(clockId)?.kind === "DEMO" ? "live" : "simulated";
}

/** Throws for a live world that is not an operator's demo world. */
export function assertLiveWorldAllowed(liveWorldClockId: string | undefined): void {
  if (liveWorldClockId === undefined) return;
  if (parseClockId(liveWorldClockId)?.kind !== "DEMO") throw new ToolError("INVALID", "only the operator's demo world may be live", "LIVE_WORLD_NOT_DEMO");
}

export interface LiveWorldSync {
  readonly live?: string;
  readonly cleared?: string;
}

async function setMode(connector: Pick<Connector, "isps">, clockId: string, mode: WhatsAppMode): Promise<void> {
  const ispId = parseClockId(clockId)?.ispId;
  if (ispId === undefined) return;
  const settings = await connector.isps.getSettings(ispId);
  if (settings !== undefined && settings.whatsappMode !== mode) await connector.isps.updateSettings(ispId, { whatsappMode: mode });
}

/**
 * Makes `Runtime/LIVEWORLD` and the worlds' settings agree with the overrides: the previous live world
 * goes back to `simulated` and loses the mark, the configured one (when it exists) goes `live` and takes it.
 */
export async function syncLiveWorld(connector: Pick<Connector, "isps" | "worlds">, liveWorldClockId: string | undefined, actor: Actor): Promise<LiveWorldSync> {
  assertLiveWorldAllowed(liveWorldClockId);
  const current = await connector.worlds.getLiveWorld();
  let cleared: string | undefined;
  if (current !== undefined && current.clockId !== liveWorldClockId) {
    await setMode(connector, current.clockId, "simulated");
    await connector.worlds.clearLiveWorld(current.clockId);
    cleared = current.clockId;
  }
  if (liveWorldClockId === undefined) return cleared === undefined ? {} : { cleared };
  await setMode(connector, liveWorldClockId, "live");
  await connector.worlds.setLiveWorld(liveWorldClockId, actor);
  return { live: liveWorldClockId, ...(cleared === undefined ? {} : { cleared }) };
}
