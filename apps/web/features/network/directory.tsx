// Rede › Concentradores e agentes. As OLTs têm página própria (Rede › OLTs).
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { PageHeading, Panel, Status } from "@/components/workspace-ui";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { QueryBoundary } from "@/features/shared/feedback";
import { useSession } from "@/features/session/provider";
import { can } from "@/features/session/model";
import { useCreateRequest } from "@/features/shared/create-request";
import { useDevices } from "./queries";
import { drivers, vendors } from "./models";
import {
  ConcentratorCreator,
  RadiusActions,
  RadiusOverview,
  useRadiusEnabled,
} from "./radius";
import { AgentDirectory } from "./agents";
import { DeviceCreator, DeviceDetails } from "./devices";
import { deviceStatus, isOlt } from "./olts";
import { ago, PageTabs, useSessions } from "./kit";

const tabs = [
  {
    value: "concentradores",
    label: "Concentradores",
    href: "/rede/equipamentos",
  },
  {
    value: "agentes",
    label: "Agentes",
    href: "/rede/equipamentos?aba=agentes",
  },
  {
    value: "radius",
    label: "Autenticação",
    href: "/rede/equipamentos?aba=radius",
  },
];

export function NetworkDirectory() {
  const { me } = useSession();
  const [params, setParams] = useSearchParams();
  const devices = useDevices();
  const sessions = useSessions();
  const radiusEnabled = useRadiusEnabled();
  const [creating, setCreating] = useState<"radius" | "api" | null>(null);
  const write = can(me, "network:write");
  useCreateRequest(
    "concentrador",
    () => setCreating("radius"),
    write && radiusEnabled,
  );
  useCreateRequest("equipamento", () => setCreating("api"), write);
  const tab = tabs.some((t) => t.value === params.get("aba"))
    ? params.get("aba")!
    : "concentradores";
  const all = devices.data ?? [];
  const rows = all.filter((d) => !isOlt(d));
  const selected = all.find((d) => d.id === params.get("equipamento"));
  const online = new Map<string, number>();
  for (const s of sessions.data ?? [])
    if (s.nas) online.set(s.nas, (online.get(s.nas) ?? 0) + 1);
  const close = () =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete("equipamento");
        return next;
      },
      { replace: true },
    );
  return (
    <>
      <PageHeading
        title="Concentradores e agentes"
        description="Onde os clientes autenticam e quem fala com os equipamentos."
        actions={
          write && (
            <>
              <Button variant="outline" onClick={() => setCreating("api")}>
                Equipamento por API
              </Button>
              <Button
                disabled={!radiusEnabled}
                onClick={() => setCreating("radius")}
              >
                Novo concentrador
              </Button>
            </>
          )
        }
      />
      <PageTabs value={tab} tabs={tabs} />
      {tab === "concentradores" && (
        <Panel
          title="Concentradores"
          description={`${rows.length} equipamento(s)`}
        >
          <QueryBoundary
            loading={devices.isLoading}
            error={devices.error}
            retry={() => devices.mutate()}
          >
            {rows.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    {[
                      "Concentrador",
                      "Conexão",
                      "Online",
                      "Contas",
                      "Contato",
                      "Situação",
                    ].map((label) => (
                      <TableHead key={label}>{label}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((d) => (
                    <TableRow
                      key={d.id}
                      className="cursor-pointer"
                      onClick={() =>
                        setParams((current) => {
                          const next = new URLSearchParams(current);
                          next.set("equipamento", d.id);
                          return next;
                        })
                      }
                    >
                      <TableCell>
                        <span className="font-medium">{d.name}</span>
                        <small className="table-subline">
                          {d.driver === "radius"
                            ? `Autenticação integrada · ${vendors[d.vendor ?? ""] ?? d.vendor ?? "RADIUS"}`
                            : (drivers[d.driver] ?? d.driver)}
                        </small>
                      </TableCell>
                      <TableCell>
                        <span className="mono">
                          {d.nas_ip ?? d.host ?? "—"}
                        </span>
                        <small className="table-subline">
                          {d.tunnel
                            ? `${d.tunnel.kind === "wireguard" ? "WireGuard" : d.tunnel.kind.toUpperCase()} · ${d.tunnel.endpoint ?? "sem endpoint"}`
                            : "Sem túnel"}
                        </small>
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {online.get(d.name) ?? 0}
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {d.accounts}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {ago(d.tunnel?.handshake_at ?? d.last_check_at)}
                      </TableCell>
                      <TableCell>
                        <Status value={deviceStatus(d)} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="profile-footnote">
                Nenhum concentrador cadastrado.
              </p>
            )}
          </QueryBoundary>
        </Panel>
      )}
      {tab === "agentes" && <AgentDirectory />}
      {tab === "radius" && <RadiusOverview creatable={false} />}
      {creating === "radius" && (
        <ConcentratorCreator onClose={() => setCreating(null)} />
      )}
      {creating === "api" && (
        <DeviceCreator onClose={() => setCreating(null)} />
      )}
      {selected && (
        <DeviceDetails
          key={selected.id}
          device={selected}
          onClose={close}
          extra={
            write &&
            ["radius", "demo", "mikrotik_radius"].includes(selected.driver) && (
              <RadiusActions device={selected} />
            )
          }
        />
      )}
    </>
  );
}
