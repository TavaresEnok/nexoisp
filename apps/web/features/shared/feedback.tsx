import type { ReactNode } from "react";
import { AlertCircle, Database, LoaderCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
export function QueryBoundary({
  loading,
  error,
  retry,
  children,
}: {
  loading?: boolean;
  error?: unknown;
  retry?: () => unknown;
  children: ReactNode;
}) {
  if (error)
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertTitle>Consulta indisponível</AlertTitle>
        <AlertDescription>
          <p>
            {error instanceof Error
              ? error.message
              : "Não foi possível consultar o servidor."}
          </p>
          {retry && (
            <Button variant="outline" onClick={() => void retry()}>
              Tentar novamente
            </Button>
          )}
        </AlertDescription>
      </Alert>
    );
  if (loading)
    return (
      <section
        aria-label="Carregando consulta"
        aria-busy="true"
        className="flex flex-col gap-5"
      >
        <Skeleton className="h-16 w-2/3" />
        <Skeleton className="h-80 w-full" />
      </section>
    );
  return children;
}
export function ConnectedNotice({ demo = false }: { demo?: boolean }) {
  return (
    <div className="erp-source">
      <Badge variant="outline">
        <Database size={13} />
        Conectado ao ERP
      </Badge>
      {demo && (
        <span>Ambiente demonstrativo do servidor · dados sintéticos</span>
      )}
    </div>
  );
}
export function Busy({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2">
      <LoaderCircle className="size-4 animate-spin" />
      {children}
    </span>
  );
}
