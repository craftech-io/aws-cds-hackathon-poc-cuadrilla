// Where the console finds each view. A view is the default export of `views/<view>/view.tsx`,
// discovered at build time and loaded lazily, and a view that does not exist yet renders the
// placeholder of its route. The shell's guided-tour panel is found the same way, in
// `views/tour/panel.tsx`. So the work packages that write the views (docs/build-plan.md, wave 5)
// add their own files and never edit the route table, the shell or each other's code.
import { type ComponentType, type LazyExoticComponent, lazy } from "react";

export interface ViewProps {
  /** Named segments of the route pattern (`/app/orders/:workOrderId` → `workOrderId`). */
  readonly params: Readonly<Record<string, string>>;
}

export interface ModuleOf<P> {
  readonly default: ComponentType<P>;
}

export type ModuleLoader<P> = () => Promise<ModuleOf<P>>;

export interface ModuleRegistry<P> {
  /** Directories under `views/` that provide the module. */
  readonly names: readonly string[];
  /** The lazy component of `views/<name>/…`, the same instance on every call; undefined while it does not exist. */
  component(name: string): LazyExoticComponent<ComponentType<P>> | undefined;
}

const VIEW_DIR = /\/views\/([a-z0-9]+(?:-[a-z0-9]+)*)\/[^/]+\.tsx$/;

/** Registry over the result of `import.meta.glob`: keys are module paths, values their loaders. */
export function createModuleRegistry<P>(modules: Readonly<Record<string, ModuleLoader<P>>>): ModuleRegistry<P> {
  const loaders = new Map<string, ModuleLoader<P>>();
  for (const [path, loader] of Object.entries(modules)) {
    const name = VIEW_DIR.exec(path)?.[1];
    if (name) loaders.set(name, loader);
  }
  const components = new Map<string, LazyExoticComponent<ComponentType<P>>>();
  return {
    names: [...loaders.keys()].sort(),
    component(name) {
      const cached = components.get(name);
      if (cached) return cached;
      const loader = loaders.get(name);
      if (!loader) return undefined;
      const component = lazy(loader);
      components.set(name, component);
      return component;
    },
  };
}

/** Console and public views: `views/<view>/view.tsx`. */
export const VIEWS = createModuleRegistry<ViewProps>(import.meta.glob<ModuleOf<ViewProps>>("../views/*/view.tsx"));

/** The guided-tour panel of the shell: `views/tour/panel.tsx`. */
export const PANELS = createModuleRegistry<Record<string, never>>(import.meta.glob<ModuleOf<Record<string, never>>>("../views/tour/panel.tsx"));
