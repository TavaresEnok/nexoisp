import { useState } from "react";
import useSWR from "swr";
import { useNavigate } from "react-router-dom";
import { z } from "zod";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FormField, MutationForm } from "@/features/shared/form";
import { QueryBoundary } from "@/features/shared/feedback";
import { useSession } from "@/features/session/provider";
import { can } from "@/features/session/model";
import { api } from "@/platform/erp-client";
import { money } from "@/lib/format";
import { decimalToCents } from "@/features/contracts/models";
import {
  itemCostsSchema,
  movementSchema,
  movementLabels,
  useStockRefresh,
  type StockItem,
} from "./models";

export function StockMovements({ item }: { item: StockItem }) {
  const { me } = useSession();
  const navigate = useNavigate();
  const refresh = useStockRefresh();
  const result = useSWR(["erp-stock-moves", item.id], async ([, id]) =>
    z.array(movementSchema).parse(await api(`/stock/items/${id}/movements`)),
  );
  const costs = useSWR(["erp-stock-costs", item.id], async ([, id]) =>
    itemCostsSchema.parse(await api(`/stock/items/${id}/costs`)),
  );
  const costById = new Map(
    (costs.data?.movements ?? []).map((row) => [String(row.id), row]),
  );
  const [form, setForm] = useState({ kind: "in", qty: "", note: "", cost: "" });
  const balances = useSWR(["erp-stock-balances", item.id], async ([, id]) =>
    z
      .array(
        z.object({
          warehouse_id: z.string().nullable(),
          name: z.string(),
          active: z.boolean(),
          balance: z.number(),
        }),
      )
      .parse(await api(`/stock/items/${id}/balances`)),
  );
  const [transfer, setTransfer] = useState({
    from: "",
    to: "",
    qty: "",
    note: "",
  });
  const places = balances.data ?? [];
  return (
    <div className="erp-stack">
      <QueryBoundary
        loading={balances.isLoading}
        error={balances.error}
        retry={() => balances.mutate()}
      >
        {places.length > 1 && (
          <Table>
            <TableHeader>
              <TableRow>
                {["Depósito", "Saldo"].map((label) => (
                  <TableHead key={label}>{label}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {places.map((place) => (
                <TableRow key={place.warehouse_id ?? "principal"}>
                  <TableCell>
                    {place.name}
                    {!place.active && " · inativo"}
                  </TableCell>
                  <TableCell>
                    {place.balance} {item.unit}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </QueryBoundary>
      {!item.serialized && places.length > 1 && can(me, "stock:write") && (
        <MutationForm
          submit="Transferir entre depósitos"
          onSubmit={async () => {
            await api(`/stock/items/${item.id}/transfer`, {
              body: {
                from_warehouse_id: transfer.from || null,
                to_warehouse_id: transfer.to || null,
                qty: Number(transfer.qty),
                note: transfer.note,
              },
            });
            setTransfer({ ...transfer, qty: "", note: "" });
            await Promise.all([refresh(), balances.mutate(), result.mutate()]);
          }}
        >
          <div className="erp-columns">
            {(["from", "to"] as const).map((key) => (
              <FormField
                key={key}
                label={
                  key === "from" ? "Depósito de origem" : "Depósito de destino"
                }
              >
                <select
                  className="commercial-select"
                  value={transfer[key]}
                  onChange={(event) =>
                    setTransfer({ ...transfer, [key]: event.target.value })
                  }
                >
                  {places
                    .filter((place) => key === "from" || place.active)
                    .map((place) => (
                      <option
                        key={place.warehouse_id ?? "principal"}
                        value={place.warehouse_id ?? ""}
                      >
                        {place.name}
                      </option>
                    ))}
                </select>
              </FormField>
            ))}
            <FormField label="Quantidade a transferir">
              <Input
                type="number"
                required
                min={1}
                max={1000000}
                step={1}
                value={transfer.qty}
                onChange={(event) =>
                  setTransfer({ ...transfer, qty: event.target.value })
                }
              />
            </FormField>
          </div>
        </MutationForm>
      )}
      {item.serialized ? (
        <p className="profile-footnote">
          As entradas, instalações e baixas deste item são registradas por
          unidade e número de série.
        </p>
      ) : (
        can(me, "stock:write") && (
          <MutationForm
            submit="Registrar movimento"
            onSubmit={async () => {
              await api(`/stock/items/${item.id}/movements`, {
                body: {
                  kind: form.kind,
                  qty: Number(form.qty),
                  note: form.note || null,
                  ...(form.kind === "in" && form.cost.trim()
                    ? { unit_cost_cents: decimalToCents(form.cost) }
                    : {}),
                },
              });
              setForm({ ...form, qty: "", note: "", cost: "" });
              await Promise.all([refresh(), costs.mutate()]);
            }}
          >
            <div className="erp-columns">
              <FormField label="Tipo de movimento">
                <select
                  className="commercial-select"
                  value={form.kind}
                  onChange={(event) =>
                    setForm({ ...form, kind: event.target.value })
                  }
                >
                  {Object.entries(movementLabels)
                    .filter(([value]) => value !== "transfer")
                    .map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                </select>
              </FormField>
              <FormField
                label="Quantidade do movimento"
                hint={
                  form.kind === "adjust"
                    ? "Diferença com sinal: negativa retira, positiva acrescenta. Vale para o depósito principal."
                    : "Quantidade positiva, no depósito principal."
                }
              >
                <Input
                  type="number"
                  required
                  step={1}
                  min={form.kind === "adjust" ? -1000000 : 1}
                  max={1000000}
                  value={form.qty}
                  onChange={(event) =>
                    setForm({ ...form, qty: event.target.value })
                  }
                />
              </FormField>
              {form.kind === "in" && (
                <FormField
                  label="Custo unitário da entrada (R$)"
                  hint="Opcional. Com custo, a entrada recalcula o custo médio; sem custo, entra pelo custo médio vigente."
                >
                  <Input
                    inputMode="decimal"
                    pattern="[0-9]+([,.][0-9]{1,2})?"
                    value={form.cost}
                    onChange={(event) =>
                      setForm({ ...form, cost: event.target.value })
                    }
                  />
                </FormField>
              )}
              <FormField
                label={
                  form.kind === "adjust"
                    ? "Justificativa do ajuste"
                    : "Observação do movimento"
                }
              >
                <Input
                  required={form.kind === "adjust"}
                  maxLength={300}
                  value={form.note}
                  onChange={(event) =>
                    setForm({ ...form, note: event.target.value })
                  }
                />
              </FormField>
            </div>
          </MutationForm>
        )
      )}
      {costs.data && (
        <p className="profile-footnote">
          Custo médio vigente {money(costs.data.avg_cost_cents / 100)} · valor
          em estoque {money(costs.data.value_cents / 100)}.
        </p>
      )}
      <p className="profile-footnote">
        Movimentos não são editados ou apagados. Corrija um lançamento com um
        novo ajuste. Até 200 movimentos mais recentes.
      </p>
      <QueryBoundary
        loading={result.isLoading}
        error={result.error}
        retry={() => result.mutate()}
      >
        {result.data?.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                {[
                  "Quando",
                  "Movimento",
                  "Quantidade",
                  "Custo unitário",
                  "Depósito",
                  "Observação / OS",
                  "Autor",
                ].map((label) => (
                  <TableHead key={label}>{label}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.data.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    {new Date(row.created_at).toLocaleString("pt-BR")}
                  </TableCell>
                  <TableCell>{movementLabels[row.kind] ?? row.kind}</TableCell>
                  <TableCell>
                    {row.qty > 0 ? "+" : ""}
                    {row.qty} {item.unit}
                  </TableCell>
                  <TableCell>
                    {costById.has(String(row.id)) ? (
                      <>
                        {money(
                          costById.get(String(row.id))!.unit_cost_cents / 100,
                        )}
                        <p className="profile-footnote">
                          {costById.get(String(row.id))!.cost_source === "entry"
                            ? "Custo da entrada"
                            : "Custo médio"}
                        </p>
                      </>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>
                    {row.warehouse_name ?? "Depósito principal"}
                  </TableCell>
                  <TableCell>
                    {row.note || "—"}
                    {row.work_order_id && can(me, "os:read") && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          navigate(
                            `/ordens-de-servico?ordem=${row.work_order_id}`,
                          )
                        }
                      >
                        Abrir OS {row.work_order_number}
                      </Button>
                    )}
                  </TableCell>
                  <TableCell>{row.created_by_name ?? "Sistema"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="profile-footnote">Nenhum movimento registrado.</p>
        )}
      </QueryBoundary>
    </div>
  );
}
