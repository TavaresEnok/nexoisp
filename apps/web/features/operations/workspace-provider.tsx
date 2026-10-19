import type { ReactNode } from "react";
import { WorkspaceContext } from "@/features/workspace/context";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { useReplaceQueryValues } from "@/lib/use-query-state";
export function OperationalWorkspaceProvider({
  children,
}: {
  children: ReactNode;
}) {
  const replaceQuery = useReplaceQueryValues();
  return (
    <TooltipProvider>
      <WorkspaceContext.Provider
        value={{
          data: undefined,
          error: undefined,
          isValidating: false,
          requestData: () => {},
          openSubscriber: (id) => replaceQuery({ ficha: id, abaFicha: null }),
          closeSubscriber: () => replaceQuery({ ficha: null, abaFicha: null }),
          refresh: async () => undefined,
        }}
      >
        {children}
        <Toaster position="bottom-right" richColors />
      </WorkspaceContext.Provider>
    </TooltipProvider>
  );
}
