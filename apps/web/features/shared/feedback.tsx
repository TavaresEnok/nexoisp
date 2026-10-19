import type { ReactNode } from "react";
import { Database, LoaderCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
export { QueryBoundary } from "@/components/query-boundary";
/** O aviso de ambiente demonstrativo do servidor já aparece no topo do shell. */
export function ConnectedNotice(_props: { demo?: boolean } = {}) {
  return (
    <div className="erp-source">
      <Badge variant="outline">
        <Database size={13} />
        Conectado ao ERP
      </Badge>
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
