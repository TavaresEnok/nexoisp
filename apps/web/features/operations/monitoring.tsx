import useSWR from "swr";
import { z } from "zod";
import { Link } from "react-router-dom";
import { PageHeading, Panel } from "@/components/workspace-ui";
import { OperationalCatalog } from "@/components/operational-catalog";
import { ProfileFacts } from "@/components/subscriber-profile-sections";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { QueryBoundary } from "@/features/shared/feedback";
import { useSession } from "@/features/session/provider";
import { can, hasModule } from "@/features/session/model";
import { api } from "@/platform/erp-client";
import { operationLabels, stamp } from "@/features/network/models";

const count = z.coerce.number();
const when = z.string().nullable();
export const monitoringSchema = z.object({
  checked_at: z.string(),
  pop_restricted: z.boolean(),
  api: z.object({ ok: z.boolean() }),
  database: z.object({
    ok: z.boolean(),
    latency_ms: z.number(),
    server_time: z.string(),
  }),
  agents: z.array(
    z.object({
      id: z.string().uuid(),
      name: z.string(),
      status: z.string(),
      version: z.string().nullable(),
      last_seen_at: when,
      online: z.boolean(),
      open_operations: count,
    }),
  ),
  operations: z.object({
    summary: z.object({
      in_progress: count,
      uncertain: count,
      failed_recent: count,
      oldest_pending_s: count.nullable(),
      acs_pending: count,
      acs_review: count,
    }),
    items: z.array(
      z.object({
        id: z.string().uuid(),
        action: z.string(),
        status: z.string(),
        created_at: z.string(),
        finished_at: when,
        attempts: count,
        device_name: z.string().nullable(),
      }),
    ),
  }),
  queues: z.object({
    notices_pending: count,
    notices_uncertain: count,
    notices_failed: count,
    notices_oldest: when,
    team_pending: count,
    team_failed: count,
    webhooks_pending: count,
    webhooks_failed: count,
    webhooks_oldest: when,
  }),
  jobs: z.object({
    enabled: z.boolean(),
    available: z.boolean(),
    tasks: z.array(
      z.object({
        task: z.string(),
        enabled: z.boolean(),
        last_success: when,
        last_activity: when,
        pending: count,
        failed: count,
        retrying: count,
      }),
    ),
  }),
  backup: z.object({ recorded: z.boolean(), source: z.string().nullable() }),
});
const healthSchema = z.object({ ok: z.boolean(), db: z.string() });

const taskLabels: Record<string, string> = {
  ACS_TASKS: "Tarefas ACS",
  PSP_OPERATIONS: "Operações de pagamento",
  PSP_RECEIPTS: "Recebimentos do PSP",
  PSP_ISSUANCE: "Emissão de cobranças",
  PAYMENT_EFFECTS: "Efeitos de pagamento",
  BILLING: "Faturamento",
  RECONCILE: "Conciliação",
  NOTICES: "Avisos ao assinante",
  SCHEDULED: "Alterações agendadas",
  SLA: "SLA",
  PURGE: "Retenção de dados",
  TRUST: "Liberação em confiança",
  SUSPEND: "Suspensão automática",
  NOTIFICATIONS: "Avisos da equipe",
  WEBHOOKS: "Webhooks",
};
const actionLabels: Record<string, string> = {
  "subscriber.provision": "Provisionar acesso",
  "subscriber.suspend": "Suspender acesso",
  "subscriber.resume": "Religar acesso",
};
function age(seconds: number | null) {
  if (seconds == null) return "Nenhuma";
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  return `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`;
}
function Attention({ value, label }: { value: number; label: string }) {
  return value > 0 ? (
    <Badge variant="warning">
      {value} {label}
    </Badge>
  ) : (
    <span>Nenhuma</span>
  );
}

/** Painel somente leitura: saúde da API e do banco, agentes, operações, filas e rotinas. */
export function OperationalMonitoring() {
  const { me } = useSession();
  const result = useSWR(
    "monitoring-overview",
    async () => monitoringSchema.parse(await api("/monitoring/overview")),
    { refreshInterval: 30000 },
  );
  const health = useSWR(
    "monitoring-health",
    async () => healthSchema.parse(await api("/health")),
    { refreshInterval: 30000 },
  );
  const data = result.data;
  // /health responde 503 quando a API está no ar e o banco não.
  const dbDown =
    (health.data && !health.data.ok) ||
    (health.error as { status?: number } | undefined)?.status === 503;
  const messages = can(me, "settings:manage") && hasModule(me, "messages");
  const integrations = can(me, "settings:manage") && hasModule(me, "api");
  return (
    <>
      <PageHeading
        eyebrow="GESTÃO DO WORKSPACE"
        title="Acompanhamento operacional"
        description="Somente leitura: saúde da API e do banco, agentes de rede, operações, filas de avisos e entregas e rotinas periódicas do provedor. Atualiza a cada 30 segundos."
        actions={
          <Button
            variant="outline"
            onClick={() => {
              void result.mutate();
              void health.mutate();
            }}
          >
            Atualizar acompanhamento
          </Button>
        }
      />
      <Panel
        title="Saúde da plataforma"
        description="Verificação pública da API e consulta autenticada ao banco no escopo da sua sessão."
      >
        <ProfileFacts
          items={[
            [
              "API",
              health.error && !dbDown ? (
                <Badge variant="destructive">Sem resposta</Badge>
              ) : health.data?.ok || dbDown ? (
                <Badge variant="outline">Respondendo</Badge>
              ) : (
                "Consultando"
              ),
            ],
            [
              "Banco de dados",
              dbDown ? (
                <Badge variant="destructive">Indisponível</Badge>
              ) : data?.database.ok ? (
                `Disponível · ${data.database.latency_ms.toFixed(1)} ms`
              ) : (
                "Consultando"
              ),
            ],
            ["Última verificação", data ? stamp(data.checked_at) : "—"],
            [
              "Escopo",
              data?.pop_restricted
                ? "Limitado aos seus POPs"
                : "Todo o provedor",
            ],
          ]}
        />
      </Panel>
      <QueryBoundary
        loading={result.isLoading}
        error={result.error}
        retry={() => result.mutate()}
      >
        {data && (
          <div className="erp-stack">
            <Panel
              title="Agentes de rede"
              description="Contato nos últimos 30 segundos indica agente conectado."
              action={
                <Link className="profile-text-action" to="/rede/equipamentos">
                  Abrir agentes e equipamentos
                </Link>
              }
            >
              <OperationalCatalog
                title="Agentes"
                description={`${data.agents.filter((a) => a.status === "active" && !a.online).length} agente(s) ativo(s) sem contato recente.`}
                columns={[
                  "Agente",
                  "Situação",
                  "Último contato",
                  "Versão",
                  "Operações abertas",
                ]}
                empty="Nenhum agente cadastrado."
                rows={data.agents.map((agent) => ({
                  id: agent.id,
                  cells: [
                    agent.name,
                    agent.status === "revoked" ? (
                      <Badge variant="outline">Revogado</Badge>
                    ) : agent.online ? (
                      "Conectado"
                    ) : (
                      <Badge variant="warning">Sem contato</Badge>
                    ),
                    stamp(agent.last_seen_at),
                    agent.version ?? "Não informada",
                    String(agent.open_operations),
                  ],
                }))}
              />
            </Panel>
            <Panel
              title="Operações de rede"
              description="Em andamento, incertas e falhas dos últimos sete dias. Operação incerta nunca é reenviada automaticamente."
            >
              <ProfileFacts
                items={[
                  ["Em andamento", String(data.operations.summary.in_progress)],
                  [
                    "Incertas",
                    <Attention
                      key="u"
                      value={data.operations.summary.uncertain}
                      label="incerta(s)"
                    />,
                  ],
                  [
                    "Falhas em 7 dias",
                    <Attention
                      key="f"
                      value={data.operations.summary.failed_recent}
                      label="falha(s)"
                    />,
                  ],
                  [
                    "Pendência mais antiga",
                    age(data.operations.summary.oldest_pending_s),
                  ],
                  [
                    "Tarefas ACS pendentes",
                    String(data.operations.summary.acs_pending),
                  ],
                  [
                    "Tarefas ACS em revisão",
                    <Attention
                      key="r"
                      value={data.operations.summary.acs_review}
                      label="em revisão"
                    />,
                  ],
                ]}
              />
              <OperationalCatalog
                title="Operações que pedem atenção"
                description="Até quinze, incertas primeiro."
                columns={["Operação", "Equipamento", "Situação", "Criada em"]}
                empty="Nenhuma operação em andamento, incerta ou com falha recente."
                rows={data.operations.items.map((op) => ({
                  id: op.id,
                  cells: [
                    actionLabels[op.action] ?? op.action,
                    op.device_name ?? "Não informado",
                    operationLabels[op.status] ?? op.status,
                    stamp(op.created_at),
                  ],
                  actions: (
                    <Link
                      className="profile-text-action"
                      to={`/rede/operacoes?operacao=${op.id}`}
                    >
                      Abrir operação
                    </Link>
                  ),
                }))}
              />
            </Panel>
            <Panel
              title="Filas de avisos e entregas"
              description="Contagens sem conteúdo de mensagens ou destinatários. Falhas consideram os últimos sete dias."
            >
              <ProfileFacts
                items={[
                  [
                    "Avisos ao assinante na fila",
                    String(data.queues.notices_pending),
                  ],
                  [
                    "Avisos com resultado incerto",
                    <Attention
                      key="nu"
                      value={data.queues.notices_uncertain}
                      label="incerto(s)"
                    />,
                  ],
                  [
                    "Avisos com falha",
                    <Attention
                      key="nf"
                      value={data.queues.notices_failed}
                      label="falha(s)"
                    />,
                  ],
                  [
                    "Aviso pendente mais antigo",
                    stamp(data.queues.notices_oldest),
                  ],
                  [
                    "Avisos da equipe pendentes",
                    String(data.queues.team_pending),
                  ],
                  [
                    "Avisos da equipe com falha",
                    <Attention
                      key="tf"
                      value={data.queues.team_failed}
                      label="falha(s)"
                    />,
                  ],
                  ["Webhooks pendentes", String(data.queues.webhooks_pending)],
                  [
                    "Webhooks com falha",
                    <Attention
                      key="wf"
                      value={data.queues.webhooks_failed}
                      label="falha(s)"
                    />,
                  ],
                  [
                    "Webhook pendente mais antigo",
                    stamp(data.queues.webhooks_oldest),
                  ],
                ]}
              />
              <div className="erp-inline-actions">
                {messages && (
                  <Link
                    className="profile-text-action"
                    to="/administracao/avisos-assinante?aba=historico"
                  >
                    Abrir histórico de avisos
                  </Link>
                )}
                {integrations && (
                  <Link
                    className="profile-text-action"
                    to="/administracao/integracoes?aba=entregas"
                  >
                    Abrir entregas de webhooks
                  </Link>
                )}
              </div>
            </Panel>
            <Panel
              title="Rotinas periódicas"
              description={
                data.jobs.enabled
                  ? "Rotinas do provedor executadas pela fila durável."
                  : "As rotinas periódicas estão desligadas nesta instalação."
              }
            >
              {data.jobs.available ? (
                <OperationalCatalog
                  title="Rotinas do provedor"
                  description="Último sucesso registrado na fila; execuções concluídas antigas podem já ter sido removidas pela retenção da fila."
                  columns={[
                    "Rotina",
                    "Habilitada",
                    "Último sucesso",
                    "Última atividade",
                    "Na fila",
                    "Em nova tentativa",
                    "Descartadas",
                  ]}
                  rows={data.jobs.tasks.map((task) => ({
                    id: task.task,
                    cells: [
                      taskLabels[task.task] ?? task.task,
                      task.enabled ? "Sim" : "Não",
                      stamp(task.last_success),
                      stamp(task.last_activity),
                      String(task.pending),
                      String(task.retrying),
                      task.failed > 0 ? (
                        <Badge variant="warning">{task.failed}</Badge>
                      ) : (
                        "0"
                      ),
                    ],
                  }))}
                />
              ) : (
                <p className="profile-footnote">
                  A fila de rotinas não está disponível para consulta neste
                  banco.
                </p>
              )}
            </Panel>
            <Panel
              title="Último backup"
              description="O backup é executado pelo servidor (./nexo prod backup) fora da API."
            >
              <p className="profile-footnote">
                {data.backup.recorded
                  ? `Registrado em ${data.backup.source}.`
                  : "Não há registro de backup no sistema para consultar: confira o temporizador e os arquivos do servidor."}
              </p>
            </Panel>
          </div>
        )}
      </QueryBoundary>
    </>
  );
}
