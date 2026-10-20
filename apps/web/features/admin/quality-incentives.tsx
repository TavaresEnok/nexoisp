import { useState } from "react";
import useSWR from "swr";
import { z } from "zod";
import { OperationalCatalog } from "@/components/operational-catalog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { RecordEditor } from "@/features/shared/record-editor";
import { QueryBoundary } from "@/features/shared/feedback";
import { ActionButton } from "@/features/shared/action";
import { MutationForm, FormField } from "@/features/shared/form";
import { decimalToCents } from "@/features/contracts/models";
import { money } from "@/lib/format";
import { api } from "@/platform/erp-client";
import { workKinds } from "./quality-sla";
import { cents } from "@/features/shared/schema";
const kit = z.object({
  id: z.string(),
  name: z.string(),
  active: z.boolean(),
  items: z.array(
    z.object({ name: z.string(), unit: z.string(), qty: z.coerce.number() }),
  ),
});
const stock = z.object({
  id: z.string(),
  name: z.string(),
  active: z.boolean(),
  serialized: z.boolean(),
});
export function InstallKits() {
  const result = useSWR("erp-install-kits", async () =>
    z.array(kit).parse(await api("/install-kits")),
  );
  const [creating, setCreating] = useState(false);
  const items = useSWR(creating ? "erp-kit-stock" : null, async () =>
    z.array(stock).parse(await api("/stock/items")),
  );
  const [name, setName] = useState("");
  const [rows, setRows] = useState([{ item_id: "", qty: "1", key: 0 }]);
  return (
    <QueryBoundary
      loading={result.isLoading}
      error={result.error}
      retry={() => result.mutate()}
    >
      <OperationalCatalog
        title="Kits de instalação"
        description="Conjuntos de materiais sem número de série para uso nas ordens de serviço. Criar o kit não movimenta o estoque."
        columns={["Kit", "Materiais", "Situação"]}
        actions={
          <Button
            onClick={() => {
              setName("");
              setRows([{ item_id: "", qty: "1", key: 0 }]);
              setCreating(true);
            }}
          >
            Novo kit de instalação
          </Button>
        }
        rows={(result.data ?? []).map((item) => ({
          id: item.id,
          cells: [
            item.name,
            item.items
              .map(
                (material) =>
                  `${material.qty} ${material.unit} ${material.name}`,
              )
              .join(" · "),
            item.active ? "Ativo" : "Inativo",
          ],
          actions: (
            <ActionButton
              onClick={async () => {
                await api(`/install-kits/${item.id}`, {
                  method: "PATCH",
                  body: { active: !item.active },
                });
                await result.mutate();
              }}
            >
              {item.active ? "Desativar kit" : "Ativar kit"}
            </ActionButton>
          ),
        }))}
      />
      {creating && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setCreating(false);
          }}
        >
          <DialogContent className="erp-editor">
            <DialogHeader>
              <DialogTitle>Novo kit de instalação</DialogTitle>
              <DialogDescription>
                De um a trinta materiais ativos, sem controle por número de
                série. Itens repetidos são recusados pelo servidor.
              </DialogDescription>
            </DialogHeader>
            <QueryBoundary
              loading={items.isLoading}
              error={items.error}
              retry={() => items.mutate()}
            >
              <MutationForm
                submit="Criar kit"
                onCancel={() => setCreating(false)}
                onSubmit={async () => {
                  await api("/install-kits", {
                    body: {
                      name,
                      items: rows.map((row) => ({
                        item_id: row.item_id,
                        qty: Number(row.qty),
                      })),
                    },
                  });
                  setCreating(false);
                  await result.mutate();
                }}
              >
                <FormField label="Nome do kit">
                  <Input
                    value={name}
                    required
                    minLength={2}
                    maxLength={60}
                    onChange={(event) => setName(event.target.value)}
                  />
                </FormField>
                {rows.map((row, index) => (
                  <div className="erp-columns" key={row.key}>
                    <FormField label={`Material ${index + 1}`}>
                      <select
                        className="commercial-select"
                        required
                        value={row.item_id}
                        onChange={(event) =>
                          setRows((previous) =>
                            previous.map((item) =>
                              item.key === row.key
                                ? { ...item, item_id: event.target.value }
                                : item,
                            ),
                          )
                        }
                      >
                        <option value="">Selecione o material</option>
                        {(items.data ?? [])
                          .filter((item) => item.active && !item.serialized)
                          .map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.name}
                            </option>
                          ))}
                      </select>
                    </FormField>
                    <FormField label={`Quantidade ${index + 1}`}>
                      <Input
                        type="number"
                        required
                        min={1}
                        max={10000}
                        value={row.qty}
                        onChange={(event) =>
                          setRows((previous) =>
                            previous.map((item) =>
                              item.key === row.key
                                ? { ...item, qty: event.target.value }
                                : item,
                            ),
                          )
                        }
                      />
                    </FormField>
                    {rows.length > 1 && (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() =>
                          setRows((previous) =>
                            previous.filter((item) => item.key !== row.key),
                          )
                        }
                      >
                        Remover material {index + 1}
                      </Button>
                    )}
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  disabled={rows.length >= 30}
                  onClick={() =>
                    setRows((previous) => [
                      ...previous,
                      {
                        item_id: "",
                        qty: "1",
                        key: Math.max(...previous.map((item) => item.key)) + 1,
                      },
                    ])
                  }
                >
                  Adicionar material ao kit
                </Button>
              </MutationForm>
            </QueryBoundary>
          </DialogContent>
        </Dialog>
      )}
    </QueryBoundary>
  );
}
const rule = z.object({
  id: z.string(),
  subject: z.enum(["work_order", "sale"]),
  os_kind: z.string().nullable(),
  assignee_cents: cents(),
  helper_cents: cents(),
});
const report = z.object({
  rows: z.array(
    z.object({
      user_id: z.string(),
      name: z.string(),
      os_assignee: z.coerce.number(),
      os_helper: z.coerce.number(),
      sales: z.coerce.number(),
      total_cents: cents(),
    }),
  ),
  total_cents: cents(),
  note: z.string(),
});
export function Commissions() {
  const result = useSWR("erp-commission-rules", async () =>
    z.array(rule).parse(await api("/commission-rules")),
  );
  const [range, setRange] = useState(() => {
    const today = new Date();
    return {
      from: `${today.toISOString().slice(0, 7)}-01`,
      to: today.toISOString().slice(0, 10),
    };
  });
  const [draft, setDraft] = useState(range);
  const rep = useSWR(
    ["erp-commission-report", range.from, range.to],
    async () =>
      report.parse(
        await api(`/reports/commissions?${new URLSearchParams(range)}`),
      ),
  );
  const [creating, setCreating] = useState(false);
  return (
    <div className="erp-stack">
      <QueryBoundary
        loading={result.isLoading}
        error={result.error}
        retry={() => result.mutate()}
      >
        <OperationalCatalog
          title="Regras de comissão"
          description="Uma nova regra substitui a vigente do mesmo tipo. O servidor apura OS concluídas e prospectos ganhos; a apuração não executa pagamentos."
          columns={["Abrangência", "Responsável ou vendedor", "Cada auxiliar"]}
          actions={
            <Button onClick={() => setCreating(true)}>
              Nova regra de comissão
            </Button>
          }
          rows={(result.data ?? []).map((item) => ({
            id: item.id,
            cells: [
              item.subject === "sale"
                ? "Prospecto ganho"
                : `OS · ${item.os_kind ? workKinds[item.os_kind] : "Todas as naturezas"}`,
              money(item.assignee_cents / 100),
              item.subject === "work_order"
                ? money(item.helper_cents / 100)
                : "Não se aplica",
            ],
          }))}
        />
      </QueryBoundary>
      <form
        className="erp-inline-actions"
        onSubmit={(event) => {
          event.preventDefault();
          setRange(draft);
        }}
      >
        <FormField label="Comissões desde">
          <Input
            type="date"
            required
            value={draft.from}
            onChange={(event) =>
              setDraft({ ...draft, from: event.target.value })
            }
          />
        </FormField>
        <FormField label="Comissões até">
          <Input
            type="date"
            required
            min={draft.from}
            value={draft.to}
            onChange={(event) => setDraft({ ...draft, to: event.target.value })}
          />
        </FormField>
        <Button type="submit" variant="outline">
          Consultar comissões
        </Button>
      </form>
      <QueryBoundary
        loading={rep.isLoading}
        error={rep.error}
        retry={() => rep.mutate()}
      >
        <OperationalCatalog
          title="Apuração de comissões"
          description={
            rep.data
              ? `Total ${money(rep.data.total_cents / 100)}. ${rep.data.note}`
              : "Apuração dos registros existentes no período selecionado."
          }
          columns={[
            "Pessoa",
            "OS como responsável",
            "OS como auxiliar",
            "Vendas",
            "Total",
          ]}
          rows={(rep.data?.rows ?? []).map((item) => ({
            id: item.user_id,
            cells: [
              item.name,
              item.os_assignee,
              item.os_helper,
              item.sales,
              money(item.total_cents / 100),
            ],
          }))}
        />
      </QueryBoundary>
      {creating && (
        <RecordEditor
          title="Nova regra de comissão"
          description="Ao salvar, a regra vigente da mesma natureza será substituída."
          initial={{
            subject: "work_order",
            os_kind: "",
            assignee: "",
            helper: "0",
          }}
          fields={[
            {
              key: "subject",
              label: "Comissão para",
              type: "select",
              options: [
                { value: "work_order", label: "OS concluída" },
                { value: "sale", label: "Prospecto ganho" },
              ],
            },
            {
              key: "os_kind",
              label: "Natureza da OS comissionada",
              type: "select",
              when: (values) => values.subject === "work_order",
              options: [
                { value: "", label: "Todas" },
                ...Object.entries(workKinds).map(([value, label]) => ({
                  value,
                  label,
                })),
              ],
            },
            {
              key: "assignee",
              label: "Responsável ou vendedor (R$)",
              required: true,
            },
            {
              key: "helper",
              label: "Cada auxiliar (R$)",
              required: true,
              when: (values) => values.subject === "work_order",
            },
          ]}
          onClose={() => setCreating(false)}
          onSubmit={async (values) => {
            await api("/commission-rules", {
              body: {
                subject: values.subject,
                os_kind:
                  values.subject === "work_order"
                    ? values.os_kind || null
                    : null,
                assignee_cents: decimalToCents(values.assignee),
                helper_cents:
                  values.subject === "work_order"
                    ? decimalToCents(values.helper)
                    : 0,
              },
            });
            setCreating(false);
            await Promise.all([result.mutate(), rep.mutate()]);
          }}
        />
      )}
    </div>
  );
}
