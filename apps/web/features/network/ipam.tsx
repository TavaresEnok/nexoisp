import { useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { z } from "zod";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { Network, Users, Workflow, Shield } from "lucide-react";
import { CoreNetworkFrame } from "@/components/core-network";
import { coreTabs } from "./core-tabs";
import { OpticalMetrics } from "@/components/optical-ui";
import { OperationalCatalog } from "@/components/operational-catalog";
import {
  ProfileSection,
  ProfileFacts,
} from "@/components/subscriber-profile-sections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { QueryBoundary } from "@/features/shared/feedback";
import { RecordEditor } from "@/features/shared/record-editor";
import { MutationForm, FormField } from "@/features/shared/form";
import { ActionButton } from "@/features/shared/action";
import { can } from "@/features/session/model";
import { useSession } from "@/features/session/provider";
import { api } from "@/platform/erp-client";
import { normalize } from "@/lib/format";
import { stamp } from "./models";
import { useDevices } from "./queries";
import styles from "@/components/technical.module.css";
import { useCreateRequest } from "@/features/shared/create-request";
export const poolSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  cidr: z.string(),
  kind: z.string(),
  family: z.number(),
  device_id: z.string().nullable(),
  device_name: z.string().nullable(),
  notes: z.string().nullable(),
  delegation_len: z.number().nullable(),
  allocated: z.coerce.number(),
  size: z.coerce.number().nullable(),
  cgnat_plan_id: z.string().nullable(),
});
export type AddressPool = z.infer<typeof poolSchema>;
const allocationSchema = z.object({
  id: z.string().uuid(),
  address: z.string(),
  contract_id: z.string().nullable(),
  subscriber_name: z.string().nullable(),
  description: z.string().nullable(),
  created_at: z.string(),
  created_by_name: z.string().nullable(),
});
const delegationSchema = z.object({
  id: z.string().uuid(),
  prefix: z.string(),
  contract_id: z.string().uuid(),
  subscriber_name: z.string(),
  created_at: z.string(),
});
const kinds: Record<string, string> = {
  public: "Público",
  cgnat: "CGNAT · assinantes",
  private: "Privado",
  management: "Gerência",
};
export function useIpamRefresh() {
  const { mutate } = useSWRConfig();
  return () =>
    mutate(
      (key) =>
        ["erp-pools", "erp-cgnat-plans"].includes(String(key)) ||
        (Array.isArray(key) &&
          [
            "erp-allocations",
            "erp-delegations",
            "erp-contract-ips",
            "erp-contract-ipv6",
            "erp-service",
            "erp-operations",
            "erp-contract-states",
          ].includes(key[0])),
    );
}
export function AddressDirectory() {
  const { me } = useSession();
  const navigate = useNavigate();
  const result = useSWR("erp-pools", async () =>
    z.array(poolSchema).parse(await api("/ipam/pools")),
  );
  const [editor, setEditor] = useState<AddressPool | "create" | null>(null);
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const refresh = useIpamRefresh();
  const pools = result.data ?? [];
  const write = can(me, "network:write");
  useCreateRequest("bloco", () => setEditor("create"), write);
  const selected = pools.find((p) => p.id === params.get("bloco"));
  const rows = pools.filter((pool) =>
    normalize(`${pool.name} ${pool.cidr} ${pool.device_name ?? ""}`).includes(
      normalize(query),
    ),
  );
  const open = (id: string) =>
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      next.set("bloco", id);
      return next;
    });
  const close = () =>
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.delete("bloco");
        return next;
      },
      { replace: true },
    );
  return (
    <CoreNetworkFrame
      tab="pools"
      tabs={coreTabs(me)}
      onTab={navigate}
      description="Blocos IPv4 e IPv6, reservas individuais e prefixos dos contratos."
      actions={
        <>
          <Button
            variant="outline"
            onClick={() => navigate("/rede/consulta-ip")}
          >
            Consulta legal de IP
          </Button>
          {write && (
            <Button onClick={() => setEditor("create")}>
              Novo bloco de endereços
            </Button>
          )}
        </>
      }
      metrics={
        <OpticalMetrics
          items={[
            {
              label: "Blocos IPv4",
              value: pools.filter((p) => p.family === 4).length,
              detail: "CIDRs cadastrados",
              icon: Network,
            },
            {
              label: "Blocos IPv6",
              value: pools.filter((p) => p.family === 6).length,
              detail: "Registro de endereços e prefixos",
              icon: Workflow,
            },
            {
              label: "Reservas registradas",
              value: pools.reduce((sum, p) => sum + p.allocated, 0),
              detail: "Conforme a contagem do servidor",
              icon: Users,
            },
            {
              label: "Blocos em CGNAT",
              value: pools.filter((p) => p.cgnat_plan_id).length,
              detail: "Com plano de tradução de portas",
              icon: Shield,
            },
          ]}
        />
      }
    >
      <QueryBoundary
        loading={result.isLoading}
        error={result.error}
        retry={() => result.mutate()}
      >
        <OperationalCatalog
          title="Blocos de endereços"
          description="O prefixo reservado é entregue como Delegated-IPv6-Prefix no próximo provisionamento pelo RADIUS integrado ou pelo agente 0.6.0 ou superior."
          columns={[
            "Bloco / nome",
            "Tipo",
            "Equipamento",
            "Alocados",
            "Tamanho",
          ]}
          query={query}
          setQuery={setQuery}
          rows={rows.map((pool) => ({
            id: pool.id,
            cells: [
              <>
                <strong>{pool.cidr}</strong>
                <small className="table-subline">{pool.name}</small>
              </>,
              <>
                {kinds[pool.kind] ?? pool.kind}
                {pool.cgnat_plan_id && (
                  <Badge variant="outline">Em CGNAT</Badge>
                )}
              </>,
              pool.device_name || "Não informado",
              pool.allocated,
              pool.size == null
                ? "Não informado"
                : pool.size.toLocaleString("pt-BR"),
            ],
            actions: (
              <div className="erp-inline-actions">
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={`Reservas de ${pool.name}`}
                  onClick={() => open(pool.id)}
                >
                  {pool.delegation_len
                    ? `Prefixos /${pool.delegation_len}`
                    : "Endereços"}
                </Button>
                {write && (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={`Editar bloco ${pool.name}`}
                      onClick={() => setEditor(pool)}
                    >
                      Editar
                    </Button>
                    <ActionButton
                      danger
                      confirm={`Excluir o bloco ${pool.cidr}? O servidor verifica as reservas e os planos associados.`}
                      onClick={async () => {
                        await api(`/ipam/pools/${pool.id}`, {
                          method: "DELETE",
                        });
                        await refresh();
                      }}
                    >
                      Excluir bloco
                    </ActionButton>
                  </>
                )}
              </div>
            ),
          }))}
        />
      </QueryBoundary>
      {editor && (
        <PoolEditor
          pool={editor === "create" ? undefined : editor}
          onClose={() => setEditor(null)}
          onDone={async () => {
            setEditor(null);
            await refresh();
          }}
        />
      )}
      {selected && <PoolReservations pool={selected} onClose={close} />}
    </CoreNetworkFrame>
  );
}
function PoolEditor({
  pool,
  onClose,
  onDone,
}: {
  pool?: AddressPool;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const devices = useDevices();
  return (
    <RecordEditor
      title={pool ? "Editar bloco de endereços" : "Novo bloco de endereços"}
      description={
        pool
          ? "Nome, equipamento e observações podem ser atualizados. CIDR, finalidade e comprimento da delegação permanecem no cadastro original."
          : "Informe o endereço de rede em CIDR. O servidor valida sobreposição, finalidade e tamanho."
      }
      loading={devices.isLoading}
      error={devices.error}
      retry={() => devices.mutate()}
      initial={{
        name: pool?.name ?? "",
        cidr: "",
        kind: "cgnat",
        device_id: pool?.device_id ?? "",
        delegation_len: "",
        notes: pool?.notes ?? "",
      }}
      fields={[
        { key: "name", label: "Nome do bloco", required: true, maxLength: 80 },
        ...(!pool
          ? [
              {
                key: "cidr",
                label: "Bloco em CIDR",
                required: true,
                maxLength: 49,
              },
              {
                key: "kind",
                label: "Finalidade do bloco",
                type: "select" as const,
                options: Object.entries(kinds).map(([value, label]) => ({
                  value,
                  label,
                })),
              },
              {
                key: "delegation_len",
                label: "Prefixo delegado por contrato",
                type: "number" as const,
                min: 48,
                max: 64,
                when: (v: Record<string, string>) => v.cidr.includes(":"),
                hint: "De /48 a /64. Em branco, registra somente endereços individuais.",
              },
            ]
          : []),
        {
          key: "device_id",
          label: "Equipamento do bloco",
          type: "select",
          options: [
            { value: "", label: "Sem equipamento específico" },
            ...(devices.data ?? []).map((d) => ({
              value: d.id,
              label: d.name,
            })),
          ],
        },
        {
          key: "notes",
          label: "Observações do bloco",
          type: "textarea",
          maxLength: 500,
        },
      ]}
      onClose={onClose}
      onSubmit={async (values) => {
        await api(pool ? `/ipam/pools/${pool.id}` : "/ipam/pools", {
          method: pool ? "PATCH" : "POST",
          body: {
            name: values.name,
            device_id: values.device_id || null,
            notes: values.notes || null,
            ...(!pool
              ? {
                  cidr: values.cidr,
                  kind: values.kind,
                  delegation_len:
                    values.cidr.includes(":") && values.delegation_len
                      ? Number(values.delegation_len)
                      : null,
                }
              : {}),
          },
        });
        await onDone();
      }}
    />
  );
}
function PoolReservations({
  pool,
  onClose,
}: {
  pool: AddressPool;
  onClose: () => void;
}) {
  const { me } = useSession();
  const navigate = useNavigate();
  const refresh = useIpamRefresh();
  const delegated = pool.delegation_len !== null;
  const endpoint = `/ipam/pools/${pool.id}/${delegated ? "delegations" : "allocations"}`;
  const result = useSWR(
    [delegated ? "erp-delegations" : "erp-allocations", pool.id],
    async () =>
      delegated
        ? z.array(delegationSchema).parse(await api(endpoint))
        : z.array(allocationSchema).parse(await api(endpoint)),
  );
  const [creating, setCreating] = useState(false);
  const [networkNote, setNetworkNote] = useState<string | null>(null);
  const write = can(me, "network:write");
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="ticket-sheet">
        <SheetHeader>
          <SheetTitle>
            {pool.name} · {delegated ? "prefixos" : "endereços"}
          </SheetTitle>
          <SheetDescription>
            {pool.cidr} ·{" "}
            {delegated
              ? "Prefixo delegado ao roteador do assinante (DHCPv6-PD). No RADIUS integrado, reaplique o acesso para entregar; concentradores por agente exigem configuração da equipe."
              : "IPs fixos devem ficar fora da faixa dinâmica configurada no NAS."}
          </SheetDescription>
        </SheetHeader>
        <div className="sheet-content-body erp-stack">
          {write && (
            <Button onClick={() => setCreating(true)}>
              {delegated ? "Delegar prefixo" : "Reservar endereço"}
            </Button>
          )}
          {networkNote && <p role="status">{networkNote}</p>}
          <QueryBoundary
            loading={result.isLoading}
            error={result.error}
            retry={() => result.mutate()}
          >
            <OperationalCatalog
              title={delegated ? "Prefixos reservados" : "Endereços reservados"}
              description={
                delegated
                  ? "Não configura o RADIUS nem anuncia prefixos na rede."
                  : "Alterações de IP fixo podem solicitar reaplicação no acesso; a resposta do servidor informa o efeito."
              }
              columns={[
                "Endereço / prefixo",
                "Contrato / reserva",
                "Descrição",
                "Registrado em",
              ]}
              rows={(result.data ?? []).map((row) => ({
                id: row.id,
                cells: [
                  "prefix" in row ? row.prefix : row.address,
                  row.contract_id ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        onClose();
                        navigate(`/contratos?contrato=${row.contract_id}`);
                      }}
                    >
                      {row.subscriber_name || "Abrir contrato"}
                    </Button>
                  ) : (
                    "Reserva sem contrato"
                  ),
                  "description" in row
                    ? row.description || "—"
                    : "Prefixo delegado",
                  stamp(row.created_at),
                ],
                actions: write && (
                  <ActionButton
                    danger
                    confirm={`Liberar ${"prefix" in row ? row.prefix : row.address}?`}
                    onClick={async () => {
                      const response = await api<{
                        network?: { note: string };
                      }>(
                        `/ipam/${delegated ? "delegations" : "allocations"}/${row.id}`,
                        { method: "DELETE" },
                      );
                      setNetworkNote(
                        response.network?.note ??
                          (delegated
                            ? "Prefixo liberado no cadastro."
                            : "Endereço liberado no cadastro."),
                      );
                      await refresh();
                    }}
                  >
                    Liberar reserva
                  </ActionButton>
                ),
              }))}
            />
          </QueryBoundary>
        </div>
        {creating && (
          <ReservationEditor
            pool={pool}
            onClose={() => setCreating(false)}
            onDone={async (note) => {
              setNetworkNote(note);
              setCreating(false);
              await refresh();
            }}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}
function ReservationEditor({
  pool,
  onClose,
  onDone,
}: {
  pool: AddressPool;
  onClose: () => void;
  onDone: (note: string) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [contract, setContract] = useState("");
  const [address, setAddress] = useState("");
  const [description, setDescription] = useState("");
  const delegated = pool.delegation_len !== null;
  const contracts = useSWR(
    query.trim().length >= 2 ? ["erp-ipam-contract-pick", query.trim()] : null,
    ([, q]) =>
      api<{ id: string; subscriber_name: string; plan_name: string }[]>(
        `/contracts?status=active&limit=20&q=${encodeURIComponent(q)}`,
      ),
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
            {delegated ? "Delegar prefixo IPv6" : "Reservar endereço IP"}
          </DialogTitle>
          <DialogDescription>
            {pool.cidr} · em branco, o servidor escolhe a primeira posição
            disponível.
          </DialogDescription>
        </DialogHeader>
        <MutationForm
          onCancel={onClose}
          onSubmit={async () => {
            if (!contract && (delegated || !description.trim()))
              throw new Error(
                delegated
                  ? "Selecione um contrato."
                  : "Informe a descrição da reserva sem contrato.",
              );
            const response = await api<{ network?: { note: string } }>(
              `/ipam/pools/${pool.id}/${delegated ? "delegations" : "allocations"}`,
              {
                body: {
                  contract_id: contract || null,
                  ...(delegated
                    ? { prefix: address.trim() || null }
                    : {
                        address: address.trim() || null,
                        description: description.trim() || null,
                      }),
                },
              },
            );
            await onDone(
              response.network?.note ??
                (delegated
                  ? "Prefixo reservado no cadastro. A configuração do NAS é manual."
                  : "Endereço reservado no cadastro."),
            );
          }}
        >
          <FormField label="Buscar contrato para a reserva">
            <Input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setContract("");
              }}
            />
          </FormField>
          <FormField label="Contrato da reserva">
            <select
              required={delegated}
              className="commercial-select"
              value={contract}
              onChange={(event) => setContract(event.target.value)}
            >
              <option value="">
                {delegated ? "Selecione um contrato" : "Reserva sem contrato"}
              </option>
              {contracts.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.subscriber_name} · {c.plan_name} · {c.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </FormField>
          <QueryBoundary
            loading={contracts.isLoading}
            error={contracts.error}
            retry={() => contracts.mutate()}
          >
            {null}
          </QueryBoundary>
          <FormField
            label={
              delegated ? "Prefixo IPv6 reservado" : "Endereço IP reservado"
            }
            hint="Em branco: primeiro livre no bloco."
          >
            <Input
              value={address}
              maxLength={49}
              onChange={(event) => setAddress(event.target.value)}
            />
          </FormField>
          {!delegated && (
            <FormField label="Descrição da reserva">
              <Input
                required={!contract}
                maxLength={200}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </FormField>
          )}
        </MutationForm>
      </DialogContent>
    </Dialog>
  );
}
export function ContractAddresses({ id }: { id: string }) {
  const ips = useSWR(["erp-contract-ips", id], () =>
    api<{ id: string; address: string; pool_name: string }[]>(
      `/contracts/${id}/ips`,
    ),
  );
  const v6 = useSWR(["erp-contract-ipv6", id], () =>
    api<{ delegation: { prefix: string } | null }>(`/contracts/${id}/ipv6`),
  );
  return (
    <ProfileSection
      title="Endereços do contrato"
      caption="Reservas cadastrais e endereços fixos. O próximo provisionamento entrega o prefixo IPv6 pelo RADIUS integrado ou agente 0.6.0+."
    >
      <QueryBoundary
        loading={ips.isLoading || v6.isLoading}
        error={ips.error || v6.error}
        retry={() => Promise.all([ips.mutate(), v6.mutate()])}
      >
        <ProfileFacts
          items={[
            ...(ips.data ?? []).map(
              (row) => [row.address, row.pool_name] as [string, string],
            ),
            [
              "Prefixo IPv6",
              v6.data?.delegation?.prefix || "Nenhum prefixo reservado",
            ],
          ]}
        />
        {!ips.data?.length && (
          <p className="profile-footnote">
            Sem endereço fixo reservado; consulte o estado observado para o IP
            dinâmico.
          </p>
        )}
        <Link className="profile-text-action" to="/rede/enderecos-ip">
          Gerenciar reservas
        </Link>
      </QueryBoundary>
    </ProfileSection>
  );
}
