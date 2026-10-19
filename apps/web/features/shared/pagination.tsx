import { useSearchParams } from "react-router-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
export function useUrlPage() {
 const [params, setParams] = useSearchParams(); const raw = Number(params.get("pagina") ?? "1"); const page = Number.isSafeInteger(raw) && raw > 0 ? raw - 1 : 0;
 return { page, setPage: (next: number) => setParams(current => { const params = new URLSearchParams(current); next > 0 ? params.set("pagina", String(next + 1)) : params.delete("pagina"); return params; }, { replace: true }) };
}
export function ServerPager({ page, setPage, total, size = 8, loading = false }: { page: number; setPage: (page: number) => void; total: number; size?: number; loading?: boolean }) {
 const pages = Math.max(1, Math.ceil(total / size));
 return <div className="erp-pagination"><span>{total} registro(s) · página {page + 1} de {pages}</span><Button variant="outline" size="sm" disabled={loading || page <= 0} onClick={() => setPage(page - 1)}><ChevronLeft />Anterior</Button><Button variant="outline" size="sm" disabled={loading || page + 1 >= pages} onClick={() => setPage(page + 1)}>Próxima<ChevronRight /></Button></div>;
}
