// The schemas this mock validates the contract with, gathered for `npm run network:contract`, which
// compares them with `packages/network-contract/openapi.yaml`. Serving anything else fails the check.
import { NETWORK_OPERATIONS, OnuSerialParam, OnuStatus, WorldHeader } from "@cuadrilla/network-contract";

export const MOCK_CONTRACT = {
  label: "network-mock",
  onuStatus: OnuStatus,
  serial: OnuSerialParam,
  world: WorldHeader,
  operations: NETWORK_OPERATIONS,
} as const;
