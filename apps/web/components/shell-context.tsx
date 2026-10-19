import { createContext, useContext } from "react";
import type { NavigationArea, NavigationNode } from "@/lib/navigation";

/**
 * Adaptador que a aplicação operacional injeta no shell do v0.
 * Sem provedor, o shell funciona exatamente como na demonstração original.
 */
export type ShellRecordSearch = {
  results?: { id: string; title: string; detail: string; href: string }[];
  error?: Error;
  loading: boolean;
};
export type ShellAttention = {
  items: { id: string; title: string; href: string; area: "network" | "support" | "field" | "other" }[];
  loading: boolean;
  error?: Error;
};
export type ShellAdapter = {
  account: {
    name: string;
    initials: string;
    role: string;
    tenant: string | null;
    demo: boolean;
    support: boolean;
  } | null;
  canAccess: (path: string) => boolean;
  connected: (path: string) => boolean;
  title: (path: string) => string | undefined;
  areas: () => NavigationArea[];
  findPage: (path: string) => NavigationNode | undefined;
  branch: (node: NavigationNode) => NavigationNode;
  searchPages: (query: string) => NavigationNode[];
  personal: { href: string; label: string; audience: NavigationNode["audience"] } | null;
  useRecordSearch: (query: string) => ShellRecordSearch;
  useAttention: () => ShellAttention;
  logout: () => Promise<void>;
  exitSupport: () => Promise<void>;
};

const ShellContext = createContext<ShellAdapter | null>(null);
export const ShellProvider = ShellContext.Provider;
export function useShell() {
  return useContext(ShellContext);
}
const idle: ShellRecordSearch = { loading: false };
export function useNoRecordSearch(): ShellRecordSearch {
  return idle;
}
const quiet: ShellAttention = { items: [], loading: false };
export function useNoAttention(): ShellAttention {
  return quiet;
}
