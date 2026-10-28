import { useState } from "react";
import useSWR from "swr";
import { z } from "zod";
import { OperationalCatalog } from "@/components/operational-catalog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { QueryBoundary } from "@/features/shared/feedback";
import { ActionButton } from "@/features/shared/action";
import { api } from "@/platform/erp-client";
import {
  batch,
  importRow,
  kindLabels,
  totals,
  type ImportRow,
  type ImportBatch,
} from "./import-models";
const importBatch = batch.extend({
  totals: totals.extend({ conflicts: z.coerce.number().optional() }),
});
export function ImportResults({
  rows,
  title = "Linhas com erro ou aviso",
}: {
  rows: ImportRow[];
  title?: string;
}) {
  return (
    <OperationalCatalog
      title={title}
      description="Consulte o resultado de cada linha antes de corrigir e reimportar. As linhas válidas são preservadas."
      columns={["Linha", "Identificador na origem", "Resultado", "Mensagens"]}
      rows={rows.map((item, index) => ({
        id: `${item.row}:${index}`,
        cells: [
          item.row,
          item.external_id ?? "Não informado",
          (
            {
              created: "Novo",
              updated: "Atualizado",
              unchanged: "Sem alteração",
              error: "Erro",
            } as Record<string, string>
          )[item.status] ?? item.status,
          item.messages.join(" · ") || "Sem mensagem",
        ],
      }))}
      empty="Nenhuma linha com erro ou aviso."
    />
  );
}
export function ImportBatches() {
  const result = useSWR("erp-import-batches", async () =>
    z.array(importBatch).parse(await api("/import/batches")),
  );
  const [detail, setDetail] = useState<ImportBatch | null>(null);
  const [message, setMessage] = useState("");
  return (
    <QueryBoundary
      loading={result.isLoading}
      error={result.error}
      retry={() => result.mutate()}
    >
      {message && <p role="status">{message}</p>}
      <OperationalCatalog
        title="Lotes importados"
        description="Cinquenta lotes mais recentes. Provisionamento é uma ação separada, somente para contas com senha; acompanhe as operações de rede após solicitar."
        columns={[
          "Quando",
          "Arquivo / origem",
          "Conteúdo",
          "Resultado",
          "Autor",
          "Contas a provisionar",
        ]}
        rows={(result.data ?? []).map((item) => ({
          id: item.id,
          cells: [
            new Date(item.created_at).toLocaleString("pt-BR"),
            <>
              <strong>{item.filename ?? "Sem nome"}</strong>
              <small className="table-subline">{item.source}</small>
            </>,
            kindLabels[item.kind],
            <>
              {`${item.totals.created} novos · ${item.totals.updated} atualizados · ${item.totals.unchanged} iguais · ${item.totals.error} erros`}
              {(item.totals.conflicts ?? 0) > 0 && (
                <>
                  {" · "}
                  <Badge variant="warning">
                    {item.totals.conflicts} divergentes da origem (não
                    alterados)
                  </Badge>
                </>
              )}
            </>,
            item.created_by_name ?? "Não informado",
            item.accounts_to_provision,
          ],
          actions: (
            <div className="erp-inline-actions">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDetail(item)}
              >
                Ver erros e avisos
              </Button>
              {item.accounts_to_provision > 0 && (
                <ActionButton
                  confirm={`Solicitar o provisionamento de ${item.accounts_to_provision} contas deste lote? Execute somente no momento combinado para a virada do grupo.`}
                  onClick={async () => {
                    const response = await api<{ requested: number }>(
                      `/import/batches/${item.id}/provision`,
                      { method: "POST" },
                    );
                    setMessage(
                      `${response.requested} operações solicitadas. Acompanhe a confirmação em Operações de rede.`,
                    );
                    await result.mutate();
                  }}
                >
                  Provisionar contas do lote
                </ActionButton>
              )}
            </div>
          ),
        }))}
      />
      {detail && (
        <ImportBatchDetail batch={detail} onClose={() => setDetail(null)} />
      )}
    </QueryBoundary>
  );
}
function ImportBatchDetail({
  batch,
  onClose,
}: {
  batch: ImportBatch;
  onClose: () => void;
}) {
  const result = useSWR(["erp-import-batch", batch.id], async () =>
    z.array(importRow).parse(await api(`/import/batches/${batch.id}`)),
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="erp-editor">
        <DialogHeader>
          <DialogTitle>Lote · {batch.filename ?? batch.id}</DialogTitle>
          <DialogDescription>
            {batch.source} · {kindLabels[batch.kind]}
          </DialogDescription>
        </DialogHeader>
        <QueryBoundary
          loading={result.isLoading}
          error={result.error}
          retry={() => result.mutate()}
        >
          <ImportResults rows={result.data ?? []} />
        </QueryBoundary>
      </DialogContent>
    </Dialog>
  );
}
