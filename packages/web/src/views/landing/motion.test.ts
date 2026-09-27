// The scroll floor of the walkthrough (docs/landing-spec.md §4): a scene is complete by the time the
// visitor has scrolled through it, however long they stay, and its phones fill up in the story's order.
import { describe, expect, it } from "vitest";
import { DESKTOP_REVEAL_SPAN, desktopReveal, revealFloors, revealFraction, typingDelay } from "./motion";

describe("the walkthrough's scroll floor [FL-089]", () => {
  it("[FL-089] pinned: complete once the visitor is 30 % into the scene's block, never before it starts", () => {
    expect(DESKTOP_REVEAL_SPAN).toBe(0.3);
    expect(desktopReveal(0)).toBe(0);
    expect(desktopReveal(0.15)).toBeCloseTo(0.5);
    for (const progress of [0.3, 0.44, 0.9, 1, 3]) expect(desktopReveal(progress)).toBe(1);
    expect(desktopReveal(-1)).toBe(0);
  });

  it("[FL-089] stacked: a phone fills up as it rises into the viewport and is complete before it is fully in sight", () => {
    const viewport = 844;
    const height = 591;
    expect(revealFraction(viewport + 10, height, viewport)).toBe(0);
    expect(revealFraction(viewport, height, viewport)).toBe(0);
    expect(revealFraction(viewport - height * 0.175, height, viewport)).toBeCloseTo(0.5);
    // A third of it in sight, scrolled into place, or past it at any speed: whole.
    for (const top of [viewport - height * 0.35, 100, 0, -2_000]) expect(revealFraction(top, height, viewport)).toBe(1);
    expect(revealFraction(500, 0, viewport)).toBe(1);
  });

  it("[FL-089] splits a scene's share over its phones in order: the second phone only after the first is complete", () => {
    expect(revealFloors([3, 1], 0)).toEqual([0, 0]);
    expect(revealFloors([3, 1], 0.01)).toEqual([1, 0]);
    expect(revealFloors([3, 1], 0.75)).toEqual([3, 0]);
    expect(revealFloors([3, 1], 0.76)).toEqual([3, 1]);
    expect(revealFloors([1, 4], 1)).toEqual([1, 4]);
    expect(revealFloors([1, 4], 7)).toEqual([1, 4]);
    expect(revealFloors([4], -1)).toEqual([0]);
  });

  it("keeps M2's pace: at most 35 ms a character and 4 s a message", () => {
    expect(typingDelay(0)).toBe(0);
    expect(typingDelay(40)).toBe(35);
    expect(typingDelay(400) * 400).toBe(4000);
  });
});
