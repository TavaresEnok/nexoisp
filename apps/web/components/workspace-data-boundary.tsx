"use client";

import { AlertCircle } from "lucide-react";
import type { ReactNode } from "react";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useWorkspaceStatus } from "@/components/workspace-provider";
import { isDemoMode } from "@/application/execution-mode";

export function WorkspaceDataBoundary({ children }: { children: ReactNode }) {
  const { data, error, refresh, isValidating } = useWorkspaceStatus();
  if (data) return children;
  if (error) return <Alert variant="destructive"><AlertCircle /><AlertTitle>Consulta indisponível</AlertTitle><AlertDescription><p>{isDemoMode ? "Não foi possível validar o cenário local. A navegação continua disponível; nenhum serviço remoto foi acionado." : "Não foi possível carregar os dados. A navegação e o acompanhamento continuam disponíveis; nenhum dado foi substituído por uma amostra local."}</p><Button variant="outline" disabled={isValidating} onClick={() => void refresh().catch(() => undefined)}>Tentar novamente</Button></AlertDescription></Alert>;
  return <section className="flex flex-col gap-5" aria-label="Carregando consulta" aria-busy="true"><span className="sr-only" role="status">{isDemoMode ? "Lendo cenário demonstrativo local" : "Consultando dados do Neon"}</span><Skeleton className="h-16 w-2/3" /><div className="grid grid-cols-2 gap-4"><Skeleton className="h-28 w-full" /><Skeleton className="h-28 w-full" /></div><Skeleton className="h-80 w-full" /></section>;
}
