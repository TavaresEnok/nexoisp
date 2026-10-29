import { useRef, useState, type ReactNode } from "react";
import useSWR, { useSWRConfig } from "swr";
import { z } from "zod";
import { OperationalCatalog } from "@/components/operational-catalog";
import { Panel } from "@/components/workspace-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
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
import { ApiError } from "@/data/erp/http";
import { QueryBoundary } from "@/features/shared/feedback";
import { ActionButton } from "@/features/shared/action";
import { can, type Session } from "@/features/session/model";
import { useSession } from "@/features/session/provider";
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
  const { me } = useSession();
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
        <ImportBatchRevertEligibility
          batchId={batch.id}
          kind={batch.kind}
          scope={importCompensateScope(me)}
        />
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
const compensationEvidence = z
  .object({
    reverted: z.literal(false),
    note: z.string(),
  })
  .strict();
const compensationResult = z
  .object({
    batch_id: z.uuid(),
    compensation_id: z.uuid(),
    idempotent_replay: z.boolean(),
    created_rows: z.number().int().nonnegative(),
    reversed_payments: z.number().int().nonnegative(),
    canceled_invoices: z.number().int().nonnegative(),
    left_canceled: z.number().int().nonnegative(),
    skipped_unchanged: z.number().int().nonnegative(),
    skipped_error: z.number().int().nonnegative(),
    evidence: compensationEvidence,
  })
  .strict();
const compensationView = z.discriminatedUnion("state", [
  z.object({ state: z.literal("absent") }).strict(),
  z
    .object({
      state: z.literal("committed"),
      compensation_id: z.uuid(),
      created_at: z.iso.datetime({ offset: true }),
      reason: z.string(),
      result: compensationResult,
    })
    .strict(),
]);
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
    compensation: compensationView,
  })
  .refine((value) => value.eligible === (value.blockers.length === 0), {
    message: "Elegibilidade inconsistente com os bloqueios.",
  });
const compensateConflict = z.object({
  error: z.string(),
  blockers: z.array(revertBlocker).optional(),
});
type CompensationResult = z.infer<typeof compensationResult>;
type RevertBlocker = z.infer<typeof revertBlocker>;
type CompensationRefusal = { message: string; blockers: RevertBlocker[] };
const compensationCountLabels = [
  ["created_rows", "Linhas criadas"],
  ["reversed_payments", "Pagamentos estornados"],
  ["canceled_invoices", "Faturas canceladas"],
  ["left_canceled", "Faturas que já estavam canceladas"],
  ["skipped_unchanged", "Linhas sem alteração"],
  ["skipped_error", "Linhas com erro, sem efeito"],
] as const;
function importCompensateScope(me: Session | null) {
  return {
    tenantIntegral: me?.role === "admin" && Boolean(me.tenant) && !me.support,
    importRun: can(me, "import:run"),
  };
}
function compensationReason(value: string) {
  const reason = value.trim();
  const length = Array.from(reason).length;
  if (length < 10 || length > 200) return null;
  return reason;
}
function terminalHttpStatus(status: number) {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}
function dropCompensationSecrets(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = { ...(value as Record<string, unknown>) };
  delete record.idempotency_key;
  delete record.request_hash;
  if ("compensation" in record)
    record.compensation = dropCompensationSecrets(record.compensation);
  if ("result" in record)
    record.result = dropCompensationSecrets(record.result);
  return record;
}
class CompensationRequestError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "CompensationRequestError";
    this.status = status;
    this.body = body;
  }
}
// O cliente oficial anexa o CSRF e não recebe cabeçalho avulso. A chave desta
// intenção entra só no fetch do POST, e o corpo de erro fica disponível para o 409.
async function postBatchCompensation(
  batchId: string,
  reason: string,
  idempotencyKey: string,
) {
  const previous = globalThis.fetch;
  let failureBody: unknown = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const target = url.includes(`/api/import/batches/${batchId}/compensate`);
    const response = await previous.call(
      globalThis,
      input,
      target
        ? {
            ...init,
            headers: new Headers([
              ...new Headers(init?.headers).entries(),
              ["Idempotency-Key", idempotencyKey],
            ]),
          }
        : init,
    );
    if (target) {
      failureBody = response.ok
        ? null
        : await response
            .clone()
            .json()
            .catch(() => null);
    }
    return response;
  }) as typeof fetch;
  try {
    return await api<unknown>(`/import/batches/${batchId}/compensate`, {
      method: "POST",
      body: { reason },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      throw new CompensationRequestError(
        error.status,
        error.message,
        failureBody,
      );
    }
    throw error;
  } finally {
    globalThis.fetch = previous;
  }
}
function RevertBlockers({ blockers }: { blockers: RevertBlocker[] }) {
  return (
    <ul className="flex min-w-0 flex-col gap-3">
      {blockers.map((blocker) => (
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
  );
}
function CompensationCounts({ result }: { result: CompensationResult }) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <dl className="erp-columns">
        {compensationCountLabels.map(([key, label]) => (
          <Fact key={key} label={label} value={result[key]} />
        ))}
      </dl>
      <p>{result.evidence.note}</p>
    </div>
  );
}
function ImportBatchRevertEligibility({
  batchId,
  kind,
  scope,
}: {
  batchId: string;
  kind: ImportKind;
  scope: { tenantIntegral: boolean; importRun: boolean };
}) {
  const { mutate } = useSWRConfig();
  const intent = useRef<{ reason: string; key: string } | null>(null);
  const [reasonText, setReasonText] = useState("");
  const [attempt, setAttempt] = useState<CompensationResult | null>(null);
  const [refusal, setRefusal] = useState<CompensationRefusal | null>(null);
  const [notice, setNotice] = useState("");
  const result = useSWR(
    ["erp-import-batch-revert-eligibility", batchId],
    async () =>
      revertEligibility.parse(
        dropCompensationSecrets(
          await api(`/import/batches/${batchId}/revert-eligibility`),
        ),
      ),
  );
  const data = result.data;
  const committed =
    data?.compensation.state === "committed" ? data.compensation : null;
  const reason = compensationReason(reasonText);
  const canCompensate =
    kind === "invoices" &&
    data?.batch.kind === "invoices" &&
    data.compensation.state === "absent" &&
    scope.tenantIntegral &&
    scope.importRun;
  const refreshSheet = async () => {
    const next = await result.mutate();
    await mutate(
      (key) =>
        Array.isArray(key) &&
        key[1] === batchId &&
        (key[0] === "erp-import-batch" ||
          key[0] === "erp-import-batch-reconciliation"),
      undefined,
      { revalidate: true },
    );
    return next;
  };
  const idempotencyKey = (value: string) => {
    if (intent.current?.reason === value) return intent.current.key;
    const key = crypto.randomUUID();
    intent.current = { reason: value, key };
    return key;
  };
  return (
    <Panel
      className="min-w-0"
      title="Reversão"
      description={
        kind === "invoices"
          ? "Esta verificação não altera dados. Compensar acrescenta estorno e cancelamento locais e não apaga pagamento, movimento, lote nem auditoria."
          : "Esta verificação não altera dados. A reversão deste tipo de lote não está disponível."
      }
    >
      <QueryBoundary
        loading={result.isLoading}
        error={result.error}
        retry={() => result.mutate()}
      >
        {data && (
          <div className="flex min-w-0 flex-col gap-4">
            {data.eligible ? (
              <Badge variant="success">Sem efeitos posteriores</Badge>
            ) : (
              <div className="flex min-w-0 flex-col gap-3">
                <Badge variant="warning">Efeitos posteriores</Badge>
                <RevertBlockers blockers={data.blockers} />
              </div>
            )}
            <p className="profile-footnote">{data.evidence.note}</p>
            {committed ? (
              <div className="flex min-w-0 flex-col gap-3">
                <Badge variant="info">Compensação registrada</Badge>
                <dl className="erp-columns">
                  <Fact
                    label="Identificador"
                    value={
                      <span className="mono break-all">
                        {committed.compensation_id}
                      </span>
                    }
                  />
                  <Fact
                    label="Quando"
                    value={new Date(committed.created_at).toLocaleString(
                      "pt-BR",
                    )}
                  />
                  <Fact label="Motivo" value={committed.reason} />
                </dl>
                <CompensationCounts result={committed.result} />
              </div>
            ) : (
              <p>Nenhuma compensação registrada neste lote.</p>
            )}
            {attempt && (
              <div className="flex min-w-0 flex-col gap-3" role="status">
                <p>
                  {attempt.idempotent_replay
                    ? "O servidor repetiu a compensação já registrada e não lançou outro estorno."
                    : "Compensação aceita. Nenhum registro foi apagado."}
                </p>
                {committed?.compensation_id !== attempt.compensation_id && (
                  <CompensationCounts result={attempt} />
                )}
              </div>
            )}
            {refusal && (
              <div className="flex min-w-0 flex-col gap-3" role="alert">
                <p>A compensação não foi aplicada. {refusal.message}</p>
                {refusal.blockers.length > 0 && (
                  <RevertBlockers blockers={refusal.blockers} />
                )}
              </div>
            )}
            {notice && <p role="status">{notice}</p>}
            {canCompensate && (
              <div className="flex min-w-0 flex-col gap-3">
                <label className="flex min-w-0 flex-col gap-2">
                  Motivo da compensação
                  <Textarea
                    value={reasonText}
                    maxLength={200}
                    required
                    onChange={(event) => setReasonText(event.target.value)}
                  />
                  <small className="text-muted-foreground">
                    Depois de remover espaços nas pontas, o motivo precisa ter
                    de 10 a 200 caracteres.
                  </small>
                </label>
                <ActionButton
                  danger
                  disabled={!reason}
                  confirm="Compensar os títulos deste lote? O servidor revalida a operação, estorna baixas locais e cancela faturas, sem apagar histórico."
                  onClick={async () => {
                    const current = compensationReason(reasonText);
                    if (!current) {
                      throw new Error(
                        "Informe um motivo entre 10 e 200 caracteres.",
                      );
                    }
                    setNotice("");
                    setRefusal(null);
                    let key: string;
                    try {
                      key = idempotencyKey(current);
                    } catch {
                      throw new Error(
                        "Não foi possível preparar a chave desta tentativa.",
                      );
                    }
                    let raw: unknown;
                    try {
                      raw = await postBatchCompensation(batchId, current, key);
                    } catch (error) {
                      if (!(error instanceof CompensationRequestError)) {
                        const recovered = await refreshSheet().catch(
                          () => undefined,
                        );
                        if (recovered?.compensation.state === "committed") {
                          intent.current = null;
                          setNotice(
                            "A resposta da tentativa não chegou íntegra. A leitura do lote mostra a compensação registrada.",
                          );
                          return;
                        }
                        throw error instanceof Error
                          ? error
                          : new Error(
                              "Não foi possível concluir a compensação.",
                            );
                      }
                      const terminal = terminalHttpStatus(error.status);
                      if (terminal) intent.current = null;
                      const conflict = compensateConflict.safeParse(error.body);
                      if (error.status === 409 && conflict.success) {
                        setRefusal({
                          message: conflict.data.error,
                          blockers: conflict.data.blockers ?? [],
                        });
                        await refreshSheet().catch(() => undefined);
                        return;
                      }
                      const recovered = await refreshSheet().catch(
                        () => undefined,
                      );
                      if (recovered?.compensation.state === "committed") {
                        intent.current = null;
                        setNotice(
                          "A resposta da tentativa não chegou íntegra. A leitura do lote mostra a compensação registrada.",
                        );
                        return;
                      }
                      if (!terminal) {
                        setNotice(
                          "A resposta não chegou de forma conclusiva. A próxima confirmação deste mesmo motivo reenvia a mesma chave.",
                        );
                      }
                      throw new Error(error.message);
                    }
                    const parsed = compensationResult.safeParse(
                      dropCompensationSecrets(raw),
                    );
                    if (!parsed.success) {
                      const recovered = await refreshSheet().catch(
                        () => undefined,
                      );
                      if (recovered?.compensation.state === "committed") {
                        intent.current = null;
                        setNotice(
                          "A resposta da tentativa não confere com o contrato. A leitura do lote mostra a compensação registrada.",
                        );
                        return;
                      }
                      setNotice(
                        "A resposta não confere com o contrato. Nenhuma contagem foi exibida. A próxima confirmação deste mesmo motivo reenvia a mesma chave.",
                      );
                      throw new Error(
                        "A resposta da compensação não confere com o contrato.",
                      );
                    }
                    intent.current = null;
                    setAttempt(parsed.data);
                    try {
                      await refreshSheet();
                    } catch {
                      setNotice(
                        "A compensação foi aceita, mas a atualização da ficha falhou. Tente atualizar a verificação.",
                      );
                    }
                  }}
                >
                  Compensar títulos do lote
                </ActionButton>
              </div>
            )}
            {kind !== "invoices" && (
              <p>A reversão deste tipo de lote não está disponível.</p>
            )}
            {kind === "invoices" &&
              data.compensation.state === "absent" &&
              data.batch.kind === "invoices" &&
              (!scope.tenantIntegral || !scope.importRun) && (
                <p>
                  A compensação exige a permissão de importação no escopo
                  integral do provedor, fora do suporte.
                </p>
              )}
          </div>
        )}
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
