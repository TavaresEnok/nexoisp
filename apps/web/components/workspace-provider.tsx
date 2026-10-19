"use client";

import { useState, type ReactNode } from "react";
import { usePathname, useSearchParams } from "@/platform/navigation/react";
import { WorkspaceDataProvider, useWorkspaceData } from "@/features/workspace/data-provider";
import { demoReaders } from "@/data/demo/readers";
import { isDemoMode, executionMode } from "@/application/execution-mode";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { needsWorkspaceData } from "@/application/workspace-demand";
import { useReplaceQueryValues } from "@/lib/use-query-state";
import type { WorkspaceData } from "@/domain/workspace";
import type { DataReader } from "@/application/readers";
import { SubscriberSheet } from "@/components/subscriber-sheet";

import { WorkspaceContext } from "@/features/workspace/context";
export { useWorkspaceStatus, useWorkspace } from "@/features/workspace/context";

const defaultReadWorkspace = demoReaders.readWorkspace;

export function WorkspaceProvider({ children, readWorkspace = defaultReadWorkspace, cacheKey = `workspace:${executionMode}` }: {
  children: ReactNode;
  readWorkspace?: DataReader<WorkspaceData>;
  cacheKey?: string;
}) {
  const pathname = usePathname();
  const params = useSearchParams();
  const [requested, setRequested] = useState(false);
  const subscriberId = params.get("ficha");
  const needsData = needsWorkspaceData(pathname, requested, subscriberId);
  return <WorkspaceDataProvider enabled={needsData} readWorkspace={readWorkspace} cacheKey={cacheKey}><WorkspaceNavigation subscriberId={subscriberId} requestData={() => setRequested(true)}>{children}</WorkspaceNavigation></WorkspaceDataProvider>;
}

function WorkspaceNavigation({ children, subscriberId, requestData }: { children: ReactNode; subscriberId: string | null; requestData: () => void }) {
  const { data, error, refresh, isValidating } = useWorkspaceData();
  const replaceQueryValues = useReplaceQueryValues();
  const closeSubscriber = () => replaceQueryValues({ ficha: null, abaFicha: null });
  return <TooltipProvider><WorkspaceContext.Provider value={{ data, error, isValidating, requestData, openSubscriber: id => { requestData(); replaceQueryValues({ ficha: id, abaFicha: null }); }, closeSubscriber, refresh }}>
    {data && Boolean(error) && <div className="workspace-stale-notice"><Alert variant="destructive"><AlertTitle>Não foi possível atualizar a consulta</AlertTitle><AlertDescription>{isDemoMode ? "Exibindo a última leitura local disponível. O cenário não pôde ser relido." : "Exibindo a última consulta disponível. O estado atual do Neon não foi confirmado."}</AlertDescription></Alert></div>}
    {children}
    {data && <SubscriberSheet subscriberId={subscriberId} onClose={closeSubscriber} />}
    <Toaster position="bottom-right" richColors />
  </WorkspaceContext.Provider></TooltipProvider>;
}
