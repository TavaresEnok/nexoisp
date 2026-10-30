import { useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { z } from "zod";
import { Panel } from "@/components/workspace-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { FormField, MutationForm } from "@/features/shared/form";
import { QueryBoundary } from "@/features/shared/feedback";
import { ActionButton } from "@/features/shared/action";
import { useSession } from "@/features/session/provider";
import { can } from "@/features/session/model";
import { api } from "@/platform/erp-client";
import { ApiError } from "@/data/erp/http";
import { money } from "@/lib/format";
import { stockItemSchema, warehouseSchema } from "./models";
import {
  integerInput,
  priceInput,
  quotationsApi,
  type Quotation,
} from "./quotation-models";

const supplierSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  active: z.boolean(),
});
const labels = {
  draft: "Rascunho",
  converted: "Convertida",
  canceled: "Cancelada",
};
const currency = (cents: number) => money(cents / 100);

export function StockQuotations({ onPurchases }: { onPurchases: () => void }) {
  const { me } = useSession();
  const write = can(me, "stock:write");
  const list = useSWR("erp-stock-quotations", quotationsApi.list);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  return (
    <Panel
      title="Cotações"
      description="Compare ofertas de fornecedores e escolha uma para gerar um pedido em rascunho."
      action={
        write && (
          <Button
            onClick={() => {
              setCreating(true);
              setSelected(null);
            }}
          >
            Nova cotação
          </Button>
        )
      }
    >
      <QueryBoundary
        loading={list.isLoading}
        error={list.error}
        retry={() => list.mutate()}
      >
        {list.data?.truncated && (
          <p role="status">
            São exibidas as 100 cotações mais recentes; existem outras cotações.
          </p>
        )}
        {list.data?.items.length ? (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Cotação</TableHead>
                  <TableHead>Situação</TableHead>
                  <TableHead>Ofertas</TableHead>
                  <TableHead>Criada em</TableHead>
                  <TableHead>Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.data.items.map((q) => (
                  <TableRow key={q.id}>
                    <TableCell>{q.title}</TableCell>
                    <TableCell>{labels[q.status]}</TableCell>
                    <TableCell>{q.offers_count}</TableCell>
                    <TableCell>
                      {new Date(q.created_at).toLocaleDateString("pt-BR")}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setSelected(q.id);
                          setCreating(false);
                        }}
                      >
                        Detalhar
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <p>Nenhuma cotação registrada.</p>
        )}
      </QueryBoundary>
      {creating && (
        <CreateQuotation
          onCancel={() => setCreating(false)}
          onDone={async (q) => {
            setCreating(false);
            setSelected(q.id);
            await list.mutate();
          }}
        />
      )}
      {selected && (
        <QuotationDetail
          key={selected}
          id={selected}
          write={write}
          onPurchases={onPurchases}
          refreshList={() => list.mutate()}
        />
      )}
    </Panel>
  );
}

function CreateQuotation({
  onCancel,
  onDone,
}: {
  onCancel: () => void;
  onDone: (q: Quotation) => Promise<void>;
}) {
  const items = useSWR("erp-stock-items", async () =>
    z.array(stockItemSchema).parse(await api("/stock/items")),
  );
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState([{ item_id: "", qty: "1" }]);
  return (
    <section className="mt-6">
      <h3>Nova cotação</h3>
      <QueryBoundary
        loading={items.isLoading}
        error={items.error}
        retry={() => items.mutate()}
      >
        <MutationForm
          submit="Criar cotação"
          onCancel={onCancel}
          onSubmit={async () => {
            if (title.trim().length < 3)
              throw new Error("O título deve ter pelo menos 3 caracteres.");
            if (
              new Set(lines.map((l) => l.item_id)).size !== lines.length ||
              lines.some((l) => !l.item_id)
            )
              throw new Error("Selecione itens distintos.");
            await onDone(
              await quotationsApi.create({
                title: title.trim(),
                note,
                items: lines.map((l) => ({
                  item_id: l.item_id,
                  qty: integerInput(l.qty, 1, 1000000),
                })),
              }),
            );
          }}
        >
          <FormField label="Título">
            <Input
              required
              minLength={3}
              maxLength={120}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </FormField>
          <FormField label="Observação">
            <Input
              maxLength={500}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </FormField>
          {lines.map((line, index) => (
            <div className="erp-columns" key={index}>
              <FormField label={`Item ${index + 1}`}>
                <select
                  className="commercial-select"
                  required
                  value={line.item_id}
                  onChange={(e) =>
                    setLines(
                      lines.map((l, i) =>
                        i === index ? { ...l, item_id: e.target.value } : l,
                      ),
                    )
                  }
                >
                  <option value="">Selecione</option>
                  {items.data
                    ?.filter((i) => i.active)
                    .map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.name}
                      </option>
                    ))}
                </select>
              </FormField>
              <FormField label={`Quantidade ${index + 1}`}>
                <Input
                  required
                  type="number"
                  min={1}
                  max={1000000}
                  step={1}
                  value={line.qty}
                  onChange={(e) =>
                    setLines(
                      lines.map((l, i) =>
                        i === index ? { ...l, qty: e.target.value } : l,
                      ),
                    )
                  }
                />
              </FormField>
              {lines.length > 1 && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setLines(lines.filter((_, i) => i !== index))}
                >
                  Remover item {index + 1}
                </Button>
              )}
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            disabled={lines.length >= 30}
            onClick={() => setLines([...lines, { item_id: "", qty: "1" }])}
          >
            Adicionar item
          </Button>
        </MutationForm>
      </QueryBoundary>
    </section>
  );
}

function QuotationDetail({
  id,
  write,
  onPurchases,
  refreshList,
}: {
  id: string;
  write: boolean;
  onPurchases: () => void;
  refreshList: () => Promise<unknown>;
}) {
  const detail = useSWR(["erp-stock-quotation", id], () =>
    quotationsApi.detail(id),
  );
  const { mutate } = useSWRConfig();
  const [adding, setAdding] = useState(false);
  const [reason, setReason] = useState("");
  const [offer, setOffer] = useState("");
  const [warehouse, setWarehouse] = useState("");
  const [date, setDate] = useState("");
  const [intent, setIntent] = useState<{
    offer_id: string;
    warehouse_id: string | null;
    expected_at: string | null;
  } | null>(null);
  const [purchase, setPurchase] = useState<number | null>(null);
  const warehouses = useSWR(write ? "erp-stock-warehouses" : null, async () =>
    z.array(warehouseSchema).parse(await api("/stock/warehouses")),
  );
  const refresh = async () => {
    await Promise.all([detail.mutate(), refreshList()]);
  };
  return (
    <section className="mt-6">
      <QueryBoundary
        loading={detail.isLoading}
        error={detail.error}
        retry={() => detail.mutate()}
      >
        {detail.data &&
          (() => {
            const q = detail.data;
            const editable = write && q.status === "draft";
            return (
              <>
                <h3>
                  {q.title} · {labels[q.status]}
                </h3>
                <p>{q.note}</p>
                <p>
                  {q.items
                    .map((i) => `${i.qty} ${i.unit} ${i.item_name}`)
                    .join(" · ")}
                </p>
                {q.offers.length ? (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Item</TableHead>
                          {q.offers.map((o) => (
                            <TableHead key={o.id}>
                              {o.supplier_name}
                              <br />
                              {o.note}
                            </TableHead>
                          ))}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {q.items.map((i) => (
                          <TableRow key={i.item_id}>
                            <TableCell>
                              {i.item_name} ({i.qty} {i.unit})
                            </TableCell>
                            {q.offers.map((o) => (
                              <TableCell key={o.id}>
                                {currency(
                                  o.prices.find((p) => p.item_id === i.item_id)!
                                    .unit_cost_cents,
                                )}{" "}
                                / {i.unit}
                              </TableCell>
                            ))}
                          </TableRow>
                        ))}
                        <TableRow>
                          <TableCell>
                            <strong>Total</strong>
                          </TableCell>
                          {q.offers.map((o) => (
                            <TableCell key={o.id}>
                              <strong>{currency(o.total_cents)}</strong>
                              {editable && !intent && (
                                <div>
                                  <ActionButton
                                    confirm={`Remover oferta de ${o.supplier_name}?`}
                                    onClick={async () => {
                                      await quotationsApi.removeOffer(id, o.id);
                                      await refresh();
                                    }}
                                  >
                                    Remover oferta
                                  </ActionButton>
                                </div>
                              )}
                            </TableCell>
                          ))}
                        </TableRow>
                      </TableBody>
                    </Table>
                  </div>
                ) : (
                  <p>Nenhuma oferta cadastrada.</p>
                )}
                {editable && !intent && (
                  <>
                    <Button
                      variant="outline"
                      disabled={q.offers.length >= 10}
                      onClick={() => setAdding(!adding)}
                    >
                      Cadastrar oferta
                    </Button>
                    {adding && (
                      <OfferForm
                        quote={q}
                        onCancel={() => setAdding(false)}
                        onDone={async () => {
                          setAdding(false);
                          await refresh();
                        }}
                      />
                    )}
                    <MutationForm
                      submit="Cancelar cotação"
                      onSubmit={async () => {
                        if (reason.trim().length < 5)
                          throw new Error(
                            "Informe uma razão com pelo menos 5 caracteres.",
                          );
                        await quotationsApi.cancel(id, reason.trim());
                        await refresh();
                      }}
                    >
                      <FormField label="Razão do cancelamento">
                        <Input
                          required
                          minLength={5}
                          maxLength={300}
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                        />
                      </FormField>
                    </MutationForm>
                  </>
                )}
                {editable && q.offers.length > 0 && (
                  <QueryBoundary
                    loading={warehouses.isLoading}
                    error={warehouses.error}
                    retry={() => warehouses.mutate()}
                  >
                    <MutationForm
                      submit={
                        intent
                          ? "Repetir solicitação do pedido"
                          : "Gerar pedido em rascunho"
                      }
                      onSubmit={async () => {
                        const choice = intent ?? {
                          offer_id: offer,
                          warehouse_id: warehouse || null,
                          expected_at: date || null,
                        };
                        if (!choice.offer_id)
                          throw new Error("Selecione uma oferta.");
                        setIntent(choice);
                        let result: Awaited<
                          ReturnType<typeof quotationsApi.purchase>
                        >;
                        try {
                          result = await quotationsApi.purchase(id, choice);
                        } catch (error) {
                          if (
                            error instanceof ApiError &&
                            [400, 401, 403, 404, 422].includes(error.status)
                          ) {
                            setIntent(null);
                            await Promise.allSettled([
                              warehouses.mutate(),
                              detail.mutate(),
                            ]);
                          } else if (
                            error instanceof ApiError &&
                            error.status === 409
                          ) {
                            // Só libera uma nova escolha após reconciliar o estado com o servidor.
                            try {
                              await detail.mutate();
                              setIntent(null);
                              await refreshList();
                            } catch {
                              /* mantenha o payload até reconciliar */
                            }
                          }
                          throw error;
                        }
                        setPurchase(result.number);
                        await Promise.all([
                          refresh(),
                          mutate("erp-stock-purchases"),
                          mutate("erp-stock-items"),
                          mutate("erp-stock-warehouses"),
                        ]);
                      }}
                    >
                      <p>
                        Escolha manualmente a oferta. A criação do rascunho não
                        realiza pagamento nem entrada de estoque.
                      </p>
                      {intent && (
                        <p role="status">
                          Solicitação enviada. Se a resposta falhar, repita com
                          os mesmos dados para consultar o resultado sem criar
                          outro pedido.
                        </p>
                      )}
                      <FormField label="Oferta escolhida">
                        <select
                          className="commercial-select"
                          required
                          disabled={!!intent}
                          value={offer}
                          onChange={(e) => setOffer(e.target.value)}
                        >
                          <option value="">Selecione</option>
                          {q.offers.map((o) => (
                            <option value={o.id} key={o.id}>
                              {o.supplier_name} · {currency(o.total_cents)}
                            </option>
                          ))}
                        </select>
                      </FormField>
                      <FormField label="Depósito">
                        <select
                          className="commercial-select"
                          disabled={!!intent}
                          value={warehouse}
                          onChange={(e) => setWarehouse(e.target.value)}
                        >
                          <option value="">Depósito principal</option>
                          {warehouses.data
                            ?.filter((w) => w.active)
                            .map((w) => (
                              <option key={w.id} value={w.id}>
                                {w.name}
                              </option>
                            ))}
                        </select>
                      </FormField>
                      <FormField label="Previsão de entrega">
                        <Input
                          type="date"
                          disabled={!!intent}
                          value={date}
                          onChange={(e) => setDate(e.target.value)}
                        />
                      </FormField>
                    </MutationForm>
                  </QueryBoundary>
                )}
                {(purchase !== null || q.purchase_order_id) && (
                  <p>
                    Pedido de compra {purchase !== null ? `#${purchase} ` : ""}
                    vinculado.{" "}
                    <Button variant="outline" onClick={onPurchases}>
                      Abrir Compras
                    </Button>
                  </p>
                )}
              </>
            );
          })()}
      </QueryBoundary>
    </section>
  );
}

function OfferForm({
  quote,
  onCancel,
  onDone,
}: {
  quote: Quotation;
  onCancel: () => void;
  onDone: () => Promise<void>;
}) {
  const suppliers = useSWR("erp-stock-quotation-suppliers", async () =>
    z.array(supplierSchema).parse(await api("/stock/suppliers")),
  );
  const [supplier, setSupplier] = useState("");
  const [note, setNote] = useState("");
  const [prices, setPrices] = useState<Record<string, string>>({});
  return (
    <QueryBoundary
      loading={suppliers.isLoading}
      error={suppliers.error}
      retry={() => suppliers.mutate()}
    >
      <MutationForm
        submit="Cadastrar oferta"
        onCancel={onCancel}
        onSubmit={async () => {
          await quotationsApi.offer(quote.id, {
            supplier_id: supplier,
            note,
            prices: quote.items.map((i) => ({
              item_id: i.item_id,
              unit_cost_cents: priceInput(prices[i.item_id] ?? ""),
            })),
          });
          await onDone();
        }}
      >
        <FormField label="Fornecedor">
          <select
            required
            className="commercial-select"
            value={supplier}
            onChange={(e) => setSupplier(e.target.value)}
          >
            <option value="">Selecione</option>
            {suppliers.data
              ?.filter((s) => s.active)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
        </FormField>
        <FormField label="Observação da oferta">
          <Input
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </FormField>
        {quote.items.map((i) => (
          <FormField
            key={i.item_id}
            label={`Preço unitário de ${i.item_name} (R$)`}
          >
            <Input
              required
              inputMode="decimal"
              pattern="[0-9]+([,.][0-9]{1,2})?"
              value={prices[i.item_id] ?? ""}
              onChange={(e) =>
                setPrices({ ...prices, [i.item_id]: e.target.value })
              }
            />
          </FormField>
        ))}
      </MutationForm>
    </QueryBoundary>
  );
}
