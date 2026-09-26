// One section of the manual as the generator writes it (docs/seed-spec.md §8): its citable id, its
// title and its body in Markdown. The file adds the heading and the version line (render.ts).
import type { ManualSectionId } from "@cuadrilla/shared";

export interface ManualSection {
  readonly id: ManualSectionId;
  readonly title: string;
  readonly body: string;
}
