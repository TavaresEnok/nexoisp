import { createContext, useContext } from "react";
import type { WorkspaceData } from "@/domain/workspace";
export type WorkspaceContextValue = {
  data: WorkspaceData | undefined;
  error: unknown;
  isValidating: boolean;
  requestData: () => void;
  openSubscriber: (id: string) => void;
  closeSubscriber: () => void;
  refresh: () => Promise<WorkspaceData | undefined>;
};
export const WorkspaceContext = createContext<WorkspaceContextValue | null>(
  null,
);
export function useWorkspaceStatus() {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error("WorkspaceProvider ausente.");
  return context;
}
export function useWorkspace() {
  const context = useWorkspaceStatus();
  if (!context.data)
    throw new Error(
      "A consulta precisa estar dentro de WorkspaceDataBoundary.",
    );
  return { ...context, data: context.data };
}
