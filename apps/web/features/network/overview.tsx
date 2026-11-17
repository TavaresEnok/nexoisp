// Rede › Visão geral: a primeira tela do técnico. Responde "a rede está bem?" e "o que precisa de mim agora?".
import useSWR from "swr";
import { z } from "zod";
import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { PageHeading, Panel, Status } from "@/components/workspace-ui";
import { QueryBoundary } from "@/features/shared/feedback";
import { useSession } from "@/features/session/provider";
import { hasModule } from "@/features/session/model";
import { api } from "@/platform/erp-client";
import { useDevices } from "./queries";
import { actionLabels, operationLabels, operationRowSchema } from "./models";
import { Severity } from "./noc";
import { deviceStatus, isOlt } from "./olts";
import {
  ago,
  Kpi,
  Meter,
  oltHref,
  onuCondition,
  useDiscoveries,
  useNoc,
  useOnus,
  useSessions,
} from "./kit";

// Destino de cada alerta do NOC dentro da nova área de Rede.
function alertHref(
  kind: string | undefined,
  items: { device_id?: string | null; pon_port?: string | null }[] | undefined,
) {
  switch (kind) {
    case "onu_weak":
      return "/rede/onus?situacao=weak";
    case "onu_down":
      return "/rede/onus?situacao=offline";
    case "pon_outage":
      return items?.[0]?.device_id
        ? oltHref(items[0].device_id, items[0].pon_port)
        : "/rede/olts";
    case "box_down":
      return "/rede/ftth";
    case "agent_offline":
      return "/rede/equipamentos?aba=agentes";
    case "ops_uncertain":
    case "ops_failed":
    case "drift":
      return "/rede/operacoes?filter=problem";
    default:
      return kind?.startsWith("hygiene_") ? "/rede/equipamentos" : undefined;
  }
}
// Alertas que não são de rede (ex.: OS atrasada) ficam nas áreas deles.
const networkKinds = (kind?: string) => kind !== "os_late";

export function NetworkOverview() {
  const { me } = useSession();
  const olt = hasModule(me, "olt");
  const devices = useDevices();
  const noc = useNoc(hasModule(me, "noc"));
  const onus = useOnus(olt);
  const found = useDiscoveries(olt);
  const sessions = useSessions();
  const operations = useSWR("erp-overview-operations", async () =>
    z.array(operationRowSchema).parse(await api("/operations?limit=6")),
  );
  const rxMin = noc.data?.settings.onu_rx_min_dbm ?? null;
  const authorized = (onus.data ?? []).filter(
    (n) => n.desired_state === "authorized",
  );
  const conditions = authorized.map((n) => ({ n, c: onuCondition(n, rxMin) }));
  const onusOnline = conditions.filter(
    (r) => r.c === "online" || r.c === "weak",
  ).length;
  const weak = conditions.filter((r) => r.c === "weak").length;
  const allDevices = devices.data ?? [];
  const olts = allDevices.filter(isOlt);
  const nas = allDevices.filter((d) => !isOlt(d));
  const troubled = allDevices.filter((d) =>
    ["Offline", "Atenção"].includes(deviceStatus(d)),
  );
  const alerts = (noc.data?.alerts ?? []).filter((a) => networkKinds(a.kind));
  const pending = found.data ?? [];
  const sessionsByNas = new Map<string, number>();
  for (const s of sessions.data ?? [])
    if (s.nas) sessionsByNas.set(s.nas, (sessionsByNas.get(s.nas) ?? 0) + 1);
  const attention = alerts.length + (pending.length ? 1 : 0);
  return (
    <>
      <PageHeading
        title="Rede"
        description={
          noc.data
            ? `Atualizado ${ago(noc.data.generated_at)}.`
            : "Situação da rede agora."
        }
      />
      <div className="metrics-grid">
        <Kpi
          label="Clientes online"
          value={
            noc.data
              ? `${noc.data.counters.sessions} / ${noc.data.counters.accounts}`
              : (sessions.data?.length ?? "—")
          }
          detail="Sessões PPPoE abertas"
          href="/rede/online"
        />
        {olt && (
          <Kpi
            label="ONUs online"
            value={`${onusOnline} / ${authorized.length}`}
            detail={`${authorized.length - onusOnline} sem sinal`}
            href="/rede/onus"
          />
        )}
        {olt && (
          <Kpi
            label="Sinal fraco"
            value={weak}
            detail={
              rxMin != null ? `Abaixo de ${rxMin} dBm` : "Sem limite definido"
            }
            href="/rede/onus?situacao=weak"
          />
        )}
        <Kpi
          label="Equipamentos com problema"
          value={`${troubled.length} / ${allDevices.length}`}
          detail="OLTs e concentradores"
          href="/rede/equipamentos"
        />
      </div>
      <div className="erp-stack">
        <Panel
          title="Precisa de atenção"
          description={attention ? `${attention} item(ns)` : undefined}
        >
          <QueryBoundary
            loading={noc.isLoading}
            error={noc.error}
            retry={() => noc.mutate()}
          >
            {attention === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nada pendente. A rede está normal.
              </p>
            ) : (
              <ul className="flex flex-col">
                {pending.length > 0 && (
                  <AttentionRow
                    severity="warning"
                    title={`${pending.length} ONU(s) aguardando autorização`}
                    detail={pending
                      .slice(0, 3)
                      .map(
                        (d) => `${d.serial} · ${d.device_name} ${d.pon_port}`,
                      )
                      .join(" · ")}
                    href="/rede/onus"
                  />
                )}
                {alerts.map((alert, index) => (
                  <AttentionRow
                    key={index}
                    severity={alert.severity}
                    title={alert.title}
                    detail={
                      alert.items?.length
                        ? alert.items
                            .slice(0, 4)
                            .map(
                              (i) => i.subscriber_name || i.target || i.serial,
                            )
                            .filter(Boolean)
                            .join(", ") +
                          (alert.items.length > 4
                            ? ` e mais ${alert.items.length - 4}`
                            : "")
                        : alert.detail
                    }
                    href={alertHref(alert.kind, alert.items)}
                  />
                ))}
              </ul>
            )}
          </QueryBoundary>
        </Panel>
        {olt && olts.length > 0 && (
          <Panel
            title="OLTs"
            action={
              <Link className="text-link text-sm" to="/rede/olts">
                Todas
              </Link>
            }
          >
            <div className="grid gap-3 md:grid-cols-2">
              {olts.map((device) => {
                const rows = conditions.filter(
                  (r) => r.n.device_id === device.id,
                );
                const pons = [...new Set(rows.map((r) => r.n.pon_port))].sort(
                  (a, b) => a.localeCompare(b, undefined, { numeric: true }),
                );
                const on = rows.filter(
                  (r) => r.c === "online" || r.c === "weak",
                ).length;
                return (
                  <Link
                    key={device.id}
                    to={oltHref(device.id)}
                    className="flex flex-col gap-3 rounded-lg border p-4 transition-colors hover:bg-muted/50"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <strong className="text-sm">{device.name}</strong>
                      <Status value={deviceStatus(device)} />
                    </div>
                    <Meter
                      value={on}
                      total={rows.length}
                      label={`${on}/${rows.length} ONUs online`}
                    />
                    <div className="flex flex-col gap-1">
                      {pons.map((pon) => {
                        const p = rows.filter((r) => r.n.pon_port === pon);
                        const pOn = p.filter(
                          (r) => r.c === "online" || r.c === "weak",
                        ).length;
                        const pWeak = p.filter((r) => r.c === "weak").length;
                        return (
                          <div
                            key={pon}
                            className="flex items-center justify-between text-xs text-muted-foreground"
                          >
                            <span className="mono">PON {pon}</span>
                            <span className="tabular-nums">
                              {pOn}/{p.length} online
                              {pWeak > 0 && (
                                <span className="ml-2 font-semibold text-destructive">
                                  {pWeak} fraco
                                </span>
                              )}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </Link>
                );
              })}
            </div>
          </Panel>
        )}
        <div className="grid items-start gap-[var(--section-gap)] lg:grid-cols-2">
          <Panel
            title="Concentradores"
            action={
              <Link className="text-link text-sm" to="/rede/equipamentos">
                Todos
              </Link>
            }
          >
            {nas.length ? (
              <ul className="flex flex-col">
                {nas.map((d) => (
                  <li key={d.id}>
                    <Link
                      to={`/rede/equipamentos?equipamento=${d.id}`}
                      className="flex items-center justify-between gap-3 border-t py-3 text-sm hover:bg-muted/50"
                    >
                      <span className="flex flex-col">
                        <strong className="font-medium">{d.name}</strong>
                        <small className="text-xs text-muted-foreground">
                          {d.tunnel
                            ? `Túnel ${d.tunnel.kind === "wireguard" ? "WireGuard" : d.tunnel.kind} · contato ${ago(d.tunnel.handshake_at)}`
                            : (d.nas_ip ?? d.host ?? "")}
                        </small>
                      </span>
                      <span className="flex items-center gap-3">
                        <span className="tabular-nums text-muted-foreground">
                          {sessionsByNas.get(d.name) ?? 0} online
                        </span>
                        <Status value={deviceStatus(d)} />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                Nenhum concentrador cadastrado.
              </p>
            )}
          </Panel>
          <Panel
            title="Últimas operações"
            action={
              <Link className="text-link text-sm" to="/rede/operacoes">
                Todas
              </Link>
            }
          >
            <QueryBoundary
              loading={operations.isLoading}
              error={operations.error}
              retry={() => operations.mutate()}
            >
              <ul className="flex flex-col">
                {(operations.data ?? []).map((op) => (
                  <li key={op.id}>
                    <Link
                      to={`/rede/operacoes?operacao=${op.id}`}
                      className="flex items-center justify-between gap-3 border-t py-3 text-sm hover:bg-muted/50"
                    >
                      <span className="flex flex-col">
                        <span>{actionLabels[op.action] ?? op.action}</span>
                        <small className="text-xs text-muted-foreground">
                          {op.subscriber_name ?? op.device_name}
                        </small>
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {operationLabels[op.status] ?? op.status} ·{" "}
                        {ago(op.created_at)}
                      </span>
                    </Link>
                  </li>
                ))}
                {!operations.data?.length && (
                  <li className="text-sm text-muted-foreground">
                    Nenhuma operação recente.
                  </li>
                )}
              </ul>
            </QueryBoundary>
          </Panel>
        </div>
      </div>
    </>
  );
}

function AttentionRow({
  severity,
  title,
  detail,
  href,
}: {
  severity: string;
  title: string;
  detail?: string;
  href?: string;
}) {
  const body = (
    <>
      <Severity value={severity} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-medium">{title}</span>
        {detail && (
          <span className="truncate text-xs text-muted-foreground">
            {detail}
          </span>
        )}
      </span>
      {href && <ChevronRight size={16} className="text-muted-foreground" />}
    </>
  );
  return (
    <li>
      {href ? (
        <Link
          to={href}
          className="flex items-center gap-3 border-t py-3 hover:bg-muted/50"
        >
          {body}
        </Link>
      ) : (
        <div className="flex items-center gap-3 border-t py-3">{body}</div>
      )}
    </li>
  );
}
