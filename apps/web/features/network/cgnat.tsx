import { useState } from "react";
import useSWR from "swr";
import { z } from "zod";
import { useNavigate } from "react-router-dom";
import { Panel } from "@/components/workspace-ui";
import { CoreNetworkFrame } from "@/components/core-network";
import { coreTabs } from "./core-tabs";
import { OperationalCatalog } from "@/components/operational-catalog";
import {
  ProfileFacts,
  ProfileSection,
} from "@/components/subscriber-profile-sections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { QueryBoundary } from "@/features/shared/feedback";
import { MutationForm, FormField } from "@/features/shared/form";
import { ActionButton } from "@/features/shared/action";
import { can } from "@/features/session/model";
import { useSession } from "@/features/session/provider";
import { api, download } from "@/platform/erp-client";
import { stamp } from "./models";
import { poolSchema, useIpamRefresh, type AddressPool } from "./ipam";
import styles from "@/components/technical.module.css";
import { useCreateRequest } from "@/features/shared/create-request";
const n = z.coerce.number();
const capacitySchema = z.object({
  private_ips: n,
  public_ips: n,
  ratio: n,
  max_private_ips: n,
});
const planSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  private_cidr: z.string(),
  public_cidr: z.string(),
  ports_per_subscriber: n,
  port_start: n,
  port_end: n.nullable().optional(),
  layout: z.enum(["sequential", "netmap", "external"]).default("sequential"),
  nat_log: z.enum(["syslog", "equipment", "none"]).nullable().optional(),
  nat_log_detail: z.string().nullable().optional(),
  public_first: z.string().nullable().optional(),
  public_last: z.string().nullable().optional(),
  created_at: z.string(),
  created_by_name: z.string().nullable(),
  retired_at: z.string().nullable(),
  capacity: capacitySchema,
});
type Plan = z.infer<typeof planSchema>;
const layoutLabels: Record<Plan["layout"], string> = {
  sequential: "Regras geradas pelo NexoISP",
  netmap: "Netmap MikroTik (blocos contíguos)",
  external: "Equipamento externo (Hillstone, A10…)",
};
const natLogLabels: Record<NonNullable<Plan["nat_log"]>, string> = {
  syslog: "Enviado a um servidor de logs",
  equipment: "Guardado no próprio equipamento",
  none: "Não há registro de NAT",
};
const host = (value: string | null | undefined) =>
  value ? value.replace(/\/32$/, "") : "";
const blockSchema = z.object({
  private_ip: z.string(),
  public_ip: z.string(),
  port_start: n,
  port_end: n,
});
export function CgnatDirectory() {
  const { me } = useSession();
  const navigate = useNavigate();
  const plans = useSWR("erp-cgnat-plans", async () =>
    z.array(planSchema).parse(await api("/cgnat/plans")),
  );
  const pools = useSWR("erp-pools", async () =>
    z.array(poolSchema).parse(await api("/ipam/pools")),
  );
  const refresh = useIpamRefresh();
  const [creating, setCreating] = useState(false);
  const [mapped, setMapped] = useState<Plan | null>(null);
  const write = can(me, "network:write");
  useCreateRequest("cgnat", () => setCreating(true), write);
  return (
    <CoreNetworkFrame
      tab="cgnat"
      tabs={coreTabs(me)}
      onTab={navigate}
      title="Planos de CGNAT"
      description="Planejamento de endereços e portas com cálculo e rastreio no servidor."
      actions={
        write && (
          <Button onClick={() => setCreating(true)}>Novo plano de CGNAT</Button>
        )
      }
    >
      <p className="profile-footnote">
        O script RouterOS exige revisão e aplicação manual pela equipe de rede.
        O servidor não aplica regras ao equipamento; a validação existente é de
        laboratório.
      </p>
      <QueryBoundary
        loading={plans.isLoading}
        error={plans.error}
        retry={() => plans.mutate()}
      >
        <OperationalCatalog
          title="Planos de tradução de portas"
          description="Planos são imutáveis. Para alterar, encerre e crie outro; consultas passadas continuam usando a configuração da época."
          columns={[
            "Plano",
            "Assinantes → saída",
            "Portas por assinante",
            "Assinantes por IP",
            "Criado em",
            "Situação",
          ]}
          rows={(plans.data ?? []).map((plan) => ({
            id: plan.id,
            cells: [
              plan.name,
              <>
                {`${plan.private_cidr} → ${plan.public_cidr}`}
                {(plan.public_first || plan.public_last) && (
                  <small className="table-subline">
                    {`Faixa ${host(plan.public_first) || "início do bloco"} a ${host(plan.public_last) || "fim do bloco"}`}
                  </small>
                )}
              </>,
              <>
                {plan.ports_per_subscriber}
                <small className="table-subline">
                  {layoutLabels[plan.layout]}
                </small>
              </>,
              plan.layout === "external" ? (
                <>
                  Sem cálculo
                  <small className="table-subline">
                    {plan.nat_log
                      ? `Registro de NAT: ${natLogLabels[plan.nat_log].toLowerCase()}`
                      : "Registro de NAT não informado"}
                  </small>
                  {(!plan.nat_log || plan.nat_log === "none") &&
                    !plan.retired_at && (
                      <Badge variant="destructive">Ofícios sem resposta</Badge>
                    )}
                </>
              ) : (
                plan.capacity.ratio
              ),
              <>
                {stamp(plan.created_at)}
                <small className="table-subline">
                  {plan.created_by_name || "Não informado"}
                </small>
              </>,
              <Badge variant="outline">
                {plan.retired_at
                  ? `Encerrado · ${stamp(plan.retired_at)}`
                  : "Vigente"}
              </Badge>,
            ],
            actions: (
              <div className="erp-inline-actions">
                {plan.layout !== "external" && (
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={`Mapa de ${plan.name}`}
                    onClick={() => setMapped(plan)}
                  >
                    Mapa
                  </Button>
                )}
                {write && plan.layout !== "external" && (
                  <>
                    <ActionButton
                      onClick={() =>
                        download(
                          `/cgnat/plans/${plan.id}/script`,
                          `cgnat-${plan.id.slice(0, 8)}.rsc`,
                        )
                      }
                    >
                      Script RouterOS
                    </ActionButton>
                    {!plan.retired_at && (
                      <ActionButton
                        danger
                        confirm="Encerrar o plano? As consultas históricas são preservadas. Remova as regras do roteador separadamente."
                        onClick={async () => {
                          await api(`/cgnat/plans/${plan.id}/retire`, {
                            body: {},
                          });
                          await refresh();
                        }}
                      >
                        Encerrar plano
                      </ActionButton>
                    )}
                  </>
                )}
              </div>
            ),
          }))}
        />
      </QueryBoundary>
      <CgnatTrace />
      {write && <CgnatImport />}
      {creating && (
        <PlanEditor
          pools={pools.data ?? []}
          loading={pools.isLoading}
          error={pools.error}
          retry={() => pools.mutate()}
          onClose={() => setCreating(false)}
          onDone={async () => {
            setCreating(false);
            await refresh();
          }}
        />
      )}
      {mapped && <PlanMap plan={mapped} onClose={() => setMapped(null)} />}
    </CoreNetworkFrame>
  );
}
function PlanEditor({
  pools,
  loading,
  error,
  retry,
  onClose,
  onDone,
}: {
  pools: AddressPool[];
  loading: boolean;
  error: unknown;
  retry: () => unknown;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [values, setValues] = useState({
    name: "",
    private_pool_id: "",
    public_pool_id: "",
    ports_per_subscriber: "2016",
    port_start: "1024",
    port_end: "",
    layout: "sequential",
    nat_log: "",
    nat_log_detail: "",
    public_first: "",
    public_last: "",
  });
  const [capacity, setCapacity] = useState<z.infer<
    typeof capacitySchema
  > | null>(null);
  const body = () => ({
    ...values,
    ports_per_subscriber: Number(values.ports_per_subscriber),
    port_start: Number(values.port_start),
    port_end: values.port_end ? Number(values.port_end) : null,
    nat_log:
      values.layout === "external" && values.nat_log ? values.nat_log : null,
    nat_log_detail:
      values.layout === "external" ? values.nat_log_detail || null : null,
    public_first:
      values.layout !== "netmap" ? values.public_first || null : null,
    public_last: values.layout !== "netmap" ? values.public_last || null : null,
  });
  const set = (key: keyof typeof values, value: string) => {
    setValues((previous) => ({ ...previous, [key]: value }));
    setCapacity(null);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="erp-editor">
        <DialogHeader>
          <DialogTitle>Novo plano de CGNAT</DialogTitle>
          <DialogDescription>
            O servidor calcula a capacidade e impede sobreposição de planos
            ativos. Nada é aplicado ao NAS automaticamente.
          </DialogDescription>
        </DialogHeader>
        <QueryBoundary loading={loading} error={error} retry={retry}>
          <MutationForm
            submit="Criar plano de CGNAT"
            onCancel={onClose}
            onSubmit={async () => {
              await api("/cgnat/plans", { body: body() });
              await onDone();
            }}
          >
            <FormField label="Nome do plano CGNAT">
              <Input
                required
                maxLength={80}
                value={values.name}
                onChange={(event) => set("name", event.target.value)}
              />
            </FormField>
            {(["private", "public"] as const).map((kind) => (
              <FormField
                key={kind}
                label={
                  kind === "private"
                    ? "Bloco dos assinantes CGNAT"
                    : "Bloco público de saída"
                }
              >
                <select
                  required
                  className="commercial-select"
                  value={values[`${kind}_pool_id`]}
                  onChange={(event) =>
                    set(`${kind}_pool_id`, event.target.value)
                  }
                >
                  <option value="">Selecione…</option>
                  {pools
                    .filter(
                      (pool) =>
                        pool.family === 4 &&
                        pool.kind === (kind === "private" ? "cgnat" : "public"),
                    )
                    .map((pool) => (
                      <option key={pool.id} value={pool.id}>
                        {pool.name} · {pool.cidr}
                      </option>
                    ))}
                </select>
              </FormField>
            ))}
            <FormField label="Como o equipamento faz o CGNAT">
              <select
                className="commercial-select"
                value={values.layout}
                onChange={(event) => set("layout", event.target.value)}
              >
                {Object.entries(layoutLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </FormField>
            <p className="profile-footnote">
              A consulta de IP para ofício só aponta um assinante quando conhece
              a regra do equipamento. Em CGNAT dedicado com alocação dinâmica ou
              aleatória de portas, o titular vem do registro de NAT do próprio
              equipamento e o NexoISP não faz o cálculo.
            </p>
            {values.layout === "external" && (
              <div className="erp-columns">
                <FormField label="Onde fica o registro de NAT">
                  <select
                    className="commercial-select"
                    required
                    value={values.nat_log}
                    onChange={(event) => set("nat_log", event.target.value)}
                  >
                    <option value="">Selecione</option>
                    {Object.entries(natLogLabels).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </FormField>
                <FormField label="Servidor ou observação (opcional)">
                  <Input
                    maxLength={200}
                    placeholder="Ex.: syslog do NOC, guarda de 12 meses"
                    value={values.nat_log_detail}
                    onChange={(event) =>
                      set("nat_log_detail", event.target.value)
                    }
                  />
                </FormField>
              </div>
            )}
            {values.layout === "external" && values.nat_log === "none" && (
              <p className="profile-footnote">
                Sem registro de NAT, um IP público com porta não leva a nenhum
                assinante e ofícios sobre esse CGNAT não podem ser respondidos.
                O Marco Civil exige guardar os registros de conexão por 1 ano:
                ligue o log de alocação de blocos no equipamento (no Hillstone,
                log na regra de NAT e envio ao syslog; no A10, arquivo de
                mapeamento de portas ou syslog).
              </p>
            )}
            {values.layout !== "netmap" && (
              <div className="erp-columns">
                <FormField label="Primeiro IP público usado (opcional)">
                  <Input
                    placeholder="Início do bloco"
                    value={values.public_first}
                    onChange={(event) =>
                      set("public_first", event.target.value)
                    }
                  />
                </FormField>
                <FormField label="Último IP público usado (opcional)">
                  <Input
                    placeholder="Fim do bloco"
                    value={values.public_last}
                    onChange={(event) => set("public_last", event.target.value)}
                  />
                </FormField>
              </div>
            )}
            <div className="erp-columns">
              <FormField label="Portas por assinante">
                <Input
                  type="number"
                  required
                  min={64}
                  max={32768}
                  value={values.ports_per_subscriber}
                  onChange={(event) =>
                    set("ports_per_subscriber", event.target.value)
                  }
                />
              </FormField>
              <FormField label="Primeira porta CGNAT">
                <Input
                  type="number"
                  required
                  min={1024}
                  max={65000}
                  value={values.port_start}
                  onChange={(event) => set("port_start", event.target.value)}
                />
              </FormField>
              <FormField label="Última porta usada (opcional)">
                <Input
                  type="number"
                  min={1087}
                  max={65535}
                  placeholder="65535"
                  value={values.port_end}
                  onChange={(event) => set("port_end", event.target.value)}
                />
              </FormField>
            </div>
            <ActionButton
              disabled={
                !values.name ||
                !values.private_pool_id ||
                !values.public_pool_id ||
                (values.layout === "external" && !values.nat_log)
              }
              onClick={async () => {
                setCapacity(null);
                setCapacity(
                  capacitySchema.parse(
                    await api("/cgnat/plans/check", { body: body() }),
                  ),
                );
              }}
            >
              Conferir capacidade CGNAT
            </ActionButton>
            {capacity && (
              <ProfileFacts
                items={[
                  ["Endereços privados", capacity.private_ips],
                  ["Endereços públicos", capacity.public_ips],
                  ["Assinantes por IP", capacity.ratio],
                  [
                    "Capacidade de endereços privados",
                    capacity.max_private_ips,
                  ],
                ]}
              />
            )}
          </MutationForm>
        </QueryBoundary>
      </DialogContent>
    </Dialog>
  );
}
function PlanMap({ plan, onClose }: { plan: Plan; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [lookup, setLookup] = useState<z.infer<typeof blockSchema> | null>(
    null,
  );
  const result = useSWR(["erp-cgnat-map", plan.id], async () =>
    z
      .object({ total: n, rows: z.array(blockSchema) })
      .parse(await api(`/cgnat/plans/${plan.id}/map?limit=512`)),
  );
  return (
    <Dialog
      open
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <DialogContent className="erp-editor">
        <DialogHeader>
          <DialogTitle>Mapa CGNAT · {plan.name}</DialogTitle>
          <DialogDescription>
            Até 512 endereços do mapa. O script exportado contém todas as
            regras.
          </DialogDescription>
        </DialogHeader>
        <MutationForm
          submit="Consultar IP no plano"
          onSubmit={async () => {
            setLookup(null);
            setLookup(
              blockSchema.parse(
                await api(
                  `/cgnat/plans/${plan.id}/lookup?private_ip=${encodeURIComponent(query.trim())}`,
                ),
              ),
            );
          }}
        >
          <FormField label="IP privado no plano">
            <Input
              required
              value={query}
              maxLength={15}
              onChange={(event) => {
                setQuery(event.target.value);
                setLookup(null);
              }}
            />
          </FormField>
        </MutationForm>
        {lookup && (
          <ProfileFacts
            items={[
              ["IP privado", lookup.private_ip],
              ["IP público", lookup.public_ip],
              ["Portas", `${lookup.port_start}–${lookup.port_end}`],
            ]}
          />
        )}
        <QueryBoundary
          loading={result.isLoading}
          error={result.error}
          retry={() => result.mutate()}
        >
          {result.data && (
            <OperationalCatalog
              title="Distribuição de portas"
              description={`${result.data.rows.length} de ${result.data.total} endereços.`}
              columns={["IP privado", "IP público", "Portas"]}
              rows={result.data.rows.map((row) => ({
                id: row.private_ip,
                cells: [
                  row.private_ip,
                  row.public_ip,
                  `${row.port_start}–${row.port_end}`,
                ],
              }))}
            />
          )}
        </QueryBoundary>
      </DialogContent>
    </Dialog>
  );
}
const holderSchema = z
  .object({
    contract_id: z.string().nullable().optional(),
    subscriber_name: z.string().nullable().optional(),
    started_at: z.string().optional(),
    stopped_at: z.string().nullable().optional(),
    session_key: z.string().optional(),
  })
  .passthrough();
const traceSchema = z.object({
  found: z.boolean(),
  note: z.string(),
  at: z.string().optional(),
  private_ip: z.string().optional(),
  public_ip: z.string().optional(),
  port_start: n.optional(),
  port_end: n.optional(),
  plan: z
    .object({ name: z.string(), retired_at: z.string().nullable() })
    .optional(),
  fixed_allocation: holderSchema.nullable().optional(),
  current_session: holderSchema
    .extend({ observed_at: z.string().nullable().optional() })
    .nullable()
    .optional(),
  holders_at: z.array(holderSchema).optional(),
  mapping: z
    .object({ label: z.string(), kind: z.string() })
    .passthrough()
    .optional(),
});
export function CgnatTrace() {
  const navigate = useNavigate();
  const [values, setValues] = useState({ ip: "", port: "", at: "" });
  const [result, setResult] = useState<z.infer<typeof traceSchema> | null>(
    null,
  );
  const holder = (item: z.infer<typeof holderSchema>) => (
    <>
      {item.contract_id ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate(`/contratos?contrato=${item.contract_id}`)}
        >
          {item.subscriber_name || "Abrir contrato"}
        </Button>
      ) : (
        item.subscriber_name || "Titular não informado"
      )}
    </>
  );
  return (
    <Panel
      title="Rastrear conexão CGNAT"
      description="IP público e porta identificam um IP privado no plano válido na data. A consulta fica na auditoria."
    >
      <MutationForm
        submit="Rastrear conexão"
        onSubmit={async () => {
          setResult(null);
          const query = new URLSearchParams({
            ip: values.ip.trim(),
            port: values.port,
            ...(values.at ? { at: new Date(values.at).toISOString() } : {}),
          });
          setResult(traceSchema.parse(await api(`/cgnat/trace?${query}`)));
        }}
      >
        <div className="erp-columns">
          <FormField label="IP público para rastreio">
            <Input
              required
              maxLength={15}
              value={values.ip}
              onChange={(event) =>
                setValues({ ...values, ip: event.target.value })
              }
            />
          </FormField>
          <FormField label="Porta de origem CGNAT">
            <Input
              type="number"
              required
              min={1}
              max={65535}
              value={values.port}
              onChange={(event) =>
                setValues({ ...values, port: event.target.value })
              }
            />
          </FormField>
          <FormField label="Instante do rastreio">
            <Input
              type="datetime-local"
              value={values.at}
              onChange={(event) =>
                setValues({ ...values, at: event.target.value })
              }
            />
          </FormField>
        </div>
      </MutationForm>
      {result && (
        <ProfileSection title="Resultado do rastreio">
          <p role="status">{result.note}</p>
          {result.found && (
            <>
              <ProfileFacts
                items={[
                  [
                    "Plano",
                    result.mapping
                      ? `Mapeamento importado · ${result.mapping.label}`
                      : `${result.plan?.name ?? "Não informado"}${result.plan?.retired_at ? " · encerrado" : ""}`,
                  ],
                  ["IP privado", result.private_ip ?? "Não informado"],
                  [
                    "IP público / portas",
                    `${result.public_ip}:${result.port_start}–${result.port_end}`,
                  ],
                  ["Data consultada", stamp(result.at ?? null)],
                ]}
              />
              <ProfileSection title="Titulares no instante consultado">
                {result.holders_at?.length ? (
                  result.holders_at.map((item, index) => (
                    <div key={item.session_key ?? index}>
                      {holder(item)}
                      <p className="profile-footnote">
                        {stamp(item.started_at ?? null)} →{" "}
                        {item.stopped_at
                          ? stamp(item.stopped_at)
                          : "Em andamento"}
                      </p>
                    </div>
                  ))
                ) : (
                  <p className="profile-footnote">
                    Nenhuma sessão histórica identifica titular neste instante.
                  </p>
                )}
              </ProfileSection>
              {result.fixed_allocation && (
                <ProfileSection title="Reserva fixa atual">
                  {holder(result.fixed_allocation)}
                  <p className="profile-footnote">
                    O cadastro atual precisa ser confrontado com os registros do
                    instante pesquisado.
                  </p>
                </ProfileSection>
              )}
              {result.current_session && (
                <ProfileSection title="Sessão observada atualmente">
                  {holder(result.current_session)}
                  <p className="profile-footnote">
                    Leitura {stamp(result.current_session.observed_at ?? null)}.
                    Esta sessão não comprova uso no passado.
                  </p>
                </ProfileSection>
              )}
            </>
          )}
        </ProfileSection>
      )}
    </Panel>
  );
}

const analysisSchema = z.object({
  vendor: z.string(),
  kind: z.string(),
  rules: z.array(z.unknown()),
  suggestions: z.array(
    z
      .object({
        private_cidr: z.string().optional(),
        public_cidr: z.string().optional(),
        port_start: n.optional(),
        port_end: n.optional(),
        ports_per_subscriber: n.optional(),
        layout: z.string(),
        nat_log: z.string().optional(),
        nat_log_detail: z.string().optional(),
        rules: n,
      })
      .passthrough(),
  ),
  traceable_by_config: z.boolean(),
  warnings: z.array(z.string()),
});
const batchSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(["config", "log", "mapping_file", "csv"]),
  label: z.string(),
  lines: n,
  accepted: n,
  rejected: n,
  created_at: z.string(),
  first_at: z.string().nullable(),
  last_at: z.string().nullable(),
});
const importKinds: Record<z.infer<typeof batchSchema>["kind"], string> = {
  config: "Regras da configuração (MikroTik netmap)",
  log: "Registro de NAT (alocação de bloco)",
  mapping_file: "Arquivo de mapeamento do A10",
  csv: "Planilha (private_ip, public_ip, port_start, port_end, start, end)",
};
const analysisKinds: Record<string, string> = {
  deterministic: "Determinístico: o titular sai das regras",
  dynamic_block: "Bloco fixo atribuído dinamicamente: depende do registro de NAT",
  deterministic_offset: "Determinístico com deslocamento aleatório: depende do arquivo de mapeamento",
  dynamic: "Dinâmico: depende do registro de NAT",
  none: "Nenhuma regra de CGNAT reconhecida",
};

/** Migração de CGNAT: lê a configuração do equipamento atual e importa regras exatas ou registros de NAT para os ofícios. */
function CgnatImport() {
  const batches = useSWR("erp-cgnat-mapping-batches", async () =>
    z.array(batchSchema).parse(await api("/cgnat/mappings/batches")),
  );
  const [values, setValues] = useState({
    kind: "config" as z.infer<typeof batchSchema>["kind"],
    label: "",
    text: "",
    valid_from: "",
  });
  const [analysis, setAnalysis] = useState<z.infer<
    typeof analysisSchema
  > | null>(null);
  const [imported, setImported] = useState<string | null>(null);
  return (
    <Panel
      title="Importar do equipamento de CGNAT"
      description="Para migrar de outro sistema: cole a configuração (MikroTik, Hillstone ou A10) para ver como o titular é identificado, e importe as regras exatas ou o registro de NAT para responder ofícios."
    >
      <MutationForm
        submit="Importar mapeamentos"
        onSubmit={async () => {
          setImported(null);
          const result = z
            .object({ batch: batchSchema.partial() })
            .passthrough()
            .parse(
              await api("/cgnat/mappings", {
                body: {
                  kind: values.kind,
                  label: values.label.trim(),
                  text: values.text,
                  ...(values.valid_from
                    ? { valid_from: new Date(values.valid_from).toISOString() }
                    : {}),
                },
              }),
            );
          setImported(
            `${result.batch.accepted ?? 0} mapeamento(s) importado(s), ${result.batch.rejected ?? 0} linha(s) rejeitada(s).`,
          );
          await batches.mutate();
        }}
      >
        <div className="erp-columns">
          <FormField label="Origem">
            <select
              aria-label="Origem dos mapeamentos"
              value={values.kind}
              onChange={(event) =>
                setValues({
                  ...values,
                  kind: event.target.value as typeof values.kind,
                })
              }
            >
              {Object.entries(importKinds).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Identificação do lote">
            <Input
              required
              maxLength={120}
              placeholder="Ex.: CGNAT do POP Centro · novembro"
              value={values.label}
              onChange={(event) =>
                setValues({ ...values, label: event.target.value })
              }
            />
          </FormField>
          {values.kind === "mapping_file" && (
            <FormField label="Vale a partir de">
              <Input
                type="datetime-local"
                required
                value={values.valid_from}
                onChange={(event) =>
                  setValues({ ...values, valid_from: event.target.value })
                }
              />
            </FormField>
          )}
        </div>
        <FormField label="Conteúdo (configuração, registro ou planilha)">
          <Textarea
            required
            rows={8}
            spellCheck={false}
            value={values.text}
            onChange={(event) =>
              setValues({ ...values, text: event.target.value })
            }
          />
        </FormField>
      </MutationForm>
      <div className="erp-inline-actions">
        <ActionButton
          disabled={values.text.trim().length < 10}
          onClick={async () => {
            setAnalysis(
              analysisSchema.parse(
                await api("/cgnat/analyze", { body: { config: values.text } }),
              ),
            );
          }}
        >
          Analisar configuração
        </ActionButton>
      </div>
      {imported && <p role="status">{imported}</p>}
      {analysis && (
        <ProfileSection title="Como este CGNAT identifica o titular">
          <ProfileFacts
            items={[
              ["Equipamento", analysis.vendor],
              ["Tipo", analysisKinds[analysis.kind] ?? analysis.kind],
              ["Regras exatas lidas", String(analysis.rules.length)],
            ]}
          />
          {analysis.suggestions.length > 0 && (
            <OperationalCatalog
              title="Planos sugeridos"
              description="Confira e cadastre como plano de CGNAT; blocos fora de ordem ficam só como regras importadas."
              columns={["Privado → público", "Portas", "Formato", "Registro de NAT"]}
              rows={analysis.suggestions.map((item, index) => ({
                id: String(index),
                cells: [
                  item.private_cidr && item.public_cidr
                    ? `${item.private_cidr} → ${item.public_cidr}`
                    : "Pool do equipamento",
                  item.ports_per_subscriber
                    ? `${item.ports_per_subscriber} por assinante · ${item.port_start ?? "?"}–${item.port_end ?? "?"}`
                    : "Não informado",
                  layoutLabels[item.layout as Plan["layout"]] ?? item.layout,
                  item.nat_log
                    ? `${natLogLabels[item.nat_log as NonNullable<Plan["nat_log"]>] ?? item.nat_log}${item.nat_log_detail ? ` · ${item.nat_log_detail}` : ""}`
                    : "Não se aplica",
                ],
              }))}
            />
          )}
          {analysis.warnings.map((warning) => (
            <p key={warning} className="profile-footnote">
              {warning}
            </p>
          ))}
        </ProfileSection>
      )}
      <QueryBoundary
        loading={batches.isLoading}
        error={batches.error}
        retry={() => batches.mutate()}
      >
        <OperationalCatalog
          title="Mapeamentos importados"
          description="Usados pelo rastreio quando nenhum plano calcula o titular. Apagar um lote tira esses mapeamentos das consultas."
          columns={["Lote", "Origem", "Mapeamentos", "Período coberto", "Importado em"]}
          rows={(batches.data ?? []).map((batch) => ({
            id: batch.id,
            cells: [
              batch.label,
              importKinds[batch.kind],
              <>
                {batch.accepted}
                {batch.rejected > 0 && (
                  <small className="table-subline">{`${batch.rejected} linha(s) rejeitada(s)`}</small>
                )}
              </>,
              batch.first_at
                ? `${stamp(batch.first_at)} → ${stamp(batch.last_at)}`
                : "Enquanto a configuração valer",
              stamp(batch.created_at),
            ],
            actions: (
              <ActionButton
                danger
                label={`Apagar o lote ${batch.label}`}
                confirm="Apagar o lote? Os ofícios deixam de usar esses mapeamentos."
                onClick={async () => {
                  await api(`/cgnat/mappings/batches/${batch.id}`, {
                    method: "DELETE",
                  });
                  await batches.mutate();
                }}
              >
                Apagar
              </ActionButton>
            ),
          }))}
        />
      </QueryBoundary>
    </Panel>
  );
}
