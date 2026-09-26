// Stub of the `ScheduleDispatch` entry (docs/build-plan.md §2: an infra work package that points at a handler
// that does not exist yet creates it answering UNAVAILABLE; WP-33 replaces it). It reads, stores and
// logs nothing and never throws, so a timer schedule fires into nothing while no world runs in real time.
export interface HandlerUnavailable {
  readonly status: "UNAVAILABLE";
}

export async function handler(): Promise<HandlerUnavailable> {
  return { status: "UNAVAILABLE" };
}
