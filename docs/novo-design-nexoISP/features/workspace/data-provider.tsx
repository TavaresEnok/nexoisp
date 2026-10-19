"use client";

import { createContext, useContext, type ReactNode } from "react";
import useSWR from "swr";
import type { DataReader } from "@/application/readers";
import type { WorkspaceData } from "@/lib/types";

type WorkspaceDataState = {
  data: WorkspaceData | undefined;
  error: unknown;
  isValidating: boolean;
  refresh: () => Promise<WorkspaceData | undefined>;
};
const DataContext = createContext<WorkspaceDataState | null>(null);

export function WorkspaceDataProvider({ children, enabled, readWorkspace, cacheKey }: {
  children: ReactNode; enabled: boolean; readWorkspace: DataReader<WorkspaceData>; cacheKey: string;
}) {
  const { data, error, isValidating, mutate } = useSWR(enabled ? cacheKey : null, readWorkspace, {
    revalidateOnFocus: false, shouldRetryOnError: false,
  });
  return <DataContext.Provider value={{ data, error, isValidating, refresh: () => mutate() }}>{children}</DataContext.Provider>;
}

export function useWorkspaceData() {
  const context = useContext(DataContext);
  if (!context) throw new Error("WorkspaceDataProvider ausente.");
  return context;
}
