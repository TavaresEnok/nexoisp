import { useState } from "react";
import useSWR from "swr";
import { z } from "zod";
import { OperationalCatalog } from "@/components/operational-catalog";
import { Panel } from "@/components/workspace-ui";
import { Button } from "@/components/ui/button";
import { RecordEditor } from "@/features/shared/record-editor";
import { QueryBoundary } from "@/features/shared/feedback";
import { ActionButton } from "@/features/shared/action";
import { api } from "@/platform/erp-client";
import { Input } from "@/components/ui/input";
import { FormField } from "@/features/shared/form";
import { toast } from "sonner";
export const workKinds: Record<string, string> = {
  install: "Instalação",
  repair: "Reparo",
  address_change: "Mudança de endereço",
  removal: "Retirada",
  other: "Outro",
};
const priorities: Record<string, string> = {
  low: "Baixa",
  normal: "Normal",
  high: "Alta",
};
const policy = z.object({
  id: z.string().uuid(),
  name: z.string(),
  applies_to: z.enum(["ticket", "work_order"]),
  priority: z.string().nullable(),
  kind: z.string().nullable(),
  type_id: z.string().nullable(),
  type_name: z.string().nullable(),
  resolution_minutes: z.coerce.number(),
  escalate_to: z.string().nullable(),
  escalate_to_name: z.string().nullable(),
  active: z.boolean(),
  business_hours: z.boolean(),
  in_use: z.coerce.number(),
});
const report = z.object({
  rows: z.array(
    z.object({
      policy_id: z.string(),
      name: z.string(),
      total: z.coerce.number(),
      within: z.coerce.number(),
      breached: z.coerce.number(),
      open_ok: z.coerce.number(),
      avg_minutes: z.coerce.number().nullable(),
    }),
  ),
});
const named = z.object({ id: z.string(), name: z.string() });
const minutes = (value: number) =>
  `${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 }).format(value >= 1440 ? value / 1440 : value >= 60 ? value / 60 : value)} ${value >= 1440 ? "d" : value >= 60 ? "h" : "min"}`;
export function SlaPolicies() {
  const result = useSWR("erp-sla-policies", async () =>
    z.array(policy).parse(await api("/sla-policies")),
  );
  const rep = useSWR("erp-sla-report", async () =>
    report.parse(await api("/reports/sla")),
  );
  const [editing, setEditing] = useState<z.infer<typeof policy> | "new" | null>(
    null,
  );
  const staff = useSWR(editing ? "erp-staff" : null, async () =>
    z.array(named).parse(await api("/staff")),
  );
  const types = useSWR(
    editing === "new" ? "erp-ticket-types" : null,
    async () => z.array(named).parse(await api("/catalogs?kind=ticket_type")),
  );
  const refresh = async () => {
    await Promise.all([result.mutate(), rep.mutate()]);
  };
  return (
    <div className="erp-stack">
      <QueryBoundary
        loading={result.isLoading}
        error={result.error}
        retry={() => result.mutate()}
      >
        <OperationalCatalog
          title="Políticas de SLA"
          description="Prazos em tempo corrido ou só no expediente do calendário abaixo. A política mais específica prevalece; o servidor aplica o escalonamento configurado."
          columns={[
            "Política",
            "Abrangência",
            "Prazo",
            "Escalonamento",
            "Em uso",
            "Situação",
          ]}
          actions={
            <Button onClick={() => setEditing("new")}>
              Nova política de SLA
            </Button>
          }
          rows={(result.data ?? []).map((item) => ({
            id: item.id,
            cells: [
              item.name,
              item.applies_to === "ticket"
                ? [
                    "Atendimentos",
                    item.priority && priorities[item.priority],
                    item.type_name,
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : `OS · ${item.kind ? workKinds[item.kind] : "Todas as naturezas"}`,
              `${minutes(item.resolution_minutes)}${item.business_hours ? " úteis" : ""}`,
              item.escalate_to_name ?? "Sem escalonamento",
              item.in_use,
              item.active ? "Ativa" : "Inativa",
            ],
            actions: (
              <div className="erp-inline-actions">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setEditing(item)}
                >
                  Editar política
                </Button>
                <ActionButton
                  onClick={async () => {
                    await api(`/sla-policies/${item.id}`, {
                      method: "PATCH",
                      body: { active: !item.active },
                    });
                    await refresh();
                  }}
                >
                  {item.active ? "Desativar política" : "Ativar política"}
                </ActionButton>
                {item.in_use === 0 && (
                  <ActionButton
                    danger
                    confirm={`Excluir a política ${item.name}?`}
                    onClick={async () => {
                      await api(`/sla-policies/${item.id}`, {
                        method: "DELETE",
                      });
                      await refresh();
                    }}
                  >
                    Excluir política
                  </ActionButton>
                )}
              </div>
            ),
          }))}
        />
      </QueryBoundary>
      <QueryBoundary
        loading={rep.isLoading}
        error={rep.error}
        retry={() => rep.mutate()}
      >
        <OperationalCatalog
          title="Cumprimento de SLA"
          description="Todas as ocorrências que possuem política vinculada."
          columns={[
            "Política",
            "Total",
            "No prazo",
            "Fora do prazo",
            "Em andamento no prazo",
            "Tempo médio",
          ]}
          rows={(rep.data?.rows ?? []).map((item) => ({
            id: item.policy_id,
            cells: [
              item.name,
              item.total,
              item.within,
              item.breached,
              item.open_ok,
              item.avg_minutes == null
                ? "Sem conclusão"
                : minutes(item.avg_minutes),
            ],
          }))}
        />
      </QueryBoundary>
      {editing && (
        <RecordEditor
          title={
            editing === "new"
              ? "Nova política de SLA"
              : "Editar política de SLA"
          }
          loading={staff.isLoading || (editing === "new" && types.isLoading)}
          error={staff.error ?? types.error}
          retry={() => {
            void staff.mutate();
            void types.mutate();
          }}
          description="A abrangência é definida na criação. O prazo e a pessoa de escalonamento podem ser ajustados."
          initial={{
            name: editing === "new" ? "" : editing.name,
            applies_to: editing === "new" ? "ticket" : editing.applies_to,
            priority: editing === "new" ? "" : (editing.priority ?? ""),
            kind: editing === "new" ? "" : (editing.kind ?? ""),
            type_id: editing === "new" ? "" : (editing.type_id ?? ""),
            resolution_minutes: String(
              editing === "new" ? 1440 : editing.resolution_minutes,
            ),
            escalate_to: editing === "new" ? "" : (editing.escalate_to ?? ""),
            business_hours:
              editing !== "new" && editing.business_hours ? "yes" : "no",
          }}
          fields={[
            {
              key: "name",
              label: "Nome da política",
              required: true,
              maxLength: 80,
            },
            ...(editing === "new"
              ? [
                  {
                    key: "applies_to",
                    label: "Abrangência da política",
                    type: "select" as const,
                    options: [
                      { value: "ticket", label: "Atendimentos" },
                      { value: "work_order", label: "Ordens de serviço" },
                    ],
                  },
                  {
                    key: "priority",
                    label: "Prioridade do atendimento",
                    type: "select" as const,
                    when: (v: Record<string, string>) =>
                      v.applies_to === "ticket",
                    options: [
                      { value: "", label: "Todas" },
                      ...Object.entries(priorities).map(([value, label]) => ({
                        value,
                        label,
                      })),
                    ],
                  },
                  {
                    key: "type_id",
                    label: "Tipo de atendimento",
                    type: "select" as const,
                    when: (v: Record<string, string>) =>
                      v.applies_to === "ticket",
                    options: [
                      { value: "", label: "Todos" },
                      ...(types.data ?? []).map((item) => ({
                        value: item.id,
                        label: item.name,
                      })),
                    ],
                  },
                  {
                    key: "kind",
                    label: "Natureza da OS",
                    type: "select" as const,
                    when: (v: Record<string, string>) =>
                      v.applies_to === "work_order",
                    options: [
                      { value: "", label: "Todas" },
                      ...Object.entries(workKinds).map(([value, label]) => ({
                        value,
                        label,
                      })),
                    ],
                  },
                ]
              : []),
            {
              key: "resolution_minutes",
              label: "Prazo em minutos",
              type: "number",
              min: 5,
              max: 525600,
              required: true,
            },
            {
              key: "business_hours",
              label: "Contagem do prazo",
              type: "select",
              options: [
                { value: "no", label: "Tempo corrido" },
                { value: "yes", label: "Somente no expediente" },
              ],
              hint: "No expediente, usa o calendário e os feriados desta aba; sem calendário, conta tempo corrido.",
            },
            {
              key: "escalate_to",
              label: "Escalonar para",
              type: "select",
              options: [
                { value: "", label: "Ninguém" },
                ...(staff.data ?? []).map((item) => ({
                  value: item.id,
                  label: item.name,
                })),
              ],
            },
          ]}
          onClose={() => setEditing(null)}
          onSubmit={async (values) => {
            const body = {
              name: values.name,
              resolution_minutes: Number(values.resolution_minutes),
              escalate_to: values.escalate_to || null,
              business_hours: values.business_hours === "yes",
            };
            await api(
              editing === "new"
                ? "/sla-policies"
                : `/sla-policies/${editing.id}`,
              {
                method: editing === "new" ? "POST" : "PATCH",
                body:
                  editing === "new"
                    ? {
                        ...body,
                        applies_to: values.applies_to,
                        priority:
                          values.applies_to === "ticket"
                            ? values.priority || null
                            : null,
                        type_id:
                          values.applies_to === "ticket"
                            ? values.type_id || null
                            : null,
                        kind:
                          values.applies_to === "work_order"
                            ? values.kind || null
                            : null,
                      }
                    : body,
              },
            );
            setEditing(null);
            await refresh();
          }}
        />
      )}
      <SlaCalendar />
    </div>
  );
}
const weekdays = [
  "Domingo",
  "Segunda-feira",
  "Terça-feira",
  "Quarta-feira",
  "Quinta-feira",
  "Sexta-feira",
  "Sábado",
];
const timezones: Record<string, string> = {
  "America/Sao_Paulo": "Brasília (São Paulo)",
  "America/Fortaleza": "Fortaleza",
  "America/Recife": "Recife",
  "America/Bahia": "Salvador",
  "America/Maceio": "Maceió",
  "America/Belem": "Belém",
  "America/Araguaina": "Araguaína",
  "America/Manaus": "Manaus",
  "America/Cuiaba": "Cuiabá",
  "America/Campo_Grande": "Campo Grande",
  "America/Porto_Velho": "Porto Velho",
  "America/Boa_Vista": "Boa Vista",
  "America/Rio_Branco": "Rio Branco",
  "America/Santarem": "Santarém",
  "America/Noronha": "Fernando de Noronha",
};
type Window = { start: string; end: string } | null;
const calendarSchema = z.object({
  timezone: z.string().nullable(),
  hours: z
    .array(z.object({ start: z.string(), end: z.string() }).nullable())
    .nullable(),
});
const holidaySchema = z.object({
  id: z.string(),
  day: z.string(),
  name: z.string(),
});
const defaultHours: Window[] = [
  null,
  ...Array.from({ length: 5 }, () => ({ start: "08:00", end: "18:00" })),
  { start: "08:00", end: "12:00" },
];
// Expediente e feriados usados pelas políticas "Somente no expediente".
function SlaCalendar() {
  const calendar = useSWR("erp-sla-calendar", async () =>
    calendarSchema.parse(await api("/sla-calendar")),
  );
  const holidays = useSWR("erp-sla-holidays", async () =>
    z.array(holidaySchema).parse(await api("/sla-holidays")),
  );
  const [draft, setDraft] = useState<{
    timezone: string;
    hours: Window[];
  } | null>(null);
  const [adding, setAdding] = useState(false);
  const current = draft ?? {
    timezone: calendar.data?.timezone ?? "America/Sao_Paulo",
    hours: calendar.data?.hours ?? defaultHours,
  };
  const update = (index: number, value: Window) =>
    setDraft({
      ...current,
      hours: current.hours.map((item, position) =>
        position === index ? value : item,
      ),
    });
  return (
    <>
      <Panel
        title="Calendário de expediente"
        description={
          calendar.data?.hours
            ? "Prazos das políticas de expediente contam só estes horários, no fuso escolhido, sem os feriados. Prazos já atribuídos não são recalculados."
            : "Sem calendário cadastrado, as políticas de expediente contam tempo corrido. Salve o expediente para ativá-las."
        }
      >
        <QueryBoundary
          loading={calendar.isLoading}
          error={calendar.error}
          retry={() => calendar.mutate()}
        >
          <div className="erp-stack">
            <FormField label="Fuso do expediente">
              <select
                className="commercial-select"
                value={current.timezone}
                onChange={(event) =>
                  setDraft({ ...current, timezone: event.target.value })
                }
              >
                {Object.entries(timezones).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </FormField>
            {weekdays.map((label, index) => {
              const window = current.hours[index];
              return (
                <div className="erp-columns" key={label}>
                  <FormField label={label}>
                    <select
                      className="commercial-select"
                      value={window ? "open" : "closed"}
                      onChange={(event) =>
                        update(
                          index,
                          event.target.value === "open"
                            ? { start: "08:00", end: "18:00" }
                            : null,
                        )
                      }
                    >
                      <option value="open">Com expediente</option>
                      <option value="closed">Sem expediente</option>
                    </select>
                  </FormField>
                  {window && (
                    <>
                      <FormField label={`Início · ${label}`}>
                        <Input
                          type="time"
                          value={window.start}
                          onChange={(event) =>
                            update(index, {
                              ...window,
                              start: event.target.value,
                            })
                          }
                        />
                      </FormField>
                      <FormField label={`Fim · ${label}`}>
                        <Input
                          type="time"
                          value={window.end}
                          onChange={(event) =>
                            update(index, {
                              ...window,
                              end: event.target.value,
                            })
                          }
                        />
                      </FormField>
                    </>
                  )}
                </div>
              );
            })}
            <div className="erp-inline-actions">
              <ActionButton
                onClick={async () => {
                  await api("/sla-calendar", { method: "PUT", body: current });
                  setDraft(null);
                  await calendar.mutate();
                  toast.success("Calendário de expediente salvo.");
                }}
              >
                Salvar expediente
              </ActionButton>
            </div>
          </div>
        </QueryBoundary>
      </Panel>
      <QueryBoundary
        loading={holidays.isLoading}
        error={holidays.error}
        retry={() => holidays.mutate()}
      >
        <OperationalCatalog
          title="Feriados"
          description="Dias sem expediente para os prazos de SLA, além dos dias marcados acima."
          columns={["Data", "Feriado"]}
          actions={
            <Button onClick={() => setAdding(true)}>Novo feriado</Button>
          }
          rows={(holidays.data ?? []).map((item) => ({
            id: item.id,
            cells: [
              new Date(`${item.day.slice(0, 10)}T12:00:00`).toLocaleDateString(
                "pt-BR",
              ),
              item.name,
            ],
            actions: (
              <ActionButton
                confirm={`Excluir o feriado ${item.name}?`}
                onClick={async () => {
                  await api(`/sla-holidays/${item.id}`, { method: "DELETE" });
                  await holidays.mutate();
                }}
              >
                Excluir feriado
              </ActionButton>
            ),
          }))}
          empty="Nenhum feriado cadastrado."
        />
      </QueryBoundary>
      {adding && (
        <RecordEditor
          title="Novo feriado"
          description="O dia inteiro fica fora do expediente nos prazos de SLA."
          initial={{ day: "", name: "" }}
          fields={[
            {
              key: "day",
              label: "Data do feriado",
              type: "date",
              required: true,
            },
            {
              key: "name",
              label: "Nome do feriado",
              required: true,
              maxLength: 80,
            },
          ]}
          submit="Cadastrar feriado"
          onClose={() => setAdding(false)}
          onSubmit={async (values) => {
            await api("/sla-holidays", { body: values });
            setAdding(false);
            await holidays.mutate();
          }}
        />
      )}
    </>
  );
}
const surveys = z.object({
  summary: z.object({
    average: z.coerce.number().nullable(),
    answered: z.coerce.number(),
    sent: z.coerce.number(),
    satisfied: z.coerce.number(),
  }),
  rows: z.array(
    z.object({
      id: z.string(),
      work_order_number: z.coerce.number(),
      kind: z.string(),
      subscriber_name: z.string(),
      assignee_name: z.string().nullable(),
      status: z.string(),
      score: z.coerce.number().nullable(),
      comment: z.string().nullable(),
    }),
  ),
});
export function Satisfaction() {
  const result = useSWR("erp-surveys", async () =>
    surveys.parse(await api("/surveys")),
  );
  const summary = result.data?.summary;
  return (
    <QueryBoundary
      loading={result.isLoading}
      error={result.error}
      retry={() => result.mutate()}
    >
      <div className="erp-stack">
        <Panel
          title="Satisfação dos assinantes"
          description="Pesquisas são criadas quando uma OS é concluída. A resposta é feita pelo próprio assinante no portal."
        >
          {summary && (
            <p>
              {summary.answered === 0 || summary.average == null
                ? "Sem nota média"
                : `Nota média ${summary.average.toFixed(1)} de 5`}{" "}
              · {summary.answered} de {summary.sent} respondidas
              {summary.answered > 0
                ? ` · ${Math.round((summary.satisfied / summary.answered) * 100)}% de notas 4 e 5`
                : ""}
            </p>
          )}
        </Panel>
        <OperationalCatalog
          title="Pesquisas de satisfação"
          description="Respostas e pesquisas pendentes registradas pelo servidor."
          columns={[
            "OS",
            "Natureza",
            "Assinante",
            "Técnico",
            "Nota ou situação",
            "Comentário",
          ]}
          rows={(result.data?.rows ?? []).map((item) => ({
            id: item.id,
            cells: [
              `#${item.work_order_number}`,
              workKinds[item.kind] ?? item.kind,
              item.subscriber_name,
              item.assignee_name ?? "Não atribuído",
              item.status === "answered"
                ? `${item.score} de 5`
                : item.status === "expired"
                  ? "Expirada"
                  : "Aguardando resposta",
              item.comment ?? "Sem comentário",
            ],
          }))}
        />
      </div>
    </QueryBoundary>
  );
}
