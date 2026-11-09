import { useState } from "react";
import useSWR from "swr";
import { z } from "zod";
import { OperationalCatalog } from "@/components/operational-catalog";
import { FinancialTotals } from "@/components/subscriber-profile-sections";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { RecordEditor } from "@/features/shared/record-editor";
import { QueryBoundary } from "@/features/shared/feedback";
import { ActionButton } from "@/features/shared/action";
import { cents } from "@/features/shared/schema";
import { useSession } from "@/features/session/provider";
import { can } from "@/features/session/model";
import { money } from "@/lib/format";
import { api, download } from "@/platform/erp-client";
import { workKinds } from "./quality-sla";

const status = z.enum(["open", "closed", "paid", "reversed"]);
const summary = z.object({
  id: z.string().uuid(),
  number: z.number(),
  period_from: z.string(),
  period_to: z.string(),
  competence: z.string().nullable(),
  user_id: z.string().nullable(),
  user_name: z.string().nullable(),
  status,
  note: z.string(),
  paid_on: z.string().nullable(),
  paid_method: z.string().nullable(),
  paid_note: z.string(),
  reversal_reason: z.string().nullable(),
  lines_count: z.number(),
  total_cents: cents(),
});
type Settlement = z.infer<typeof summary>;
const detail = summary.extend({
  lines: z.array(
    z.object({
      id: z.string().uuid(),
      user_name: z.string(),
      source_kind: z.enum(["work_order", "sale"]),
      role: z.enum(["assignee", "helper", "sale"]),
      source_label: z.string(),
      occurred_at: z.string(),
      os_kind: z.string().nullable(),
      rule_id: z.string().nullable(),
      rule_os_kind: z.string().nullable(),
      amount_cents: cents(),
    }),
  ),
  people: z.array(
    z.object({
      user_id: z.string(),
      name: z.string(),
      lines: z.number(),
      total_cents: cents(),
    }),
  ),
});
type Detail = z.infer<typeof detail>;
const labels: Record<Settlement["status"], string> = {
  open: "Aberta",
  closed: "Fechada",
  paid: "Paga",
  reversed: "Estornada",
};
const methods: Record<string, string> = {
  pix: "Pix",
  transfer: "Transferência",
  cash: "Dinheiro",
  payroll: "Folha de pagamento",
  other: "Outra forma",
};
const roles: Record<string, string> = {
  assignee: "OS como responsável",
  helper: "OS como auxiliar",
  sale: "Venda",
};
const day = (value: string | null) =>
  value
    ? new Date(`${value.slice(0, 10)}T12:00:00`).toLocaleDateString("pt-BR")
    : "—";
const period = (item: Settlement) =>
  item.competence
    ? `Competência ${item.competence.slice(5)}/${item.competence.slice(0, 4)}`
    : `${day(item.period_from)} a ${day(item.period_to)}`;
const today = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

/** Liquidações de comissão: congelam a apuração do período e seguem aberta → fechada → paga, com estorno. */
export function CommissionSettlements({
  people,
  onChange,
}: {
  people: { user_id: string; name: string }[];
  onChange: () => Promise<unknown>;
}) {
  const { me } = useSession();
  const write = can(me, "finance:write");
  const list = useSWR("erp-commission-settlements", async () =>
    z
      .object({ items: z.array(summary), truncated: z.boolean() })
      .parse(await api("/commission-settlements")),
  );
  const [creating, setCreating] = useState(false);
  const [opened, setOpened] = useState<string | null>(null);
  const refresh = async () => {
    await Promise.all([list.mutate(), onChange()]);
  };
  const exportCsv = (item: { id: string; number: number }) =>
    download(
      `/commission-settlements/${item.id}/export.csv`,
      `liquidacao-comissoes-${item.number}.csv`,
    );
  return (
    <QueryBoundary
      loading={list.isLoading}
      error={list.error}
      retry={() => list.mutate()}
    >
      <OperationalCatalog
        title="Liquidações de comissão"
        description="A liquidação congela origem, regra e valor de cada comissão do período; um mesmo registro não entra em duas liquidações. Fechada, não muda mais; o estorno preserva o histórico."
        columns={[
          "Liquidação",
          "Período",
          "Pessoa",
          "Linhas",
          "Total",
          "Situação",
        ]}
        actions={
          write && (
            <Button onClick={() => setCreating(true)}>
              Nova liquidação de comissão
            </Button>
          )
        }
        rows={(list.data?.items ?? []).map((item) => ({
          id: item.id,
          cells: [
            `Nº ${item.number}`,
            period(item),
            item.user_name ?? "Todas as pessoas",
            item.lines_count,
            money(item.total_cents / 100),
            <>
              <Badge
                variant={item.status === "reversed" ? "secondary" : "outline"}
              >
                {labels[item.status]}
              </Badge>
              {item.status === "paid" && (
                <p className="profile-footnote">
                  {day(item.paid_on)} · {methods[item.paid_method ?? ""]}
                </p>
              )}
            </>,
          ],
          actions: (
            <div className="erp-inline-actions">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setOpened(item.id)}
              >
                Revisar liquidação {item.number}
              </Button>
              <ActionButton onClick={() => exportCsv(item)}>
                Exportar liquidação {item.number} em CSV
              </ActionButton>
            </div>
          ),
        }))}
        empty="Nenhuma liquidação de comissão registrada."
      />
      {creating && (
        <RecordEditor
          title="Nova liquidação de comissão"
          description="Reúne, com as regras vigentes agora, as comissões do período ainda não liquidadas. Começa aberta para revisão."
          initial={{
            mode: "competence",
            competence: today().slice(0, 7),
            from: `${today().slice(0, 7)}-01`,
            to: today(),
            user_id: "",
            note: "",
          }}
          fields={[
            {
              key: "mode",
              label: "Período da liquidação",
              type: "select",
              options: [
                { value: "competence", label: "Competência (mês)" },
                { value: "range", label: "Intervalo de datas" },
              ],
            },
            {
              key: "competence",
              label: "Competência liquidada",
              type: "month",
              required: true,
              when: (values) => values.mode === "competence",
            },
            {
              key: "from",
              label: "Liquidar desde",
              type: "date",
              required: true,
              when: (values) => values.mode === "range",
            },
            {
              key: "to",
              label: "Liquidar até",
              type: "date",
              required: true,
              when: (values) => values.mode === "range",
            },
            {
              key: "user_id",
              label: "Pessoa liquidada",
              type: "select",
              hint: "Pessoas com comissão na apuração consultada acima.",
              options: [
                { value: "", label: "Todas as pessoas" },
                ...people.map((person) => ({
                  value: person.user_id,
                  label: person.name,
                })),
              ],
            },
            {
              key: "note",
              label: "Observação da liquidação",
              maxLength: 500,
            },
          ]}
          submit="Criar liquidação"
          onClose={() => setCreating(false)}
          onSubmit={async (values) => {
            const created = detail.parse(
              await api("/commission-settlements", {
                body: {
                  ...(values.mode === "competence"
                    ? { competence: values.competence }
                    : { from: values.from, to: values.to }),
                  user_id: values.user_id || null,
                  note: values.note,
                },
              }),
            );
            setCreating(false);
            await refresh();
            setOpened(created.id);
          }}
        />
      )}
      {opened && (
        <SettlementDetail
          id={opened}
          write={write}
          onClose={() => setOpened(null)}
          onChange={refresh}
          onExport={exportCsv}
        />
      )}
    </QueryBoundary>
  );
}

function SettlementDetail({
  id,
  write,
  onClose,
  onChange,
  onExport,
}: {
  id: string;
  write: boolean;
  onClose: () => void;
  onChange: () => Promise<void>;
  onExport: (item: { id: string; number: number }) => Promise<unknown>;
}) {
  const result = useSWR(["erp-commission-settlement", id], async ([, key]) =>
    detail.parse(await api(`/commission-settlements/${key}`)),
  );
  const [editor, setEditor] = useState<"pay" | "reverse" | null>(null);
  const item = result.data;
  const run = async (path: string, method: string, body?: unknown) => {
    await api(`/commission-settlements/${id}${path}`, { method, body });
    await Promise.all([result.mutate(), onChange()]);
  };
  // Um diálogo por vez: o formulário de pagamento ou estorno substitui o
  // detalhe e, ao fechar, o detalhe volta atualizado.
  if (editor === "pay" && item)
    return (
      <RecordEditor
        title={`Pagar liquidação nº ${item.number}`}
        description={`Total ${money(item.total_cents / 100)}. O pagamento registrado não é alterado; corrija por estorno.`}
        initial={{ paid_on: today(), method: "pix", note: "" }}
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
            options: Object.entries(methods).map(([value, label]) => ({
              value,
              label,
            })),
          },
          { key: "note", label: "Observação do pagamento", maxLength: 500 },
        ]}
        submit="Registrar pagamento"
        onClose={() => setEditor(null)}
        onSubmit={async (values) => {
          await run("/pay", "POST", values);
          setEditor(null);
        }}
      />
    );
  if (editor === "reverse" && item)
    return (
      <RecordEditor
        title={`Estornar liquidação nº ${item.number}`}
        description="O estorno fica registrado, as linhas permanecem e os registros voltam a poder ser liquidados."
        initial={{ reason: "" }}
        fields={[
          {
            key: "reason",
            label: "Motivo do estorno",
            type: "textarea",
            required: true,
            maxLength: 300,
          },
        ]}
        submit="Confirmar estorno"
        onClose={() => setEditor(null)}
        onSubmit={async (values) => {
          await run("/reverse", "POST", values);
          setEditor(null);
        }}
      />
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
          <DialogTitle>
            {item ? `Liquidação nº ${item.number}` : "Liquidação de comissão"}
          </DialogTitle>
          <DialogDescription>
            {item
              ? `${period(item)} · ${item.user_name ?? "Todas as pessoas"} · ${labels[item.status]}`
              : "Linhas congeladas no servidor."}
          </DialogDescription>
        </DialogHeader>
        <QueryBoundary
          loading={result.isLoading}
          error={result.error}
          retry={() => result.mutate()}
        >
          {item && (
            <SettlementBody
              item={item}
              write={write}
              run={run}
              onExport={onExport}
              onDiscard={async () => {
                await api(`/commission-settlements/${id}`, {
                  method: "DELETE",
                });
                await onChange();
                onClose();
              }}
              onEditor={setEditor}
            />
          )}
        </QueryBoundary>
      </DialogContent>
    </Dialog>
  );
}

function SettlementBody({
  item,
  write,
  run,
  onExport,
  onDiscard,
  onEditor,
}: {
  item: Detail;
  write: boolean;
  run: (path: string, method: string, body?: unknown) => Promise<void>;
  onExport: (item: { id: string; number: number }) => Promise<unknown>;
  onDiscard: () => Promise<void>;
  onEditor: (editor: "pay" | "reverse") => void;
}) {
  const open = item.status === "open";
  return (
    <div className="erp-stack">
      <FinancialTotals
        items={[
          [
            "Total",
            money(item.total_cents / 100),
            `${item.lines_count} linha(s)`,
          ],
          ["Situação", labels[item.status], item.note || "Sem observação"],
          [
            "Pagamento",
            item.paid_on ? day(item.paid_on) : "Não pago",
            item.paid_method
              ? `${methods[item.paid_method]}${item.paid_note ? ` · ${item.paid_note}` : ""}`
              : "—",
          ],
        ]}
      />
      {item.status === "reversed" && (
        <p className="profile-footnote">Estornada: {item.reversal_reason}</p>
      )}
      <div className="erp-inline-actions">
        <ActionButton onClick={() => onExport(item)}>
          Exportar CSV da liquidação
        </ActionButton>
        {write && open && (
          <>
            <ActionButton
              confirm={`Fechar a liquidação nº ${item.number}? Os valores ficam congelados e não podem mais ser alterados.`}
              onClick={() => run("/close", "POST")}
            >
              Fechar liquidação
            </ActionButton>
            <ActionButton
              danger
              confirm={`Descartar o rascunho nº ${item.number}? Os registros voltam a ficar pendentes.`}
              onClick={onDiscard}
            >
              Descartar rascunho
            </ActionButton>
          </>
        )}
        {write && item.status === "closed" && (
          <Button size="sm" onClick={() => onEditor("pay")}>
            Marcar como paga
          </Button>
        )}
        {write && (item.status === "closed" || item.status === "paid") && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onEditor("reverse")}
          >
            Estornar liquidação
          </Button>
        )}
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            {["Pessoa", "Linhas", "Total"].map((label) => (
              <TableHead key={label}>{label}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {item.people.map((person) => (
            <TableRow key={person.user_id}>
              <TableCell>{person.name}</TableCell>
              <TableCell>{person.lines}</TableCell>
              <TableCell>{money(person.total_cents / 100)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              {[
                "Pessoa",
                "Origem",
                "Papel",
                "Data",
                "Regra aplicada",
                "Valor",
                ...(write && open ? ["Ações"] : []),
              ].map((label) => (
                <TableHead key={label}>{label}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {item.lines.map((line) => (
              <TableRow key={line.id}>
                <TableCell>{line.user_name}</TableCell>
                <TableCell>
                  {line.source_label}
                  {line.os_kind && (
                    <p className="profile-footnote">
                      {workKinds[line.os_kind] ?? line.os_kind}
                    </p>
                  )}
                </TableCell>
                <TableCell>{roles[line.role]}</TableCell>
                <TableCell>
                  {new Date(line.occurred_at).toLocaleDateString("pt-BR")}
                </TableCell>
                <TableCell>
                  {!line.rule_id
                    ? "Sem regra vigente"
                    : line.source_kind === "sale"
                      ? "Venda"
                      : line.rule_os_kind
                        ? `OS · ${workKinds[line.rule_os_kind] ?? line.rule_os_kind}`
                        : "OS · Todas as naturezas"}
                </TableCell>
                <TableCell>{money(line.amount_cents / 100)}</TableCell>
                {write && open && (
                  <TableCell>
                    <ActionButton
                      onClick={() => run(`/lines/${line.id}`, "DELETE")}
                    >
                      Retirar {line.source_label} de {line.user_name}
                    </ActionButton>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
