import { useState } from "react";
import useSWR from "swr";
import { z } from "zod";
import { useNavigate } from "react-router-dom";
import { PageHeading, Panel } from "@/components/workspace-ui";
import { OperationalCatalog } from "@/components/operational-catalog";
import {
  ProfileFacts,
  ProfileSection,
} from "@/components/subscriber-profile-sections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  created_at: z.string(),
  created_by_name: z.string().nullable(),
  retired_at: z.string().nullable(),
  capacity: capacitySchema,
});
type Plan = z.infer<typeof planSchema>;
const blockSchema = z.object({
  private_ip: z.string(),
  public_ip: z.string(),
  port_start: n,
  port_end: n,
});
export function CgnatDirectory() {
  const { me } = useSession();
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
  return (
    <div className={styles.page}>
      <PageHeading
        eyebrow="REDE / FTTx · CORE NETWORK"
        title="Planos de CGNAT"
        description="Planejamento de endereços e portas com cálculo e rastreio no Go."
        actions={
          write && (
            <Button onClick={() => setCreating(true)}>
              Novo plano de CGNAT
            </Button>
          )
        }
      />
      <p className="profile-footnote">
        O script RouterOS exige revisão e aplicação manual pela equipe de rede.
        O backend não aplica regras ao equipamento; a validação existente é de
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
              `${plan.private_cidr} → ${plan.public_cidr}`,
              plan.ports_per_subscriber,
              plan.capacity.ratio,
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
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={`Mapa de ${plan.name}`}
                  onClick={() => setMapped(plan)}
                >
                  Mapa
                </Button>
                {write && (
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
    </div>
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
    ports_per_subscriber: "2000",
    port_start: "1024",
  });
  const [capacity, setCapacity] = useState<z.infer<
    typeof capacitySchema
  > | null>(null);
  const body = () => ({
    ...values,
    ports_per_subscriber: Number(values.ports_per_subscriber),
    port_start: Number(values.port_start),
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
            O Go calcula a capacidade e impede sobreposição de planos ativos.
            Nada é aplicado ao NAS automaticamente.
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
            </div>
            <ActionButton
              disabled={
                !values.name ||
                !values.private_pool_id ||
                !values.public_pool_id
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
                    `${result.plan?.name ?? "Não informado"}${result.plan?.retired_at ? " · encerrado" : ""}`,
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
