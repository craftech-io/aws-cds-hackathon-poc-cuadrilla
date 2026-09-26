// The manual v001 (docs/seed-spec.md §8): its 32 sections in the order of the spec, each rendered as a
// Markdown file with its heading and version line, and its sidecar of Knowledge Base metadata.
import { MANUAL_VERSION, manualFile, manualSidecarFile } from "../../lib/paths";
import { renderSectionFile, sidecarOf } from "../../lib/manual";
import { stableJson } from "../../photos/prng";
import { COMMERCIAL_SECTIONS } from "./commercial";
import { DIAGNOSIS_EVIDENCE_SECTIONS } from "./diagnosis-evidence";
import { GENERAL_SAFETY_SECTIONS } from "./general-safety";
import { INSTALLATION_SECTIONS } from "./installation";
import type { ManualSection } from "./types";

export const MANUAL_SECTIONS: readonly ManualSection[] = [...GENERAL_SAFETY_SECTIONS, ...INSTALLATION_SECTIONS, ...DIAGNOSIS_EVIDENCE_SECTIONS, ...COMMERCIAL_SECTIONS];

/** Files of the manual inside the data directory: `manual/v001/<id>.md` and its sidecar. */
export function manualFiles(): Map<string, string> {
  const files = new Map<string, string>();
  for (const section of MANUAL_SECTIONS) {
    files.set(manualFile(section.id), renderSectionFile(section.id, section.title, section.body));
    files.set(manualSidecarFile(section.id), stableJson(sidecarOf(section.id, section.title, MANUAL_VERSION)));
  }
  return files;
}
