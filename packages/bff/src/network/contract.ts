// The schemas this client validates the orchestrator with, gathered for `npm run network:contract`,
// which compares them with `packages/network-contract/openapi.yaml`. Reading anything else fails it.
import { NETWORK_OPERATIONS, OnuSerialParam, OnuStatus, WorldHeader } from "@cuadrilla/network-contract";

export const CLIENT_CONTRACT = {
  label: "bff network client",
  onuStatus: OnuStatus,
  serial: OnuSerialParam,
  world: WorldHeader,
  operations: NETWORK_OPERATIONS,
} as const;
