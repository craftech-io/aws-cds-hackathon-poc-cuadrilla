/// <reference path="../../../sst-env.d.ts" />
// Physical names of what infra links into `DispatchMock` (`Resource`, never `process.env`): its
// `Dispatch` table and the `Feeds` bus. `sst-env.d.ts` stays empty until the first deploy, so the
// linked value is read as unknown and checked with zod at first use.
import { Resource } from "sst";
import { z } from "zod";

export type DispatchLink = "Dispatch" | "Feeds";

const Linked = z.object({ name: z.string().min(1) });

export function linkedName(link: DispatchLink): string {
  let raw: unknown;
  try {
    raw = Reflect.get(Resource, link);
  } catch (error) {
    throw new Error(`resource "${link}" is not linked to DispatchMock`, { cause: error });
  }
  return Linked.parse(raw).name;
}
