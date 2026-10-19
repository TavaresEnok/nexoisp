import { useState } from "react";
import useSWR from "swr";
import { useNavigate, useSearchParams } from "react-router-dom";
import { PageHeading, Panel, Status } from "@/components/workspace-ui";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableHeader,
  TableHead,
  TableRow,
  TableCell,
  TableBody,
} from "@/components/ui/table";
import { ActionButton } from "@/features/shared/action";
import { QueryBoundary, ConnectedNotice } from "@/features/shared/feedback";
import { useSession } from "@/features/session/provider";
import { can } from "@/features/session/model";
import { api } from "@/platform/erp-client";
import { date, money } from "@/lib/format";
import { invoiceStatus, type ErpInvoice, type GatewayEvent } from "./models";
import { OperationalInvoice } from "./invoice";
export function FinanceReconciliation() {
  const { me } = useSession();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [result, setResult] = useState<{
    checked: number;
    recovered: number;
    divergent: number;
    unavailable: number;
  } | null>(null);
  const list = useSWR("erp-finance-reconciliation", () =>
    api<{ invoices: ErpInvoice[]; events: GatewayEvent[] }>(
      "/finance/reconciliation",
    ),
  );
  const openInvoice = (id: string) => {
    const next = new URLSearchParams(params);
    next.set("fatura", id);
    setParams(next);
  };
  return (
    <>
      <PageHeading
        title="Conciliação"
        description="Revise cobranças e eventos recebidos antes de confirmar um pagamento."
        actions={
          can(me, "finance:write") && (
            <ActionButton
              onClick={async () => {
                setResult(await api("/finance/reconcile", { method: "POST" }));
                await list.mutate();
              }}
            >
              Consultar gateway agora
            </ActionButton>
          )
        }
      />
      <ConnectedNotice demo={me?.demo} />
      {result && (
        <p role="status">
          {result.checked} cobrança(s) consultada(s); {result.recovered}{" "}
          pagamento(s) recuperado(s); {result.divergent} divergência(s);{" "}
          {result.unavailable} sem gateway disponível.
        </p>
      )}
      <QueryBoundary
        loading={list.isLoading}
        error={list.error}
        retry={() => list.mutate()}
      >
        <div className="erp-stack">
          <Panel title="Faturas que exigem decisão">
            {list.data?.invoices.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Assinante</TableHead>
                    <TableHead>Referência</TableHead>
                    <TableHead>Vencimento</TableHead>
                    <TableHead>Situação</TableHead>
                    <TableHead>Valor</TableHead>
                    <TableHead>Ação</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.data.invoices.map((invoice) => (
                    <TableRow key={invoice.id}>
                      <TableCell>
                        <button
                          className="profile-text-action"
                          onClick={() =>
                            navigate(
                              `/assinantes?ficha=${invoice.subscriber_id}`,
                            )
                          }
                        >
                          {invoice.subscriber_name}
                        </button>
                      </TableCell>
                      <TableCell>{invoice.competence ?? "Avulsa"}</TableCell>
                      <TableCell>{date(invoice.due_date)}</TableCell>
                      <TableCell>
                        <Status value={invoiceStatus(invoice)} />
                      </TableCell>
                      <TableCell>{money(invoice.amount_cents / 100)}</TableCell>
                      <TableCell>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => openInvoice(invoice.id)}
                        >
                          Abrir fatura
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="profile-footnote">
                Nenhuma fatura aguarda decisão.
              </p>
            )}
          </Panel>
          <Panel title="Eventos recebidos do gateway">
            {list.data?.events.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Recebido</TableHead>
                    <TableHead>Tipo</TableHead>
                    <TableHead>Assinante</TableHead>
                    <TableHead>Situação</TableHead>
                    <TableHead>Observação</TableHead>
                    <TableHead>Ação</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.data.events.map((event) => (
                    <TableRow key={event.id}>
                      <TableCell>{date(event.received_at)}</TableCell>
                      <TableCell>{event.type}</TableCell>
                      <TableCell>{event.subscriber_name || "—"}</TableCell>
                      <TableCell>
                        {(
                          {
                            processed: "Processado",
                            ignored: "Ignorado",
                            pending: "Pendente",
                            failed: "Falhou",
                          } as Record<string, string>
                        )[event.status] ?? event.status}
                      </TableCell>
                      <TableCell>{event.note}</TableCell>
                      <TableCell>
                        {event.invoice_id && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => openInvoice(event.invoice_id!)}
                          >
                            Abrir fatura
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="profile-footnote">Nenhum evento recebido.</p>
            )}
          </Panel>
        </div>
      </QueryBoundary>
      {params.get("fatura") && (
        <OperationalInvoice
          key={params.get("fatura")}
          id={params.get("fatura")!}
          onClose={() => {
            const next = new URLSearchParams(params);
            next.delete("fatura");
            setParams(next, { replace: true });
            void list.mutate();
          }}
        />
      )}
    </>
  );
}
