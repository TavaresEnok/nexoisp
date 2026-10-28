import { useState, type ReactNode } from "react";
import useSWR from "swr";
import { z } from "zod";
import { OperationalCatalog } from "@/components/operational-catalog";
import { Panel } from "@/components/workspace-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { QueryBoundary } from "@/features/shared/feedback";
import { ActionButton } from "@/features/shared/action";
import { money } from "@/lib/format";
import { api } from "@/platform/erp-client";
import {
  batch,
  importKind,
  importRow,
  kindLabels,
  totals,
  type ImportRow,
  type ImportBatch,
  type ImportKind,
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
        <ImportBatchReconciliation batchId={batch.id} kind={batch.kind} />
        <ImportBatchRevertEligibility batchId={batch.id} />
      </DialogContent>
    </Dialog>
  );
}
const centsText = z.string().regex(/^-?\d+$/, "Centavos inválidos");
const batchReconciliation = z.object({
  invoices: z
    .object({
      count: z.number().int().nonnegative(),
      by_status: z.object({
        open: z.number().int().nonnegative(),
        paid: z.number().int().nonnegative(),
        reconciling: z.number().int().nonnegative(),
        canceled: z.number().int().nonnegative(),
      }),
      missing: z.number().int().nonnegative(),
      amount_cents: centsText,
      received_cents: centsText,
      received_after_import_cents: centsText,
      open_residual_cents: centsText,
      canceled_after_import: z.number().int().nonnegative(),
      legacy_issuance_violations: z.number().int().nonnegative(),
      by_contract: z.array(
        z.object({
          contract_id: z.string(),
          invoices: z.number().int().nonnegative(),
          open_residual_cents: centsText,
        }),
      ),
    })
    .nullable(),
  contracts: z
    .object({
      entities_created: z.number().int().nonnegative(),
      contracts_by_status: z.record(z.string(), z.number().int().nonnegative()),
      resources_pending_provision: z.number().int().nonnegative(),
    })
    .nullable(),
  evidence: z.object({
    snapshot: z.boolean(),
    note: z.string(),
  }),
});
type BatchReconciliation = z.infer<typeof batchReconciliation>;
const invoiceStatusLabel = {
  open: "Em aberto",
  paid: "Paga",
  reconciling: "Em conciliação",
  canceled: "Cancelada",
} as const;
const contractStatusLabel: Record<string, string> = {
  active: "Vigente",
  ended: "Encerrado",
};
function centsLabel(cents: string) {
  return money(Number(cents) / 100);
}
function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
const revertBlocker = z.object({
  kind: z.string(),
  count: z.number().int().nonnegative(),
  sample_ids: z.array(z.string()),
  description: z.string(),
});
const revertEligibility = z
  .object({
    batch: z.object({
      id: z.string(),
      kind: importKind,
      source: z.string(),
      created_at: z.string(),
    }),
    eligible: z.boolean(),
    blockers: z.array(revertBlocker),
    checked_at: z.string(),
    evidence: z.object({
      reverted: z.literal(false),
      note: z.string(),
    }),
  })
  .refine((value) => value.eligible === (value.blockers.length === 0), {
    message: "Elegibilidade inconsistente com os bloqueios.",
  });
function ImportBatchRevertEligibility({ batchId }: { batchId: string }) {
  const result = useSWR(
    ["erp-import-batch-revert-eligibility", batchId],
    async () =>
      revertEligibility.parse(
        await api(`/import/batches/${batchId}/revert-eligibility`),
      ),
  );
  const data = result.data;
  return (
    <Panel
      className="min-w-0"
      title="Reversão"
      description="Esta verificação não altera dados. A reversão do lote ainda não está disponível e, quando existir, compensará registros financeiros em vez de apagá-los."
    >
      <QueryBoundary
        loading={result.isLoading}
        error={result.error}
        retry={() => result.mutate()}
      >
        {data &&
          (data.eligible ? (
            <Badge variant="success">Sem efeitos posteriores</Badge>
          ) : (
            <div className="flex min-w-0 flex-col gap-3">
              <Badge variant="warning">Efeitos posteriores</Badge>
              <ul className="flex min-w-0 flex-col gap-3">
                {data.blockers.map((blocker) => (
                  <li key={blocker.kind} className="min-w-0">
                    <p>
                      {blocker.description} <strong>{blocker.count}</strong>
                    </p>
                    {blocker.sample_ids.length > 0 && (
                      <p className="mono text-xs break-all">
                        {blocker.sample_ids.join(" ")}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
      </QueryBoundary>
    </Panel>
  );
}
function ImportBatchReconciliation({
  batchId,
  kind,
}: {
  batchId: string;
  kind: ImportKind;
}) {
  const result = useSWR(
    ["erp-import-batch-reconciliation", batchId],
    async () =>
      batchReconciliation.parse(
        await api(`/import/batches/${batchId}/reconciliation`),
      ),
  );
  const data = result.data;
  return (
    <Panel
      className="min-w-0"
      title="Reconciliação"
      description="Estado atual do Nexo; não comprova o saldo na instituição de origem."
    >
      <QueryBoundary
        loading={result.isLoading}
        error={result.error}
        retry={() => result.mutate()}
      >
        {data?.invoices && <InvoiceReconciliation invoices={data.invoices} />}
        {data?.contracts && (
          <ContractReconciliation contracts={data.contracts} />
        )}
        {data && !data.invoices && !data.contracts && (
          <p>
            {kind === "invoices"
              ? "O servidor não devolveu o saldo deste lote de títulos."
              : kind === "subscribers" || kind === "contracts"
                ? "O servidor não devolveu a situação dos contratos deste lote."
                : "Este tipo de lote não tem saldo de títulos nem situação de contratos."}
          </p>
        )}
      </QueryBoundary>
    </Panel>
  );
}
function InvoiceReconciliation({
  invoices,
}: {
  invoices: NonNullable<BatchReconciliation["invoices"]>;
}) {
  const contracts = invoices.by_contract.slice(0, 500);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {(invoices.legacy_issuance_violations > 0 || invoices.missing > 0) && (
        <div className="erp-inline-actions">
          {invoices.legacy_issuance_violations > 0 && (
            <Badge variant="warning">
              títulos legados com nova cobrança — investigar
            </Badge>
          )}
          {invoices.missing > 0 && (
            <Badge variant="warning">faturas ausentes</Badge>
          )}
        </div>
      )}
      <dl className="erp-columns">
        <Fact label="Títulos localizados" value={invoices.count} />
        {(["open", "paid", "reconciling", "canceled"] as const).map(
          (status) => (
            <Fact
              key={status}
              label={invoiceStatusLabel[status]}
              value={invoices.by_status[status]}
            />
          ),
        )}
        <Fact
          label="Valor importado"
          value={centsLabel(invoices.amount_cents)}
        />
        <Fact label="Recebido" value={centsLabel(invoices.received_cents)} />
        <Fact
          label="Recebido após a importação"
          value={centsLabel(invoices.received_after_import_cents)}
        />
        <Fact
          label="Saldo em aberto"
          value={centsLabel(invoices.open_residual_cents)}
        />
        <Fact
          label="Cancelados após a importação"
          value={invoices.canceled_after_import}
        />
        <Fact label="Faturas ausentes" value={invoices.missing} />
        <Fact
          label="Títulos legados com nova cobrança"
          value={invoices.legacy_issuance_violations}
        />
      </dl>
      <div className="flex min-w-0 flex-col gap-2">
        <p>
          <strong>Contratos com maior saldo</strong>
        </p>
        <p className="profile-footnote">
          Até 500 contratos, na ordem enviada pelo servidor.
        </p>
        {contracts.length === 0 ? (
          <p>Nenhum contrato com título localizado.</p>
        ) : (
          <div className="min-w-0 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Contrato</TableHead>
                  <TableHead>Títulos</TableHead>
                  <TableHead>Saldo em aberto</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {contracts.map((row) => (
                  <TableRow key={row.contract_id}>
                    <TableCell className="mono whitespace-nowrap">
                      {row.contract_id}
                    </TableCell>
                    <TableCell>{row.invoices}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {centsLabel(row.open_residual_cents)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}
function ContractReconciliation({
  contracts,
}: {
  contracts: NonNullable<BatchReconciliation["contracts"]>;
}) {
  const statuses = Object.entries(contracts.contracts_by_status);
  return (
    <div className="flex flex-col gap-4">
      <dl className="erp-columns">
        <Fact label="Entidades criadas" value={contracts.entities_created} />
        <Fact
          label="Contas pendentes de provisionamento"
          value={contracts.resources_pending_provision}
        />
      </dl>
      <div className="flex flex-col gap-2">
        <p>
          <strong>Contratos por situação</strong>
        </p>
        {statuses.length === 0 ? (
          <p>Nenhum contrato vinculado às entidades criadas.</p>
        ) : (
          <dl className="erp-columns">
            {statuses.map(([status, count]) => (
              <Fact
                key={status}
                label={contractStatusLabel[status] ?? status}
                value={count}
              />
            ))}
          </dl>
        )}
      </div>
    </div>
  );
}
