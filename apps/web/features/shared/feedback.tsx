import type { ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
export { QueryBoundary } from "@/components/query-boundary";
/** Telas conectadas não exibem selo próprio: o v0 não tem esse elemento e o banner do shell já identifica o ambiente demonstrativo. */
export function ConnectedNotice(_props: { demo?: boolean } = {}) {
  return null;
}
export function Busy({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2">
      <LoaderCircle className="size-4 animate-spin" />
      {children}
    </span>
  );
}
