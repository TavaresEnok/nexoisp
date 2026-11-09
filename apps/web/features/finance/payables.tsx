import { useState } from "react";
import useSWR from "swr";
import { z } from "zod";
import { PageHeading, Panel } from "@/components/workspace-ui";
import { OperationalCatalog } from "@/components/operational-catalog";
import { FinancialTotals } from "@/components/subscriber-profile-sections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { RecordEditor } from "@/features/shared/record-editor";
import { QueryBoundary, ConnectedNotice } from "@/features/shared/feedback";
import { FormField } from "@/features/shared/form";
import { cents } from "@/features/shared/schema";
import { decimalToCents } from "@/features/contracts/models";
import { useSession } from "@/features/session/provider";
import { can } from "@/features/session/model";
import { money } from "@/lib/format";
import { api } from "@/platform/erp-client";

const payableSchema = z.object({
  id: z.string().uuid(),
  number: z.number(),
  supplier_id: z.string().nullable(),
  supplier_name: z.string().nullable(),
  purchase_order_number: z.number().nullable(),
  description: z.string(),
  installment: z.number(),
  installments: z.number(),
  amount_cents: cents(),
  due_date: z.string(),
  status: z.enum(["open", "paid", "canceled"]),
  paid_on: z.string().nullable(),
  paid_method: z.string().nullable(),
  cancel_reason: z.string().nullable(),
  overdue: z.boolean(),
});
type Payable = z.infer<typeof payableSchema>;
const listSchema = z.object({
  items: z.array(payableSchema),
  truncated: z.boolean(),
  today: z.string(),
  totals: z.object({
    open_cents: cents(),
    open_count: z.number(),
    overdue_cents: cents(),
    overdue_count: z.number(),
    paid_cents: cents(),
    paid_count: z.number(),
    canceled_cents: cents(),
    canceled_count: z.number(),
  }),
  suppliers: z.array(
    z.object({ id: z.string(), name: z.string(), active: z.boolean() }),
  ),
});
export const payableMethods: Record<string, string> = {
  pix: "Pix",
  boleto: "Boleto",
  transfer: "Transferência",
  cash: "Dinheiro",
  card: "Cartão",
  other: "Outra forma",
};
const statusLabels: Record<string, string> = {
  all: "Todas as situações",
  open: "Em aberto",
  overdue: "Vencidos",
  paid: "Pagos",
  canceled: "Cancelados",
};
const day = (value: string | null) =>
  value
    ? new Date(`${value.slice(0, 10)}T12:00:00`).toLocaleDateString("pt-BR")
    : "—";
const emptyFilters = {
  status: "open",
  supplier_id: "",
  due_from: "",
  due_to: "",
};

export function Payables() {
  const { me } = useSession();
  const write = can(me, "finance:write");
  const [draft, setDraft] = useState(emptyFilters);
  const [filters, setFilters] = useState(emptyFilters);
  const query = new URLSearchParams(
    Object.entries(filters).filter(([, value]) => value),
  ).toString();
  const list = useSWR(["erp-finance-payables", query], async ([, search]) =>
    listSchema.parse(
      await api(`/finance/payables${search ? `?${search}` : ""}`),
    ),
  );
  const [creating, setCreating] = useState(false);
  const [paying, setPaying] = useState<Payable | null>(null);
  const [canceling, setCanceling] = useState<Payable | null>(null);
  const totals = list.data?.totals;
  return (
    <>
      <PageHeading
        title="Contas a pagar"
        description="Títulos de fornecedores gerados no recebimento das compras do estoque ou lançados manualmente."
        actions={
          write && (
            <Button onClick={() => setCreating(true)}>
              Novo título a pagar
            </Button>
          )
        }
      />
      <ConnectedNotice demo={me?.demo} />
      <Panel
        title="Filtrar títulos"
        description="Totais calculados pelo servidor para todos os títulos do filtro."
      >
        <form
          className="erp-inline-actions"
          onSubmit={(event) => {
            event.preventDefault();
            setFilters(draft);
          }}
        >
          <FormField label="Situação dos títulos">
            <select
              className="commercial-select"
              value={draft.status}
              onChange={(event) =>
                setDraft({ ...draft, status: event.target.value })
              }
            >
              {Object.entries(statusLabels).map(([value, label]) => (
                <option key={value} value={value === "all" ? "" : value}>
                  {label}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Fornecedor dos títulos">
            <select
              className="commercial-select"
              value={draft.supplier_id}
              onChange={(event) =>
                setDraft({ ...draft, supplier_id: event.target.value })
              }
            >
              <option value="">Todos os fornecedores</option>
              {(list.data?.suppliers ?? []).map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name}
                  {supplier.active ? "" : " (inativo)"}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Vencimento desde">
            <Input
              type="date"
              value={draft.due_from}
              onChange={(event) =>
                setDraft({ ...draft, due_from: event.target.value })
              }
            />
          </FormField>
          <FormField label="Vencimento até">
            <Input
              type="date"
              min={draft.due_from || undefined}
              value={draft.due_to}
              onChange={(event) =>
                setDraft({ ...draft, due_to: event.target.value })
              }
            />
          </FormField>
          <Button type="submit" variant="outline">
            Aplicar filtros
          </Button>
        </form>
      </Panel>
      <QueryBoundary
        loading={list.isLoading}
        error={list.error}
        retry={() => list.mutate()}
      >
        {totals && (
          <FinancialTotals
            items={[
              [
                "Em aberto",
                money(totals.open_cents / 100),
                `${totals.open_count} título(s)`,
              ],
              [
                "Vencidos",
                money(totals.overdue_cents / 100),
                `${totals.overdue_count} título(s)`,
              ],
              [
                "Pagos",
                money(totals.paid_cents / 100),
                `${totals.paid_count} título(s)`,
              ],
              [
                "Cancelados",
                money(totals.canceled_cents / 100),
                `${totals.canceled_count} título(s)`,
              ],
            ]}
          />
        )}
        <OperationalCatalog
          title="Títulos a pagar"
          description={
            list.data?.truncated
              ? "Os 200 primeiros títulos por vencimento; refine os filtros para ver os demais."
              : "Ordenados por vencimento. Título pago ou cancelado não é alterado."
          }
          columns={[
            "Título",
            "Fornecedor",
            "Descrição",
            "Vencimento",
            "Valor",
            "Situação",
          ]}
          rows={(list.data?.items ?? []).map((item) => ({
            id: item.id,
            cells: [
              `Nº ${item.number}`,
              item.supplier_name ?? "Sem fornecedor",
              <>
                {item.description}
                {item.purchase_order_number !== null && (
                  <p className="profile-footnote">
                    Pedido de compra #{item.purchase_order_number}
                  </p>
                )}
              </>,
              day(item.due_date),
              money(item.amount_cents / 100),
              item.status === "paid" ? (
                <>
                  <Badge variant="outline">Pago</Badge>
                  <p className="profile-footnote">
                    {day(item.paid_on)} ·{" "}
                    {payableMethods[item.paid_method ?? ""] ?? item.paid_method}
                  </p>
                </>
              ) : item.status === "canceled" ? (
                <>
                  <Badge variant="secondary">Cancelado</Badge>
                  <p className="profile-footnote">{item.cancel_reason}</p>
                </>
              ) : (
                <Badge variant={item.overdue ? "warning" : "outline"}>
                  {item.overdue ? "Vencido" : "Em aberto"}
                </Badge>
              ),
            ],
            actions: write && item.status === "open" && (
              <div className="erp-inline-actions">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPaying(item)}
                >
                  Baixar título {item.number}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCanceling(item)}
                >
                  Cancelar título {item.number}
                </Button>
              </div>
            ),
          }))}
          empty="Nenhum título a pagar neste filtro."
        />
      </QueryBoundary>
      {creating && (
        <RecordEditor
          title="Novo título a pagar"
          description="Lançamento manual. Com mais de uma parcela, o valor é dividido em centavos e os vencimentos seguem mês a mês."
          initial={{
            supplier_id: "",
            description: "",
            amount: "",
            due_date: list.data?.today ?? "",
            installments: "1",
          }}
          fields={[
            {
              key: "supplier_id",
              label: "Fornecedor do título",
              type: "select",
              options: [
                { value: "", label: "Sem fornecedor" },
                ...(list.data?.suppliers ?? [])
                  .filter((supplier) => supplier.active)
                  .map((supplier) => ({
                    value: supplier.id,
                    label: supplier.name,
                  })),
              ],
            },
            {
              key: "description",
              label: "Descrição do título",
              required: true,
              maxLength: 160,
            },
            { key: "amount", label: "Valor total (R$)", required: true },
            {
              key: "due_date",
              label: "Vencimento da primeira parcela",
              type: "date",
              required: true,
            },
            {
              key: "installments",
              label: "Número de parcelas",
              type: "number",
              required: true,
              min: 1,
              max: 24,
            },
          ]}
          submit="Lançar título"
          onClose={() => setCreating(false)}
          onSubmit={async (values) => {
            await api("/finance/payables", {
              body: {
                supplier_id: values.supplier_id || null,
                description: values.description,
                amount_cents: decimalToCents(values.amount),
                due_date: values.due_date,
                installments: Number(values.installments),
              },
            });
            setCreating(false);
            await list.mutate();
          }}
        />
      )}
      {paying && (
        <RecordEditor
          title={`Baixar título ${paying.number}`}
          description={`${paying.description} · ${money(paying.amount_cents / 100)}. A baixa não pode ser desfeita.`}
          initial={{
            paid_on: list.data?.today ?? "",
            method: "pix",
            note: "",
          }}
          fields={[
            {
              key: "paid_on",
              label: "Data do pagamento",
              type: "date",
              required: true,
            },
            {
              key: "method",
              label: "Forma de pagamento",
              type: "select",
              options: Object.entries(payableMethods).map(([value, label]) => ({
                value,
                label,
              })),
            },
            { key: "note", label: "Observação da baixa", maxLength: 300 },
          ]}
          submit="Confirmar baixa"
          onClose={() => setPaying(null)}
          onSubmit={async (values) => {
            await api(`/finance/payables/${paying.id}/pay`, { body: values });
            setPaying(null);
            await list.mutate();
          }}
        />
      )}
      {canceling && (
        <RecordEditor
          title={`Cancelar título ${canceling.number}`}
          description={`${canceling.description} · ${money(canceling.amount_cents / 100)}. O título cancelado permanece no histórico.`}
          initial={{ reason: "" }}
          fields={[
            {
              key: "reason",
              label: "Motivo do cancelamento",
              type: "textarea",
              required: true,
              maxLength: 300,
            },
          ]}
          submit="Confirmar cancelamento"
          onClose={() => setCanceling(null)}
          onSubmit={async (values) => {
            await api(`/finance/payables/${canceling.id}/cancel`, {
              body: values,
            });
            setCanceling(null);
            await list.mutate();
          }}
        />
      )}
    </>
  );
}
