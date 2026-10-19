import { useSearchParams } from "react-router-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

export const pageSizes = [8, 25, 50];

/** Página e quantidade de linhas persistidas na URL (`pagina` e `linhas`). */
export function useUrlPage() {
  const [params, setParams] = useSearchParams();
  const raw = Number(params.get("pagina") ?? "1");
  const page = Number.isSafeInteger(raw) && raw > 0 ? raw - 1 : 0;
  const requested = Number(params.get("linhas") ?? "8");
  const size = pageSizes.includes(requested) ? requested : 8;
  const update = (values: Record<string, string | null>) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        for (const [key, value] of Object.entries(values))
          value ? next.set(key, value) : next.delete(key);
        return next;
      },
      { replace: true },
    );
  return {
    page,
    size,
    setPage: (next: number) =>
      update({ pagina: next > 0 ? String(next + 1) : null }),
    setSize: (next: number) =>
      update({ linhas: next === 8 ? null : String(next), pagina: null }),
  };
}

/** Paginação do v0 para consultas paginadas no servidor. */
export function ServerPager({
  page,
  setPage,
  total,
  size = 8,
  setSize,
  loading = false,
  noun = "registros",
}: {
  page: number;
  setPage: (page: number) => void;
  total: number;
  size?: number;
  setSize?: (size: number) => void;
  loading?: boolean;
  noun?: string;
}) {
  const pages = Math.max(1, Math.ceil(total / size));
  const start = total ? page * size + 1 : 0;
  const end = Math.min((page + 1) * size, total);
  return (
    <div className="pagination">
      <span>
        {total
          ? `${start}–${end} de ${total} ${noun}`
          : "Nenhum registro encontrado"}
      </span>
      <div>
        {setSize && (
          <select
            className="commercial-select"
            aria-label="Registros por página"
            value={size}
            onChange={(event) => setSize(Number(event.target.value))}
          >
            {pageSizes.map((option) => (
              <option key={option} value={option}>
                {option} por página
              </option>
            ))}
          </select>
        )}
        <span>
          Página {page + 1} de {pages}
        </span>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Página anterior"
          disabled={loading || page <= 0}
          onClick={() => setPage(page - 1)}
        >
          <ChevronLeft />
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Próxima página"
          disabled={loading || page + 1 >= pages}
          onClick={() => setPage(page + 1)}
        >
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}
