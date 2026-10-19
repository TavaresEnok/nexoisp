import { Database } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { TechnicalCatalogView } from "@/features/technical/catalog-view";
import { demoReaders } from "@/data/demo/readers";
import useSWR from "swr";
import { Skeleton } from "@/components/ui/skeleton";
import type { CoreTab } from "@/lib/technical-catalog";

export function TechnicalWorkspace({ mode }: { mode: "models" | "templates" | CoreTab }) {
  const { data: catalog, error } = useSWR("technical-catalog:demo", demoReaders.readTechnicalCatalog, { revalidateOnFocus: false, shouldRetryOnError: false });
  if (error) return <Alert variant="destructive"><Database /><AlertTitle>Catálogo técnico indisponível</AlertTitle><AlertDescription>Não foi possível validar o catálogo local. Recarregue a página para reler o cenário. Nenhum serviço remoto foi acionado.</AlertDescription></Alert>;
  if (!catalog) return <div className="flex flex-col gap-5"><Skeleton className="h-20 w-2/3" /><Skeleton className="h-96 w-full" /></div>;
  return <TechnicalCatalogView catalog={catalog} mode={mode} />;
}
