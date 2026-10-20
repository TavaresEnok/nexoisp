import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";

// Destinos "Novo …" do menu do v0 chegam como ?novo=<tipo>. O pedido é
// consumido: o parâmetro sai da URL e o diálogo abre como pelo botão da página,
// somente quando o botão estaria disponível para a conta. Com `allowed`
// indefinido (permissão ainda carregando), o pedido aguarda.
export function useCreateRequest(
  kind: string,
  open: () => void,
  allowed: boolean | undefined = true,
) {
  const [params, setParams] = useSearchParams();
  const requested = params.get("novo") === kind;
  const latest = useRef(open);
  latest.current = open;
  useEffect(() => {
    if (!requested || allowed === undefined) return;
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete("novo");
        return next;
      },
      { replace: true },
    );
    if (allowed) latest.current();
  }, [requested, allowed, setParams]);
}
