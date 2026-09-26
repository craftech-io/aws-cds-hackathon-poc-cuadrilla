// Operator-level state shared by every view: the operator comes from the JWT (`ispId`) and the
// scope that filters the work (field crew and day, `ScopeBar`). The operator's visible name comes
// from the brand (BrandContext) and the world clock from WorldClockContext; views read the scope
// through `useIsp`.
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

export interface WorkScope {
  /** Field crew (`crew-…`); every crew when absent. */
  readonly crewId?: string;
  /** Calendar day of the world clock (`YYYY-MM-DD`); today of the world when absent. */
  readonly day?: string;
}

export interface IspValue {
  readonly ispId: string;
  readonly scope: WorkScope;
  setScope(scope: WorkScope): void;
}

const IspContext = createContext<IspValue | undefined>(undefined);

interface IspProviderProps {
  readonly ispId: string;
  readonly children: ReactNode;
}

export function IspProvider({ ispId, children }: IspProviderProps) {
  const [scope, setScope] = useState<WorkScope>({});
  const value = useMemo<IspValue>(() => ({ ispId, scope, setScope }), [ispId, scope]);
  return <IspContext.Provider value={value}>{children}</IspContext.Provider>;
}

export function useIsp(): IspValue {
  const value = useContext(IspContext);
  if (!value) throw new Error("useIsp must be used inside IspProvider");
  return value;
}
