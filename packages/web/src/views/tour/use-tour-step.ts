// Runs one step of the tour the way a person would: each part of its button (`tour.run` with `part`), in
// order, waiting between them for the world to be quiet again (the shell's clock poll says when), so a photo
// is never sent while the previous one is still being validated. A part that opens a view navigates there.
// If the world stays busy longer than the step expects, it stops and the button continues from the next
// part. "Saltar a escena" is `clock.jumpToScene`, a separate action with its own limit.
import { useCallback, useEffect, useRef, useState } from "react";
import { usePrincipal, useSession } from "../../context/SessionContext";
import { useWorldClock } from "../../context/WorldClockContext";
import { type ApiError, apiErrorOf } from "../../lib/api-error";
import { useRouter } from "../../lib/router";
import type { TourStep, TourTrackId } from "./steps";
import { viewOfResult, viewPath, waitLimitMs } from "./tour-model";

export type StepRun =
  | { readonly status: "idle" }
  | { readonly status: "running"; readonly part: number; readonly total: number; readonly waiting: boolean }
  | { readonly status: "paused"; readonly nextPart: number; readonly total: number }
  | { readonly status: "done"; readonly jumped?: boolean }
  | { readonly status: "error"; readonly error: ApiError; readonly nextPart: number; readonly total: number };

const POLL_MS = 500;

export function useTourStep(track: TourTrackId, step: TourStep, total: number) {
  const { trpc } = useSession();
  const { role } = usePrincipal();
  const { navigate } = useRouter();
  const { clock, refresh } = useWorldClock();
  const busyRef = useRef(clock?.busy === true);
  const mounted = useRef(true);
  const [run, setRun] = useState<StepRun>({ status: "idle" });

  useEffect(() => {
    busyRef.current = clock?.busy === true;
  }, [clock]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const quiet = useCallback(async (limitMs: number): Promise<boolean> => {
    const until = Date.now() + limitMs;
    // The poll of the shell has to see the part's effect before "quiet" means anything.
    refresh();
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 2));
    while (busyRef.current && Date.now() < until && mounted.current) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    return !busyRef.current;
  }, [refresh]);

  const start = useCallback(
    async (from: number) => {
      for (let part = from; part < total; part += 1) {
        if (!mounted.current) return;
        setRun({ status: "running", part: part + 1, total, waiting: false });
        let answer;
        try {
          answer = await trpc.tour.run.mutate({ track, stepId: step.stepId, part });
        } catch (error) {
          if (mounted.current) setRun({ status: "error", error: apiErrorOf(error), nextPart: part, total });
          refresh();
          return;
        }
        refresh();
        const view = answer.results.map(viewOfResult).find((found) => found !== undefined);
        if (view !== undefined) navigate(viewPath(view, role));
        // Between parts only: after the last one the panel's buttons wait for the world on their own.
        if (part + 1 < total) {
          if (mounted.current) setRun({ status: "running", part: part + 1, total, waiting: true });
          if (!(await quiet(waitLimitMs(step)))) {
            if (mounted.current) setRun({ status: "paused", nextPart: part + 1, total });
            return;
          }
        }
      }
      if (mounted.current) setRun({ status: "done" });
    },
    [trpc, track, step, total, quiet, navigate, role, refresh],
  );

  const jump = useCallback(async () => {
    if (step.sceneId === null) return;
    setRun({ status: "running", part: 0, total, waiting: false });
    try {
      await trpc.clock.jumpToScene.mutate({ sceneId: step.sceneId });
      if (mounted.current) setRun({ status: "done", jumped: true });
    } catch (error) {
      if (mounted.current) setRun({ status: "error", error: apiErrorOf(error), nextPart: 0, total });
    } finally {
      refresh();
    }
  }, [trpc, step.sceneId, total, refresh]);

  return { run, start: (from: number) => void start(from), jump: () => void jump() };
}
