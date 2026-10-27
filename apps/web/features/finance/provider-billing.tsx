import { useCallback, useEffect, useState } from "react";
import useSWR from "swr";
import {
  ProfileFacts,
  ProfileSection,
} from "@/components/subscriber-profile-sections";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { useSession } from "@/features/session/provider";
import { can } from "@/features/session/model";
import { ActionButton } from "@/features/shared/action";
import { QueryBoundary } from "@/features/shared/feedback";
import {
  RecordEditor,
  type EditorValues,
} from "@/features/shared/record-editor";
import { api } from "@/platform/erp-client";
import { date, money } from "@/lib/format";
import type { InvoiceDetail } from "./models";
import {
  issueFields,
  issuanceBody,
  operationFields,
  operationBody,
} from "./provider-billing-forms";
import {
  providerBillingSchema,
  productLabels,
  billingStateLabels,
  providerIntentKey,
  readProviderIntent,
  sendProviderIntent,
  providerIntentTerminal,
  type ProviderIntent,
  type ProviderBillingData,
} from "./provider-billing-model";

function useBillingIntent(
  key: string,
  invoice: string,
  data?: ProviderBillingData,
) {
  const [pending, setPending] = useState<ProviderIntent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    try {
      setPending(readProviderIntent(localStorage, key, invoice));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [key, invoice]);
  useEffect(() => {
    reload();
    const changed = (event: StorageEvent) => {
      if (event.key === key || event.key === null) reload();
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [key, reload]);
  useEffect(() => {
    if (
      !data ||
      !pending ||
      !providerIntentTerminal(pending, data) ||
      !navigator.locks
    )
      return;
    void navigator.locks.request(key, () => {
      try {
        const current = readProviderIntent(localStorage, key, invoice);
        if (current && providerIntentTerminal(current, data))
          localStorage.removeItem(key);
        reload();
      } catch (e) {
        setError((e as Error).message);
      }
    });
  }, [data, pending, key, invoice, reload]);
  return { pending, error, reload };
}

export function ProviderBilling({
  invoice,
  refresh,
}: {
  invoice: InvoiceDetail;
  refresh: () => Promise<void>;
}) {
  const { me } = useSession();
  const query = useSWR(
    ["erp-provider-billing", invoice.id],
    async ([, id]) =>
      providerBillingSchema.parse(
        await api(`/invoices/${id}/provider-billing`),
      ),
    { refreshInterval: 15000 },
  );
  const data = query.data;
  const issueKey = providerIntentKey(
    me?.tenant?.id ?? "",
    me?.id ?? "",
    invoice.id,
    false,
  );
  const operationKey = providerIntentKey(
    me?.tenant?.id ?? "",
    me?.id ?? "",
    invoice.id,
    true,
  );
  const issue = useBillingIntent(issueKey, invoice.id, data);
  const operation = useBillingIntent(operationKey, invoice.id, data);
  const [action, setAction] = useState<"issue" | "cancel" | "refund" | null>(
    null,
  );
  const [retry, setRetry] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const writable = can(me, "finance:write");
  const issuance = data?.issuances[0];
  const reload = async () => {
    await refresh();
  };
  const enqueue = async (candidate: ProviderIntent) => {
    if (!navigator.locks)
      throw new Error(
        "Use um navegador atualizado para proteger a intenção entre abas.",
      );
    const key = candidate.kind === "issue" ? issueKey : operationKey;
    try {
      await navigator.locks.request(key, () =>
        sendProviderIntent(localStorage, key, candidate, (path, body) =>
          api(path, { body }),
        ),
      );
      setError(null);
      setAction(null);
      await reload();
    } catch (e) {
      setError((e as Error).message);
      setAction(null);
      throw e;
    } finally {
      issue.reload();
      operation.reload();
    }
  };
  const submit = async (values: EditorValues) => {
    if (!data || !action) return;
    const refund = action === "refund";
    if (action !== "issue" && !issuance)
      throw new Error("Consulte a cobrança antes de preparar uma operação.");
    await enqueue({
      intent_id: crypto.randomUUID(),
      invoice_id: invoice.id,
      kind: action,
      connection_id:
        action === "issue"
          ? values.choice.split(":")[0]
          : issuance!.financial_connection_id,
      ...(action === "issue" ? {} : { issuance_id: issuance!.id }),
      body:
        action === "issue"
          ? issuanceBody(invoice.id, values, data)
          : operationBody(values, refund, data),
    });
  };
  const storageError = issue.error ?? operation.error;
  return (
    <ProfileSection
      title="Cobrança no provedor"
      caption="Operação Efí em sandbox. Preparar uma intenção não confirma emissão, cancelamento ou devolução."
    >
      <QueryBoundary
        loading={query.isLoading}
        error={query.error}
        retry={() => query.mutate()}
      >
        {data && (
          <div className="erp-stack">
            <Badge variant="warning">Sandbox · sem homologação bancária</Badge>
            {!data.sandbox_enabled && (
              <p role="status">
                Operações sandbox desabilitadas no servidor. O histórico
                permanece disponível.
              </p>
            )}
            {data.sandbox_enabled &&
              (!data.dispatch_enabled || !data.operations_write_enabled) && (
                <p role="status">
                  Envios de emissão ou operações desabilitados. Intenções
                  preparadas aguardam processamento; nenhum resultado bancário é
                  presumido.
                </p>
              )}
            {(error || storageError) && (
              <Alert variant="destructive" role="alert">
                <AlertDescription>{storageError ?? error}</AlertDescription>
              </Alert>
            )}
            <div className="erp-inline-actions">
              <ActionButton onClick={reload}>Atualizar cobrança</ActionButton>
            </div>
            {issuance ? (
              <>
                <ProfileFacts
                  items={[
                    [
                      "Conta",
                      `${issuance.account_name} · ${({ active: "Ativa", disabled: "Desabilitada", pending: "Pendente" } as Record<string, string>)[issuance.account_status] ?? issuance.account_status}`,
                    ],
                    ["Produto", productLabels[issuance.product]],
                    ["Estado da emissão", billingStateLabels[issuance.state]],
                    [
                      "Identificador no provedor",
                      issuance.charge_id ?? "Ainda não confirmado",
                    ],
                    [
                      "Última consulta de recebimento",
                      issuance.receipt_checked_at
                        ? date(issuance.receipt_checked_at)
                        : "Não realizada",
                    ],
                    ["Intenção", issuance.intent_id],
                  ]}
                />
                {(issuance.last_error || issuance.receipt_last_error) && (
                  <p role="status">
                    Pendência de processamento:{" "}
                    {issuance.last_error ?? issuance.receipt_last_error}.
                    Confira a revisão antes de repetir qualquer ação.
                  </p>
                )}
                {issuance.receipt_review && (
                  <p role="status">
                    Recebimento em revisão. Reagendar consulta não resolve a
                    conciliação nem autoriza nova cobrança.
                  </p>
                )}
                {writable &&
                  (["uncertain", "review"].includes(issuance.state) ||
                    issuance.receipt_review) && (
                    <Button
                      variant="outline"
                      onClick={() =>
                        setRetry(
                          `/financial-connections/${issuance.financial_connection_id}/issuance/${issuance.id}/retry-lookup`,
                        )
                      }
                    >
                      Reagendar consulta da cobrança
                    </Button>
                  )}
              </>
            ) : (
              <p className="profile-footnote">
                Nenhuma intenção de emissão registrada para esta fatura.
              </p>
            )}
            {[issue.pending, operation.pending]
              .filter((p): p is ProviderIntent => Boolean(p))
              .map((pending) => {
                const known =
                  pending.kind === "issue"
                    ? data.issuances.some(
                        (j) =>
                          j.intent_id === pending.intent_id &&
                          j.financial_connection_id === pending.connection_id,
                      )
                    : data.operations.some(
                        (o) =>
                          o.intent_id === pending.intent_id &&
                          o.issuance_id === pending.issuance_id,
                      );
                return (
                  <div
                    key={pending.intent_id}
                    className="erp-stack"
                    role="status"
                  >
                    <p>
                      Intenção preservada:{" "}
                      {pending.kind === "issue"
                        ? "emissão"
                        : pending.kind === "refund"
                          ? "devolução"
                          : "cancelamento"}{" "}
                      · {pending.intent_id}.{" "}
                      {known
                        ? "Preparação registrada. Acompanhe o resultado abaixo."
                        : "Resposta não confirmada. Recuperar mantém a mesma intenção e os dados originais."}
                    </p>
                    {writable && !storageError && !known && (
                      <ActionButton onClick={() => enqueue(pending)}>
                        Recuperar intenção pendente
                      </ActionButton>
                    )}
                  </div>
                );
              })}
            {data.operations.map((op) => (
              <div key={op.id} className="erp-stack">
                <ProfileFacts
                  items={[
                    [
                      "Operação",
                      op.kind === "refund"
                        ? "Devolução Pix"
                        : "Remoção da cobrança no provedor",
                    ],
                    ["Estado", billingStateLabels[op.state]],
                    [
                      "Valor",
                      op.amount_cents == null
                        ? "Não se aplica"
                        : money(op.amount_cents / 100),
                    ],
                    ["Motivo", op.reason],
                    ["Intenção", op.intent_id],
                  ]}
                />
                {op.last_error && (
                  <p role="status">Pendência: {op.last_error}</p>
                )}
                {op.kind === "cancel" && op.state === "confirmed" && (
                  <p role="status">
                    Remoção confirmada no provedor. A obrigação no ERP e a
                    possibilidade de liquidação tardia permanecem em revisão.
                  </p>
                )}
                {writable &&
                  issuance &&
                  ["uncertain", "review"].includes(op.state) && (
                    <Button
                      variant="outline"
                      onClick={() =>
                        setRetry(
                          `/financial-connections/${issuance.financial_connection_id}/issuance/${op.issuance_id}/operations/${op.id}/retry-lookup`,
                        )
                      }
                    >
                      Reagendar consulta da operação
                    </Button>
                  )}
              </div>
            ))}
            {writable && data.sandbox_enabled && !storageError && (
              <div className="erp-inline-actions">
                {!issuance &&
                  !issue.pending &&
                  !invoice.gateway_charge_id &&
                  invoice.status === "open" &&
                  (data.accounts.length ? (
                    <Button onClick={() => setAction("issue")}>
                      Preparar emissão Efí
                    </Button>
                  ) : (
                    <p role="status">
                      Nenhuma conta Efí sandbox ativa e compatível com a empresa
                      desta fatura. Solicite o cadastro ao administrador.
                    </p>
                  ))}
                {issuance?.state === "issued" && !operation.pending && (
                  <>
                    {!invoice.payments.length &&
                      !data.operations.some((o) => o.kind === "cancel") && (
                        <Button
                          variant="outline"
                          onClick={() => setAction("cancel")}
                        >
                          Remover cobrança no provedor
                        </Button>
                      )}
                    {issuance.product !== "bolix" &&
                      data.refund_payments.some(
                        (p) => p.refundable_cents > 0,
                      ) && (
                        <Button
                          variant="outline"
                          onClick={() => setAction("refund")}
                        >
                          Preparar devolução Pix
                        </Button>
                      )}
                  </>
                )}
              </div>
            )}
            {action && (
              <RecordEditor
                title={
                  action === "issue"
                    ? "Preparar emissão Efí"
                    : action === "refund"
                      ? "Preparar devolução Pix"
                      : "Remover cobrança no provedor"
                }
                description={
                  action === "issue"
                    ? "Valor nominal e vencimento vêm da fatura. Os dados ficam vinculados à intenção. Envio bancário depende dos consumidores habilitados no servidor."
                    : action === "refund"
                      ? "O limite desconta devoluções confirmadas e intenções reservadas. A devolução só altera o caixa após confirmação bancária."
                      : "Esta ação remove a cobrança no PSP; não quita nem cancela automaticamente a obrigação no ERP. Uma liquidação tardia continuará sendo recebida em revisão."
                }
                initial={
                  action === "issue"
                    ? {
                        choice: data.accounts[0]
                          ? `${data.accounts[0].id}:${data.accounts[0].products[0]}`
                          : "",
                        expiration: "3600",
                        valid_days: "30",
                        name: invoice.subscriber_name,
                        document: "",
                        street: "",
                        city: "",
                        state: "",
                        zip: "",
                        email: "",
                        number: "",
                        neighborhood: "",
                      }
                    : {
                        reason: "",
                        amount: "",
                        payment:
                          data.refund_payments.find(
                            (p) => p.refundable_cents > 0,
                          )?.id ?? "",
                      }
                }
                fields={
                  action === "issue"
                    ? issueFields(data)
                    : operationFields(data, action === "refund")
                }
                submit="Registrar intenção"
                onClose={() => setAction(null)}
                onSubmit={submit}
              />
            )}
            {retry && (
              <RecordEditor
                title="Reagendar consulta"
                description="Somente consulta o resultado existente. Não reenvia a mutação nem libera valores reservados."
                initial={{ reason: "" }}
                fields={[
                  {
                    key: "reason",
                    label: "Justificativa (10 a 500 caracteres)",
                    type: "textarea",
                    required: true,
                    maxLength: 500,
                  },
                ]}
                onClose={() => setRetry(null)}
                submit="Reagendar consulta"
                onSubmit={async (values) => {
                  await api(retry, { body: values });
                  setRetry(null);
                  await reload();
                }}
              />
            )}
          </div>
        )}
      </QueryBoundary>
    </ProfileSection>
  );
}
