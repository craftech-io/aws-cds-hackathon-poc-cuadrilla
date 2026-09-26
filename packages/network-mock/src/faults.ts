// Faults of a world (docs/architecture-integrations.md §6): `ERROR_503`, `TIMEOUT` and `LATENCY`, only
// for `qa-*` clocks, never for `GLOBAL#*` or `GUEST#*`. The `QaDriver` writes them in
// `Runtime/FAULTS#<clockId>`; the client reads that item for `qa-*` clocks and asks for the fault with
// `X-Fault`, the way a proxy's fault-injection header works, so this Lambda needs no table besides
// `Network`. The header of any other world is ignored. Faults apply to the contract's read only:
// world events (the control routes) always land, so a world's state stays deterministic.
import { NetworkFault } from "@cuadrilla/network-contract";
import { ispKindOfClock } from "@cuadrilla/shared";

/** Seconds a faulted read asks the client to wait (`Retry-After`). */
export const FAULT_RETRY_AFTER_SECONDS = 1;
/** Longer than the client's 3 s timeout: every attempt of the client expires. */
export const FAULT_TIMEOUT_MS = 4_000;
/** Below the client's timeout: the read succeeds, slowly. */
export const FAULT_LATENCY_MS = 1_500;

export type FaultRequest = { readonly kind: "none" } | { readonly kind: "fault"; readonly fault: NetworkFault } | { readonly kind: "invalid" };

/** The fault `X-Fault` asks for, if the world may have one. */
export function requestedFault(clockId: string, header: string | undefined): FaultRequest {
  if (header === undefined || ispKindOfClock(clockId) !== "QA") return { kind: "none" };
  const parsed = NetworkFault.safeParse(header);
  return parsed.success ? { kind: "fault", fault: parsed.data } : { kind: "invalid" };
}
