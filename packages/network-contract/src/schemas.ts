// zod mirror of `openapi.yaml` (docs/architecture-integrations.md §6). The client of the BFF and the
// mock validate with these schemas and nothing else, and `npm run network:contract` compares them
// with the YAML, so the wire format has one definition checked from both sides.
import { z } from "zod";

/** `serial` path parameter. Wider than the synthetic `DEMO…` serials of the seed: any orchestrator's. */
export const ONU_SERIAL_PATTERN = /^[A-Z0-9]{8,16}$/;
export const OnuSerialParam = z.string().regex(ONU_SERIAL_PATTERN);
export type OnuSerialParam = z.infer<typeof OnuSerialParam>;

/** `X-World` header: the world the call reads (a clock id; the mock checks its form). */
export const WorldHeader = z.string();

export const AdminState = z.enum(["ENABLED", "DISABLED"]);
export type AdminState = z.infer<typeof AdminState>;

export const OperState = z.enum(["ONLINE", "OFFLINE", "LOS", "DYING_GASP", "NOT_PROVISIONED"]);
export type OperState = z.infer<typeof OperState>;

const DateTime = z.iso.datetime({ offset: true });

export const OnuStatus = z.object({
  serial: z.string(),
  adminState: AdminState.optional(),
  operState: OperState,
  /** Optical power received at the ONU, 1490 nm. Absent when there is no light (LOS). */
  rxPowerDbm: z.number().optional(),
  txPowerDbm: z.number().optional(),
  oltPort: z.string().optional(),
  profile: z.string().optional(),
  lastSeenAt: DateTime.optional(),
  observedAt: DateTime,
});
export type OnuStatus = z.infer<typeof OnuStatus>;

export const WORLD_HEADER = "X-World";
export const RETRY_AFTER_HEADER = "Retry-After";

export type HttpMethod = "GET" | "POST";

export interface NetworkOperation {
  readonly operationId: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly pathParams: readonly string[];
  readonly requiredHeaders: readonly string[];
  readonly responses: readonly number[];
}

/** Operations of the contract, as the client calls them and the mock serves them. */
export const NETWORK_OPERATIONS = {
  getOnu: {
    operationId: "getOnu",
    method: "GET",
    path: "/v1/onus/{serial}",
    pathParams: ["serial"],
    requiredHeaders: [WORLD_HEADER],
    responses: [200, 404, 503],
  },
  health: {
    operationId: "health",
    method: "GET",
    path: "/v1/health",
    pathParams: [],
    requiredHeaders: [],
    responses: [200],
  },
} as const satisfies Readonly<Record<string, NetworkOperation>>;

/** `/v1/onus/{serial}` for one serial; the serial is checked against the contract before it is sent. */
export function onuPath(serial: string, suffix = ""): string {
  return `${NETWORK_OPERATIONS.getOnu.path.replace("{serial}", OnuSerialParam.parse(serial))}${suffix}`;
}
