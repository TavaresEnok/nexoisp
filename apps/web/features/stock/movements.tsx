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
import {
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
  const [form, setForm] = useState({ kind: "in", qty: "", note: "" });
  return (
    <div className="erp-stack">
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
                },
              });
              setForm({ ...form, qty: "", note: "" });
              await refresh();
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
                  {Object.entries(movementLabels).map(([value, label]) => (
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
                    ? "Diferença com sinal: negativa retira, positiva acrescenta."
                    : "Quantidade positiva."
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
