// The gallery's thumbnails (docs/landing-spec.md §6): a render is scaled whole into its 4:3 frame, never
// cut at the right edge nor through a row; only a very tall one keeps the width and fades at the bottom.
import { describe, expect, it } from "vitest";
import { MIN_FIT_SHARE, THUMBNAIL_RATIO, thumbnailLayout } from "./FitToWidth";

describe("gallery thumbnails [FL-089]", () => {
  it("[FL-089] scales a short view whole into the frame, centred, with nothing past its edges", () => {
    const layout = thumbnailLayout(203, 600, 300);
    expect(layout.scale).toBeCloseTo(203 / 600);
    expect(600 * layout.scale).toBeLessThanOrEqual(203 + 0.001);
    expect(300 * layout.scale).toBeLessThanOrEqual(203 * THUMBNAIL_RATIO);
    expect(layout).toMatchObject({ left: 0, faded: false });
  });

  it("[FL-089] a view taller than the frame shrinks to fit it and is centred sideways", () => {
    const layout = thumbnailLayout(203, 600, 560);
    expect(560 * layout.scale).toBeCloseTo(203 * THUMBNAIL_RATIO);
    expect(layout.left).toBeCloseTo((203 - 600 * layout.scale) / 2);
    expect(layout.faded).toBe(false);
  });

  it("[FL-089] content drawn wider than its design width is fitted by what it really draws, never cut at the right", () => {
    const layout = thumbnailLayout(203, 960, 200);
    expect(960 * layout.scale).toBeLessThanOrEqual(203 + 0.001);
  });

  it("[FL-089] only a view so tall that fitting it would be unreadable keeps the width and fades at the bottom", () => {
    const layout = thumbnailLayout(203, 600, 2_000);
    expect(layout.scale).toBeCloseTo(203 / 600);
    expect(layout.faded).toBe(true);
    expect(MIN_FIT_SHARE).toBe(0.6);
  });
});
