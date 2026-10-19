"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { QueryValues } from "./query";

export interface NavigationAdapter {
  pathname: string;
  search: string;
  getSearch: () => string;
  push: (href: string) => void;
  replace: (href: string) => void;
  refresh: () => void;
  replaceQuery: (values: QueryValues) => void;
}
const NavigationContext = createContext<NavigationAdapter | null>(null);
export function NavigationProvider({ adapter, children }: { adapter: NavigationAdapter; children: ReactNode }) {
  return <NavigationContext.Provider value={adapter}>{children}</NavigationContext.Provider>;
}
export function useNavigation() {
  const value = useContext(NavigationContext);
  if (!value) throw new Error("NavigationProvider ausente.");
  return value;
}
export const usePathname = () => useNavigation().pathname;
export const useRouter = useNavigation;
export function useSearchParams() {
  const { search } = useNavigation();
  return useMemo(() => new URLSearchParams(search), [search]);
}
