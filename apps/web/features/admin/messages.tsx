import { lazy, Suspense, useState } from "react";
import useSWR from "swr";
import { useSearchParams } from "react-router-dom";
import { z } from "zod";
import { PageHeading } from "@/components/workspace-ui";
import { OperationalCatalog } from "@/components/operational-catalog";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { RecordEditor } from "@/features/shared/record-editor";
import { QueryBoundary } from "@/features/shared/feedback";
import { ActionButton } from "@/features/shared/action";
import { api } from "@/platform/erp-client";
import {
  channel,
  templates,
  rule,
  noticeLog,
  messageStates,
} from "./message-models";
const MessageChannels = lazy(() =>
  import("./message-channels").then((m) => ({ default: m.MessageChannels })),
);
const MessageTemplates = lazy(() =>
  import("./message-channels").then((m) => ({ default: m.MessageTemplates })),
);
export function SubscriberMessages() {
  const [params, setParams] = useSearchParams();
  const tabs = [
    ["regras", "Régua de cobrança"],
    ["modelos", "Modelos"],
    ["canais", "Canais de envio"],
    ["historico", "Histórico"],
  ];
  const tab = tabs.some(([value]) => value === params.get("aba"))
    ? params.get("aba")!
    : "regras";
  return (
    <>
      <PageHeading
        title="Avisos ao assinante"
        description="Mensagens de saída para contatos com consentimento registrado. O NexoISP não recebe respostas por estes canais."
      />
      <Tabs
        value={tab}
        onValueChange={(value) =>
          setParams((previous) => {
            previous.set("aba", String(value));
            return previous;
          })
        }
      >
        <div className="overflow-x-auto">
          <TabsList aria-label="Avisos ao assinante">
            {tabs.map(([value, label]) => (
              <TabsTrigger key={value} value={value}>
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent value={tab}>
          <Suspense fallback={<QueryBoundary loading>{null}</QueryBoundary>}>
            {tab === "canais" ? (
              <MessageChannels />
            ) : tab === "modelos" ? (
              <MessageTemplates />
            ) : tab === "historico" ? (
              <MessageHistory />
            ) : (
              <MessageRules />
            )}
          </Suspense>
        </TabsContent>
      </Tabs>
    </>
  );
}
function MessageHistory() {
  const result = useSWR(
    "erp-notice-log",
    async () => z.array(noticeLog).parse(await api("/notice-log?limit=100")),
    { refreshInterval: 15000 },
  );
  return (
    <QueryBoundary
      loading={result.isLoading}
      error={result.error}
      retry={() => result.mutate()}
    >
      <OperationalCatalog
        title="Histórico de mensagens"
        description="Últimos cem registros. Resultado desconhecido exige conferência; envio ao serviço não comprova leitura pelo assinante."
        columns={[
          "Quando",
          "Assinante / contato",
          "Regra",
          "Resultado",
          "Tentativas / erro",
        ]}
        rows={(result.data ?? []).map((item) => ({
          id: String(item.id),
          cells: [
            new Date(item.created_at).toLocaleString("pt-BR"),
            <>
              {item.subscriber_name ?? "Teste"}
              <small className="table-subline">
                {item.contact_value ?? "Sem contato"}
              </small>
            </>,
            item.rule_name ?? "Teste ou aviso operacional",
            messageStates[item.status] ?? item.status,
            `${item.attempts}${item.error ? ` · ${item.error}` : ""}`,
          ],
        }))}
      />
    </QueryBoundary>
  );
}
const named = z.object({ id: z.string(), name: z.string() });
function MessageRules() {
  const result = useSWR("erp-notice-rules", async () =>
    z.array(rule).parse(await api("/notice-rules")),
  );
  const channels = useSWR("erp-notice-channels", async () =>
    z.array(channel).parse(await api("/notice-channels")),
  );
  const models = useSWR("erp-notice-templates", async () =>
    templates.parse(await api("/notice-templates")),
  );
  const [creating, setCreating] = useState(false);
  const plans = useSWR(creating ? "erp-message-plans" : null, async () =>
    z.array(named).parse(await api("/plans")),
  );
  const pops = useSWR(creating ? "erp-message-pops" : null, async () =>
    z.array(named).parse(await api("/pops")),
  );
  const tags = useSWR(creating ? "erp-message-tags" : null, async () =>
    z.array(named).parse(await api("/tags")),
  );
  const [run, setRun] = useState<{
    sent: number;
    failed: number;
    skipped: number;
  } | null>(null);
  const enabledChannels = channels.data?.filter((item) => item.active) ?? [];
  const ready = enabledChannels.length > 0 && Boolean(models.data?.rows.length);
  return (
    <QueryBoundary
      loading={result.isLoading || channels.isLoading || models.isLoading}
      error={result.error ?? channels.error ?? models.error}
      retry={() => {
        void result.mutate();
        void channels.mutate();
        void models.mutate();
      }}
    >
      <div className="erp-stack">
        <div className="erp-inline-actions">
          <Button disabled={!ready} onClick={() => setCreating(true)}>
            Nova regra de cobrança
          </Button>
          <ActionButton
            confirm="Executar a régua de cobrança agora? A janela, o consentimento e os limites de repetição serão conferidos no servidor antes de enviar."
            onClick={async () => {
              setRun(await api("/notice-rules/run", { method: "POST" }));
              await result.mutate();
            }}
          >
            Executar régua agora
          </ActionButton>
        </div>
        {!ready && (
          <p className="profile-footnote">
            Cadastre ao menos um canal ativo e um modelo para criar uma regra.
          </p>
        )}
        {run && (
          <p role="status">
            Rodada: {run.sent} enviado(s) ao serviço, {run.failed} falha(s),{" "}
            {run.skipped} sem consentimento.
          </p>
        )}
        <OperationalCatalog
          title="Regras de cobrança"
          description="A janela segue o fuso do provedor. O Go aplica filtros, consentimento e uma vez por título/regra, além do intervalo mínimo."
          columns={[
            "Regra",
            "Quando",
            "Modelo / canal",
            "Dias da semana",
            "Intervalo mínimo",
            "Enviados",
            "Situação",
          ]}
          rows={(result.data ?? []).map((item) => ({
            id: item.id,
            cells: [
              item.name,
              item.days_relative < 0
                ? `${-item.days_relative} dias antes`
                : item.days_relative === 0
                  ? "No vencimento"
                  : `${item.days_relative} dias depois`,
              <>
                {item.template_name}
                <small className="table-subline">
                  {item.channel_name} · {item.hour_from}h–{item.hour_to}h
                </small>
              </>,
              item.weekdays
                .map(
                  (value) =>
                    ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"][value],
                )
                .join(", "),
              `${item.min_interval_days} dias`,
              item.sent,
              item.active ? "Ativa" : "Pausada",
            ],
            actions: (
              <div className="erp-inline-actions">
                <ActionButton
                  onClick={async () => {
                    await api(`/notice-rules/${item.id}`, {
                      method: "PATCH",
                      body: { active: !item.active },
                    });
                    await result.mutate();
                  }}
                >
                  {item.active ? "Pausar regra" : "Ativar regra"}
                </ActionButton>
                <ActionButton
                  danger
                  confirm="Excluir esta regra de cobrança? O histórico será preservado."
                  onClick={async () => {
                    await api(`/notice-rules/${item.id}`, { method: "DELETE" });
                    await result.mutate();
                  }}
                >
                  Excluir regra
                </ActionButton>
              </div>
            ),
          }))}
        />
        {creating && (
          <RecordEditor
            title="Nova regra de cobrança"
            description="A regra só envia para contatos com consentimento. Valores negativos indicam dias antes do vencimento."
            loading={plans.isLoading || pops.isLoading || tags.isLoading}
            error={plans.error ?? pops.error ?? tags.error}
            retry={() => {
              void plans.mutate();
              void pops.mutate();
              void tags.mutate();
            }}
            initial={{
              name: "",
              template_id: models.data?.rows[0]?.id ?? "",
              channel_id: enabledChannels[0]?.id ?? "",
              plan_id: "",
              pop_id: "",
              tag_id: "",
              days_relative: "-3",
              hour_from: "8",
              hour_to: "20",
              weekdays: "0,1,2,3,4,5,6",
              min_interval_days: "1",
            }}
            fields={[
              {
                key: "name",
                label: "Nome da regra",
                required: true,
                maxLength: 80,
              },
              {
                key: "template_id",
                label: "Modelo da regra",
                type: "select",
                required: true,
                options: (models.data?.rows ?? []).map((item) => ({
                  value: item.id,
                  label: item.name,
                })),
              },
              {
                key: "channel_id",
                label: "Canal da regra",
                type: "select",
                required: true,
                options: enabledChannels.map((item) => ({
                  value: item.id,
                  label: item.name,
                })),
              },
              ...[
                { key: "plan_id", label: "Plano da regra", items: plans.data },
                { key: "pop_id", label: "POP da regra", items: pops.data },
                { key: "tag_id", label: "Etiqueta da regra", items: tags.data },
              ].map((field) => ({
                key: field.key,
                label: field.label,
                type: "select" as const,
                options: [
                  { value: "", label: "Todos" },
                  ...(field.items ?? []).map((item) => ({
                    value: item.id,
                    label: item.name,
                  })),
                ],
              })),
              {
                key: "days_relative",
                label: "Dias em relação ao vencimento",
                type: "number",
                required: true,
                min: -30,
                max: 365,
              },
              {
                key: "hour_from",
                label: "Enviar a partir da hora",
                type: "number",
                required: true,
                min: 0,
                max: 23,
              },
              {
                key: "hour_to",
                label: "Enviar até a hora",
                type: "number",
                required: true,
                min: 1,
                max: 24,
              },
              {
                key: "weekdays",
                label: "Dias de envio",
                type: "select",
                options: [
                  { value: "0,1,2,3,4,5,6", label: "Todos os dias" },
                  { value: "1,2,3,4,5", label: "Segunda a sexta" },
                  { value: "0,6", label: "Sábado e domingo" },
                ],
              },
              {
                key: "min_interval_days",
                label: "Intervalo mínimo em dias",
                type: "number",
                required: true,
                min: 0,
                max: 60,
              },
            ]}
            onClose={() => setCreating(false)}
            submit="Criar regra"
            onSubmit={async (values) => {
              await api("/notice-rules", {
                body: {
                  name: values.name,
                  template_id: values.template_id,
                  channel_id: values.channel_id,
                  plan_id: values.plan_id || null,
                  pop_id: values.pop_id || null,
                  tag_id: values.tag_id || null,
                  days_relative: Number(values.days_relative),
                  hour_from: Number(values.hour_from),
                  hour_to: Number(values.hour_to),
                  weekdays: values.weekdays.split(",").map(Number),
                  min_interval_days: Number(values.min_interval_days),
                },
              });
              setCreating(false);
              await result.mutate();
            }}
          />
        )}
      </div>
    </QueryBoundary>
  );
}
