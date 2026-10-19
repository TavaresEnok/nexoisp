/** Estados de consulta reutilizados pelos componentes do v0 nas telas conectadas. */
import type { ReactNode } from "react";
import { AlertCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
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
