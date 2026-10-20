import { useState } from "react";
import useSWR from "swr";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Activity, Network, Server, AlertTriangle } from "lucide-react";
import { PageHeading } from "@/components/workspace-ui";
import {
  NetworkEquipmentTable,
  NetworkTopGrid,
} from "@/components/network-center";
import { EmptyState } from "@/components/workspace-feedback";
import { Button } from "@/components/ui/button";
import { QueryBoundary, ConnectedNotice } from "@/features/shared/feedback";
import { useSession } from "@/features/session/provider";
import { can } from "@/features/session/model";
import { canAccessPath } from "@/features/operations/navigation";
import { useQueryState } from "@/lib/use-query-state";
import { normalize } from "@/lib/format";
import { api } from "@/platform/erp-client";
import { useDevices } from "./queries";
import { projectDevice, healthSchema } from "./models";
import { RadiusActions, RadiusOverview } from "./radius";
import { AgentDirectory } from "./agents";
import { DeviceCreator, DeviceDetails } from "./devices";
export function NetworkDirectory() {
  const { me } = useSession();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const devices = useDevices();
  const health = useSWR(
    "erp-network-health",
    async () => healthSchema.parse(await api("/network/health")),
    { refreshInterval: 5000 },
  );
  const [creating, setCreating] = useState(false);
  const statuses = [
    "Todos",
    "Operacional",
    "Atenção",
    "Não verificado",
    "Manutenção",
  ];
  const [filter, setFilter] = useQueryState("situacao", "Todos", statuses);
  const [query, setQuery] = useQueryState("busca", "");
  const selected = devices.data?.find(
    (device) => device.id === params.get("equipamento"),
  );
  const online = useSWR(
    "erp-online-summary",
    async () =>
      (
        await api<{ rows: { nas: string; pop: string | null }[] }>(
          "/network/online?q=",
        )
      ).rows,
    { refreshInterval: 30000 },
  );
  const byNas = Object.entries(
    (online.data ?? []).reduce<Record<string, { pop: string | null }[]>>(
      (groups, row) => {
        (groups[row.nas] ??= []).push(row);
        return groups;
      },
      {},
    ),
  ).sort((a, b) => b[1].length - a[1].length);
  const rows = (devices.data ?? [])
    .map(projectDevice)
    .filter(
      (device) =>
        (filter === "Todos" || device.status === filter) &&
        normalize(
          `${device.name} ${device.ip} ${device.type} ${device.vendor}`,
        ).includes(normalize(query.trim())),
    );
  const close = () => {
    const next = new URLSearchParams(params);
    next.delete("equipamento");
    setParams(next, { replace: true });
  };
  return (
    <>
      <ConnectedNotice demo={me?.demo} />
      <PageHeading
        title="Monitoramento de rede"
        description="Disponibilidade, equipamentos e impacto no assinante em uma visão só."
        actions={
          can(me, "network:write") && (
            <Button onClick={() => setCreating(true)}>Novo equipamento</Button>
          )
        }
      />
      <QueryBoundary
        loading={health.isLoading}
        error={health.error}
        retry={() => health.mutate()}
      >
        {health.data && (
          <div className="metrics-grid">
            {[
              {
                title: "Agentes offline",
                value: `${health.data.agents_offline} / ${health.data.agents}`,
                detail: "Conforme o último contato recebido",
                icon: Server,
              },
              {
                title: "Operações incertas",
                value: health.data.uncertain,
                detail: "Verificar evidências antes de repetir",
                icon: AlertTriangle,
              },
              {
                title: "Falhas e expirações",
                value: health.data.failed_recent,
                detail: "Últimos sete dias",
                icon: Activity,
              },
              {
                title: "Divergências de estado",
                value: health.data.drift,
                detail: `${health.data.in_progress} em andamento${health.data.oldest_pending_s == null ? "" : ` · fila mais antiga: ${health.data.oldest_pending_s}s`}`,
                icon: Network,
              },
            ].map((metric) => (
              <div className="metric-card" key={metric.title}>
                <div className="metric-heading">
                  <span>{metric.title}</span>
                  <metric.icon size={17} />
                </div>
                <div className="metric-main">
                  <strong>{metric.value}</strong>
                </div>
                <p>{metric.detail}</p>
              </div>
            ))}
          </div>
        )}
      </QueryBoundary>
      <NetworkTopGrid
        chart={{
          title: "De ponta a ponta",
          description:
            "Sessões online por concentrador · último accounting recebido",
          label: "Sessões online",
          unit: "",
          rows: byNas.map(([name, rows]) => ({ name, value: rows.length })),
          empty: (
            <EmptyState
              icon={Network}
              title={
                online.isLoading
                  ? "Consultando sessões…"
                  : "Nenhuma sessão online registrada"
              }
              description="O gráfico usa o accounting recebido dos concentradores."
            />
          ),
        }}
        concentrators={{
          title: "Sessões por concentrador",
          description: "Participação de cada concentrador nas sessões online",
          rows: byNas.map(([name, rows]) => ({
            id: name,
            name,
            sessions: rows.length,
            total: online.data?.length ?? 0,
            pop: rows[0]?.pop || "POP não informado",
            note: "das sessões online",
            onClick: () =>
              navigate(`/rede/online?busca=${encodeURIComponent(name)}`),
          })),
          empty: (
            <EmptyState
              icon={Server}
              title="Nenhum concentrador com sessão"
              description="Concentradores aparecem aqui quando enviam accounting."
            />
          ),
        }}
      />
      <div className="erp-stack">
        <RadiusOverview />
        <QueryBoundary
          loading={devices.isLoading}
          error={devices.error}
          retry={() => devices.mutate()}
        >
          <NetworkEquipmentTable
            operational
            statusOptions={statuses}
            rows={rows}
            filter={filter}
            setFilter={setFilter}
            query={query}
            setQuery={setQuery}
            onOpen={(node) => {
              const next = new URLSearchParams(params);
              next.set("equipamento", node.id);
              setParams(next);
            }}
            actions={
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigate("/rede/operacoes")}
              >
                Operações de rede
              </Button>
            }
          />
        </QueryBoundary>
        <AgentDirectory />
      </div>
      {creating && <DeviceCreator onClose={() => setCreating(false)} />}
      {selected && (
        <DeviceDetails
          key={selected.id}
          device={selected}
          onClose={close}
          extra={
            can(me, "network:write") &&
            ["radius", "demo", "mikrotik_radius"].includes(selected.driver) && (
              <RadiusActions device={selected} />
            )
          }
        />
      )}
    </>
  );
}
