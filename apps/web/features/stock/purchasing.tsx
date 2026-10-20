import { useState } from "react";
import useSWR from "swr";
import { z } from "zod";
import { OperationalCatalog } from "@/components/operational-catalog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RecordEditor } from "@/features/shared/record-editor";
import { FormField, MutationForm } from "@/features/shared/form";
import { QueryBoundary } from "@/features/shared/feedback";
import { ActionButton } from "@/features/shared/action";
import { formatDocument } from "@/features/shared/format";
import { cents } from "@/features/shared/schema";
import { useSession } from "@/features/session/provider";
import { can } from "@/features/session/model";
import { money } from "@/lib/format";
import { api } from "@/platform/erp-client";
import {
  stockItemSchema,
  useStockRefresh,
  warehouseSchema,
  type Warehouse,
} from "./models";

const supplierSchema = z.object({
  id: z.string(),
  name: z.string(),
  document: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  notes: z.string(),
  active: z.boolean(),
  purchases: z.number(),
});
type Supplier = z.infer<typeof supplierSchema>;
const purchaseSchema = z.object({
  id: z.string(),
  number: z.number(),
  status: z.enum(["draft", "ordered", "received", "canceled"]),
  supplier_name: z.string(),
  warehouse_name: z.string(),
  expected_at: z.string().nullable(),
  note: z.string(),
  created_at: z.string(),
  received_at: z.string().nullable(),
  total_cents: cents(),
  items: z.array(
    z.object({
      item_id: z.string(),
      item_name: z.string(),
      unit: z.string(),
      qty: z.number(),
      unit_cost_cents: cents(),
    }),
  ),
});
const statusLabels: Record<z.infer<typeof purchaseSchema>["status"], string> = {
  draft: "Rascunho",
  ordered: "Enviado ao fornecedor",
  received: "Recebido",
  canceled: "Cancelado",
};
const day = (value: string | null) =>
  value
    ? new Date(`${value.slice(0, 10)}T12:00:00`).toLocaleDateString("pt-BR")
    : "—";
export const useWarehouses = () =>
  useSWR("erp-stock-warehouses", async () =>
    z.array(warehouseSchema).parse(await api("/stock/warehouses")),
  );

export function StockWarehouses() {
  const { me } = useSession();
  const write = can(me, "stock:write");
  const list = useWarehouses();
  const [editing, setEditing] = useState<Warehouse | "new" | null>(null);
  return (
    <QueryBoundary
      loading={list.isLoading}
      error={list.error}
      retry={() => list.mutate()}
    >
      <OperationalCatalog
        title="Depósitos"
        description="Locais de guarda além do depósito principal. Movimentos manuais e de OS usam o depósito principal; transfira pelo item."
        columns={["Depósito", "Endereço", "Situação"]}
        actions={
          write && (
            <Button onClick={() => setEditing("new")}>Novo depósito</Button>
          )
        }
        rows={(list.data ?? []).map((item) => ({
          id: item.id,
          cells: [
            item.name,
            item.address || "—",
            item.active ? "Ativo" : "Inativo",
          ],
          actions: write && (
            <div className="erp-inline-actions">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setEditing(item)}
              >
                Editar depósito
              </Button>
              <ActionButton
                onClick={async () => {
                  await api(`/stock/warehouses/${item.id}`, {
                    method: "PATCH",
                    body: { active: !item.active },
                  });
                  await list.mutate();
                }}
              >
                {item.active ? "Desativar" : "Reativar"} {item.name}
              </ActionButton>
            </div>
          ),
        }))}
        empty="Nenhum depósito além do principal."
      />
      {editing && (
        <RecordEditor
          title={editing === "new" ? "Novo depósito" : "Editar depósito"}
          description="O saldo de cada item é mantido por depósito."
          initial={{
            name: editing === "new" ? "" : editing.name,
            address: editing === "new" ? "" : editing.address,
          }}
          fields={[
            {
              key: "name",
              label: "Nome do depósito",
              required: true,
              maxLength: 80,
            },
            { key: "address", label: "Endereço do depósito", maxLength: 200 },
          ]}
          submit={editing === "new" ? "Cadastrar depósito" : "Salvar depósito"}
          onClose={() => setEditing(null)}
          onSubmit={async (values) => {
            await api(
              editing === "new"
                ? "/stock/warehouses"
                : `/stock/warehouses/${editing.id}`,
              { method: editing === "new" ? "POST" : "PATCH", body: values },
            );
            setEditing(null);
            await list.mutate();
          }}
        />
      )}
    </QueryBoundary>
  );
}

export function StockSuppliers() {
  const { me } = useSession();
  const write = can(me, "stock:write");
  const list = useSWR("erp-stock-suppliers", async () =>
    z.array(supplierSchema).parse(await api("/stock/suppliers")),
  );
  const [editing, setEditing] = useState<Supplier | "new" | null>(null);
  return (
    <QueryBoundary
      loading={list.isLoading}
      error={list.error}
      retry={() => list.mutate()}
    >
      <OperationalCatalog
        title="Fornecedores"
        description="Empresas das quais o provedor compra materiais e equipamentos."
        columns={["Fornecedor", "CPF/CNPJ", "Contato", "Compras", "Situação"]}
        actions={
          write && (
            <Button onClick={() => setEditing("new")}>Novo fornecedor</Button>
          )
        }
        rows={(list.data ?? []).map((item) => ({
          id: item.id,
          cells: [
            item.name,
            item.document ? formatDocument(item.document) : "—",
            [item.email, item.phone].filter(Boolean).join(" · ") || "—",
            item.purchases,
            item.active ? "Ativo" : "Inativo",
          ],
          actions: write && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditing(item)}
            >
              Editar fornecedor
            </Button>
          ),
        }))}
        empty="Nenhum fornecedor cadastrado."
      />
      {editing && (
        <RecordEditor
          title={editing === "new" ? "Novo fornecedor" : "Editar fornecedor"}
          description="Dados de contato usados nos pedidos de compra."
          initial={{
            name: editing === "new" ? "" : editing.name,
            document: editing === "new" ? "" : (editing.document ?? ""),
            email: editing === "new" ? "" : (editing.email ?? ""),
            phone: editing === "new" ? "" : (editing.phone ?? ""),
            notes: editing === "new" ? "" : editing.notes,
            active: editing === "new" || editing.active ? "yes" : "no",
          }}
          fields={[
            {
              key: "name",
              label: "Nome do fornecedor",
              required: true,
              maxLength: 120,
            },
            {
              key: "document",
              label: "CPF ou CNPJ (somente números)",
              maxLength: 14,
            },
            {
              key: "email",
              label: "E-mail do fornecedor",
              type: "email",
              maxLength: 120,
            },
            { key: "phone", label: "Telefone do fornecedor", maxLength: 30 },
            {
              key: "notes",
              label: "Observações",
              type: "textarea",
              maxLength: 1000,
            },
            ...(editing === "new"
              ? []
              : [
                  {
                    key: "active",
                    label: "Situação",
                    type: "select" as const,
                    options: [
                      { value: "yes", label: "Ativo" },
                      { value: "no", label: "Inativo" },
                    ],
                  },
                ]),
          ]}
          submit={
            editing === "new" ? "Cadastrar fornecedor" : "Salvar fornecedor"
          }
          onClose={() => setEditing(null)}
          onSubmit={async (values) => {
            const body = {
              name: values.name,
              document: values.document.replace(/\D/g, "") || null,
              email: values.email || null,
              phone: values.phone || null,
              notes: values.notes,
              ...(editing === "new" ? {} : { active: values.active === "yes" }),
            };
            await api(
              editing === "new"
                ? "/stock/suppliers"
                : `/stock/suppliers/${editing.id}`,
              { method: editing === "new" ? "POST" : "PATCH", body },
            );
            setEditing(null);
            await list.mutate();
          }}
        />
      )}
    </QueryBoundary>
  );
}

export function StockPurchases() {
  const { me } = useSession();
  const write = can(me, "stock:write");
  const refresh = useStockRefresh();
  const list = useSWR("erp-stock-purchases", async () =>
    z.array(purchaseSchema).parse(await api("/stock/purchases")),
  );
  const [creating, setCreating] = useState(false);
  const act = async (id: string, action: string, body?: unknown) => {
    await api(`/stock/purchases/${id}/${action}`, { method: "POST", body });
    await Promise.all([list.mutate(), refresh()]);
  };
  return (
    <QueryBoundary
      loading={list.isLoading}
      error={list.error}
      retry={() => list.mutate()}
    >
      <OperationalCatalog
        title="Pedidos de compra"
        description="Ao receber o pedido, as quantidades entram no depósito escolhido. Itens por número de série entram pelas unidades."
        columns={[
          "Pedido",
          "Fornecedor",
          "Depósito",
          "Itens",
          "Total",
          "Previsão",
          "Situação",
        ]}
        actions={
          write && (
            <Button onClick={() => setCreating(true)}>
              Novo pedido de compra
            </Button>
          )
        }
        rows={(list.data ?? []).map((order) => ({
          id: order.id,
          cells: [
            `#${order.number}`,
            order.supplier_name,
            order.warehouse_name,
            order.items
              .map((line) => `${line.qty} ${line.unit} ${line.item_name}`)
              .join(" · "),
            money(order.total_cents / 100),
            day(order.expected_at),
            order.status === "received"
              ? `Recebido em ${day(order.received_at)}`
              : statusLabels[order.status],
          ],
          actions: write &&
            (order.status === "draft" || order.status === "ordered") && (
              <div className="erp-inline-actions">
                {order.status === "draft" && (
                  <ActionButton
                    onClick={() =>
                      act(order.id, "status", { status: "ordered" })
                    }
                  >
                    Marcar #{order.number} como enviado
                  </ActionButton>
                )}
                <ActionButton
                  confirm={`Receber o pedido #${order.number}? As quantidades entram em ${order.warehouse_name}.`}
                  onClick={() => act(order.id, "receive")}
                >
                  Receber pedido #{order.number}
                </ActionButton>
                <ActionButton
                  confirm={`Cancelar o pedido #${order.number}?`}
                  onClick={() =>
                    act(order.id, "status", { status: "canceled" })
                  }
                >
                  Cancelar pedido #{order.number}
                </ActionButton>
              </div>
            ),
        }))}
        empty="Nenhum pedido de compra registrado."
      />
      {creating && (
        <PurchaseEditor
          onClose={() => setCreating(false)}
          onDone={async () => {
            setCreating(false);
            await list.mutate();
          }}
        />
      )}
    </QueryBoundary>
  );
}

function PurchaseEditor({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const suppliers = useSWR("erp-stock-suppliers", async () =>
    z.array(supplierSchema).parse(await api("/stock/suppliers")),
  );
  const warehouses = useWarehouses();
  const items = useSWR("erp-stock-items", async () =>
    z.array(stockItemSchema).parse(await api("/stock/items")),
  );
  const [form, setForm] = useState({
    supplier_id: "",
    warehouse_id: "",
    expected_at: "",
    note: "",
  });
  const [lines, setLines] = useState([{ item_id: "", qty: "1", cost: "" }]);
  const available = (items.data ?? []).filter(
    (item) => item.active && !item.serialized,
  );
  const setLine = (
    index: number,
    key: "item_id" | "qty" | "cost",
    value: string,
  ) =>
    setLines((current) =>
      current.map((line, position) =>
        position === index ? { ...line, [key]: value } : line,
      ),
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
          <DialogTitle>Novo pedido de compra</DialogTitle>
          <DialogDescription>
            O pedido começa como rascunho. Ao ser recebido, gera as entradas no
            depósito escolhido.
          </DialogDescription>
        </DialogHeader>
        <QueryBoundary
          loading={
            suppliers.isLoading || warehouses.isLoading || items.isLoading
          }
          error={suppliers.error ?? warehouses.error ?? items.error}
        >
          <MutationForm
            submit="Registrar pedido"
            onCancel={onClose}
            onSubmit={async () => {
              await api("/stock/purchases", {
                body: {
                  supplier_id: form.supplier_id,
                  warehouse_id: form.warehouse_id || null,
                  expected_at: form.expected_at || null,
                  note: form.note,
                  items: lines.map((line) => ({
                    item_id: line.item_id,
                    qty: Number(line.qty),
                    unit_cost_cents: Math.round(
                      Number(line.cost.replace(",", ".")) * 100,
                    ),
                  })),
                },
              });
              await onDone();
            }}
          >
            <div className="erp-columns">
              <FormField label="Fornecedor do pedido">
                <select
                  required
                  className="commercial-select"
                  value={form.supplier_id}
                  onChange={(event) =>
                    setForm({ ...form, supplier_id: event.target.value })
                  }
                >
                  <option value="">Selecione</option>
                  {(suppliers.data ?? [])
                    .filter((item) => item.active)
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                </select>
              </FormField>
              <FormField label="Depósito de entrada">
                <select
                  className="commercial-select"
                  value={form.warehouse_id}
                  onChange={(event) =>
                    setForm({ ...form, warehouse_id: event.target.value })
                  }
                >
                  <option value="">Depósito principal</option>
                  {(warehouses.data ?? [])
                    .filter((item) => item.active)
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                </select>
              </FormField>
              <FormField label="Previsão de entrega">
                <Input
                  type="date"
                  value={form.expected_at}
                  onChange={(event) =>
                    setForm({ ...form, expected_at: event.target.value })
                  }
                />
              </FormField>
            </div>
            {lines.map((line, index) => (
              <div className="erp-columns" key={index}>
                <FormField label={`Item ${index + 1} do pedido`}>
                  <select
                    required
                    className="commercial-select"
                    value={line.item_id}
                    onChange={(event) =>
                      setLine(index, "item_id", event.target.value)
                    }
                  >
                    <option value="">Selecione</option>
                    {available.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </FormField>
                <FormField label={`Quantidade do item ${index + 1}`}>
                  <Input
                    type="number"
                    required
                    min={1}
                    max={1000000}
                    step={1}
                    value={line.qty}
                    onChange={(event) =>
                      setLine(index, "qty", event.target.value)
                    }
                  />
                </FormField>
                <FormField label={`Custo unitário do item ${index + 1} (R$)`}>
                  <Input
                    required
                    inputMode="decimal"
                    pattern="[0-9]+([,.][0-9]{1,2})?"
                    value={line.cost}
                    onChange={(event) =>
                      setLine(index, "cost", event.target.value)
                    }
                  />
                </FormField>
              </div>
            ))}
            <div className="erp-inline-actions">
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  setLines([...lines, { item_id: "", qty: "1", cost: "" }])
                }
              >
                Adicionar item
              </Button>
              {lines.length > 1 && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setLines(lines.slice(0, -1))}
                >
                  Remover último item
                </Button>
              )}
            </div>
            <FormField label="Observação do pedido">
              <Input
                maxLength={500}
                value={form.note}
                onChange={(event) =>
                  setForm({ ...form, note: event.target.value })
                }
              />
            </FormField>
          </MutationForm>
        </QueryBoundary>
      </DialogContent>
    </Dialog>
  );
}
