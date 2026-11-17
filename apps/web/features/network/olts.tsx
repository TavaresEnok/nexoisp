// Rede › OLTs: lista das OLTs e a página de cada uma (PONs, ONUs, backup e manutenção).
import { useState } from "react";
import useSWR from "swr";
import { z } from "zod";
import {
  Link,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import { ArrowLeft } from "lucide-react";
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
import { can, hasModule } from "@/features/session/model";
import { cn } from "@/lib/utils";
import { api } from "@/platform/erp-client";
import { useDevices } from "./queries";
import { drivers, stamp, type Device } from "./models";
import { DeviceCreator, DeviceDetails } from "./devices";
import { DeviceConfigBackups, configBackupDrivers } from "./config-backups";
import { AuthorizeOnu } from "./onus";
import { OnuSheet, useOnuRefresh } from "./onu-sheet";
import { OnuTable } from "./onu-list";
import {
  ago,
  Dbm,
  Kpi,
  Meter,
  oltHref,
  onuCondition,
  useDiscoveries,
  useNoc,
  useOnus,
  type Onu,
  type OnuCondition,
} from "./kit";

export const isOlt = (device: Device) => device.driver.startsWith("olt");
const model = (device: Device) =>
  (drivers[device.driver] ?? device.driver).split(" · ")[0];

/** Situação do equipamento a partir da última verificação do agente. */
export function deviceStatus(device: Device) {
  if (device.maintenance) return "Manutenção";
  if (device.agent_id && !device.agent_online) return "Offline";
  if (!device.last_check) return "Não verificado";
  return device.last_check.ok ? "Operacional" : "Atenção";
}

type PonRow = {
  pon: string;
  total: number;
  online: number;
  weak: number;
  offline: number;
  avg: number | null;
  worst: number | null;
};
function ponRows(onus: { n: Onu; c: OnuCondition }[]): PonRow[] {
  const groups = new Map<string, { n: Onu; c: OnuCondition }[]>();
  for (const row of onus) {
    const list = groups.get(row.n.pon_port) ?? [];
    list.push(row);
    groups.set(row.n.pon_port, list);
  }
  return [...groups.entries()]
    .map(([pon, rows]) => {
      const readings = rows
        .filter((r) => r.c === "online" || r.c === "weak")
        .map((r) => r.n.observed_rx_dbm)
        .filter((v): v is number => v != null);
      return {
        pon,
        total: rows.length,
        online: rows.filter((r) => r.c === "online" || r.c === "weak").length,
        weak: rows.filter((r) => r.c === "weak").length,
        offline: rows.filter((r) => r.c === "offline" || r.c === "absent")
          .length,
        avg: readings.length
          ? readings.reduce((a, b) => a + b, 0) / readings.length
          : null,
        worst: readings.length ? Math.min(...readings) : null,
      };
    })
    .sort((a, b) => a.pon.localeCompare(b.pon, undefined, { numeric: true }));
}

export function NetworkOlts() {
  const { pathname } = useLocation();
  const id = pathname.replace(/^\/rede\/olts\/?/, "").split("/")[0];
  return id ? <OltPage id={id} /> : <OltDirectory />;
}

function OltDirectory() {
  const { me } = useSession();
  const navigate = useNavigate();
  const devices = useDevices();
  const onus = useOnus();
  const noc = useNoc();
  const [creating, setCreating] = useState(false);
  const rxMin = noc.data?.settings.onu_rx_min_dbm ?? null;
  const olts = (devices.data ?? []).filter(isOlt);
  const byOlt = (id: string) =>
    (onus.data ?? [])
      .filter((n) => n.device_id === id && n.desired_state === "authorized")
      .map((n) => ({ n, c: onuCondition(n, rxMin) }));
  return (
    <>
      <PageHeading
        title="OLTs"
        description="Equipamentos de fibra, portas PON e clientes em cada uma."
        actions={
          can(me, "network:write") &&
          hasModule(me, "olt") && (
            <Button onClick={() => setCreating(true)}>Nova OLT</Button>
          )
        }
      />
      <Panel
        title="OLTs cadastradas"
        description={`${olts.length} equipamento(s)`}
      >
        <QueryBoundary
          loading={devices.isLoading}
          error={devices.error}
          retry={() => devices.mutate()}
        >
          {olts.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  {[
                    "OLT",
                    "PONs",
                    "ONUs online",
                    "Sinal fraco",
                    "Sinal médio",
                    "Situação",
                    "Verificada",
                  ].map((label) => (
                    <TableHead key={label}>{label}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {olts.map((olt) => {
                  const rows = byOlt(olt.id);
                  const pons = ponRows(rows);
                  const online = rows.filter(
                    (r) => r.c === "online" || r.c === "weak",
                  );
                  const readings = online
                    .map((r) => r.n.observed_rx_dbm)
                    .filter((v): v is number => v != null);
                  return (
                    <TableRow
                      key={olt.id}
                      className="cursor-pointer"
                      onClick={() => navigate(oltHref(olt.id))}
                    >
                      <TableCell>
                        <Link
                          className="font-medium hover:underline"
                          to={oltHref(olt.id)}
                        >
                          {olt.name}
                        </Link>
                        <small className="table-subline">
                          {model(olt)} ·{" "}
                          <span className="mono">
                            {olt.host ?? "sem endereço"}
                          </span>
                        </small>
                      </TableCell>
                      <TableCell>{pons.length}</TableCell>
                      <TableCell>
                        <Meter value={online.length} total={rows.length} />
                      </TableCell>
                      <TableCell
                        className={cn(
                          rows.some((r) => r.c === "weak") &&
                            "font-semibold text-destructive",
                        )}
                      >
                        {rows.filter((r) => r.c === "weak").length}
                      </TableCell>
                      <TableCell>
                        <Dbm
                          value={
                            readings.length
                              ? readings.reduce((a, b) => a + b, 0) /
                                readings.length
                              : null
                          }
                          min={rxMin}
                        />
                      </TableCell>
                      <TableCell>
                        <Status value={deviceStatus(olt)} />
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {ago(olt.last_check_at)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          ) : (
            <p className="profile-footnote">Nenhuma OLT cadastrada.</p>
          )}
        </QueryBoundary>
      </Panel>
      {creating && (
        <DeviceCreator driver="olt_huawei" onClose={() => setCreating(false)} />
      )}
    </>
  );
}

const noticeSchema = z.object({
  id: z.string(),
  title: z.string(),
  device_id: z.string().nullable(),
  starts_at: z.string(),
  ends_at: z.string().nullable(),
  canceled_at: z.string().nullable(),
});

function OltPage({ id }: { id: string }) {
  const { me } = useSession();
  const [params, setParams] = useSearchParams();
  const devices = useDevices();
  const onus = useOnus();
  const noc = useNoc();
  const found = useDiscoveries();
  const refresh = useOnuRefresh();
  const notices = useSWR("erp-maintenance-notices-olt", async () =>
    z.array(noticeSchema).parse(await api("/maintenance-notices")),
  );
  const [details, setDetails] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const rxMin = noc.data?.settings.onu_rx_min_dbm ?? null;
  const olt = devices.data?.find((d) => d.id === id);
  const pon = params.get("pon") ?? "";
  const set = (key: string, value: string) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: key === "onu" ? false : true },
    );
  const rows = (onus.data ?? [])
    .filter((n) => n.device_id === id && n.desired_state === "authorized")
    .map((n) => ({ n, c: onuCondition(n, rxMin) }));
  const pons = ponRows(rows);
  const shown = rows
    .filter((r) => !pon || r.n.pon_port === pon)
    .sort(
      (a, b) =>
        Number(a.c === "online") - Number(b.c === "online") ||
        a.n.pon_port.localeCompare(b.n.pon_port, undefined, {
          numeric: true,
        }) ||
        a.n.subscriber_name.localeCompare(b.n.subscriber_name),
    );
  const online = rows.filter((r) => r.c === "online" || r.c === "weak");
  const readings = online
    .map((r) => r.n.observed_rx_dbm)
    .filter((v): v is number => v != null);
  const pending = (found.data ?? []).filter((d) => d.device_id === id);
  const upcoming = (notices.data ?? []).filter(
    (n) =>
      n.device_id === id &&
      !n.canceled_at &&
      (!n.ends_at || new Date(n.ends_at) > new Date()),
  );
  const selected = rows.find((r) => r.n.id === params.get("onu"))?.n;
  const writable = can(me, "network:write") && hasModule(me, "olt");
  return (
    <>
      <Link
        to="/rede/olts"
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft size={14} /> OLTs
      </Link>
      <QueryBoundary
        loading={devices.isLoading}
        error={devices.error}
        retry={() => devices.mutate()}
      >
        {!olt ? (
          <PageHeading
            title="OLT não encontrada"
            description="Ela pode ter sido removida."
          />
        ) : (
          <>
            <PageHeading
              eyebrow="OLT"
              title={olt.name}
              description={`${model(olt)} · ${olt.host ?? "sem endereço"}${olt.agent_name ? ` · ${olt.agent_name}` : ""}`}
              actions={
                <>
                  <Status value={deviceStatus(olt)} />
                  <Button variant="outline" onClick={() => setDetails(true)}>
                    Equipamento
                  </Button>
                  {can(me, "network:operate") && (
                    <Button onClick={() => setAuthorizing(true)}>
                      Autorizar ONU
                    </Button>
                  )}
                </>
              }
            />
            {upcoming.map((notice) => (
              <p
                key={notice.id}
                className="mb-4 rounded-lg bg-foreground px-4 py-3 text-sm text-background"
              >
                Manutenção programada: {notice.title} ·{" "}
                {new Date(notice.starts_at).toLocaleString("pt-BR", {
                  dateStyle: "short",
                  timeStyle: "short",
                })}
              </p>
            ))}
            <div className="metrics-grid">
              <Kpi
                label="ONUs online"
                value={`${online.length} / ${rows.length}`}
              />
              <Kpi
                label="Sinal fraco"
                value={rows.filter((r) => r.c === "weak").length}
                href={`/rede/onus?olt=${id}&situacao=weak`}
              />
              <Kpi
                label="Sinal médio"
                value={
                  <Dbm
                    value={
                      readings.length
                        ? readings.reduce((a, b) => a + b, 0) / readings.length
                        : null
                    }
                    min={rxMin}
                  />
                }
              />
              <Kpi
                label="Aguardando autorização"
                value={pending.length}
                href={pending.length ? "/rede/onus" : undefined}
              />
            </div>
            <div className="erp-stack">
              <Panel
                title="Portas PON"
                description="Clique numa porta para ver os clientes dela."
              >
                <Table>
                  <TableHeader>
                    <TableRow>
                      {[
                        "Porta",
                        "ONUs online",
                        "Sinal médio",
                        "Pior sinal",
                        "Sinal fraco",
                        "Offline",
                      ].map((label) => (
                        <TableHead key={label}>{label}</TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pons.map((row) => (
                      <TableRow
                        key={row.pon}
                        className={cn(
                          "cursor-pointer",
                          row.pon === pon && "bg-muted",
                        )}
                        aria-selected={row.pon === pon}
                        onClick={() =>
                          set("pon", row.pon === pon ? "" : row.pon)
                        }
                      >
                        <TableCell className="mono font-medium">
                          {row.pon}
                        </TableCell>
                        <TableCell>
                          <Meter value={row.online} total={row.total} />
                        </TableCell>
                        <TableCell>
                          <Dbm value={row.avg} min={rxMin} />
                        </TableCell>
                        <TableCell>
                          <Dbm value={row.worst} min={rxMin} />
                        </TableCell>
                        <TableCell
                          className={cn(
                            row.weak > 0 && "font-semibold text-destructive",
                          )}
                        >
                          {row.weak}
                        </TableCell>
                        <TableCell
                          className={cn(
                            row.offline > 0 && "font-semibold text-destructive",
                          )}
                        >
                          {row.offline}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {!pons.length && (
                  <p className="profile-footnote">
                    Nenhuma ONU autorizada nesta OLT.
                  </p>
                )}
              </Panel>
              <Panel
                title={pon ? `ONUs da PON ${pon}` : "ONUs"}
                description={`${shown.length} cliente(s)`}
                action={
                  pon && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => set("pon", "")}
                    >
                      Todas as PONs
                    </Button>
                  )
                }
              >
                <QueryBoundary
                  loading={onus.isLoading}
                  error={onus.error}
                  retry={() => onus.mutate()}
                >
                  {shown.length ? (
                    <OnuTable
                      rows={shown}
                      rxMin={rxMin}
                      hideOlt
                      onOpen={(onu) => set("onu", onu)}
                    />
                  ) : (
                    <p className="profile-footnote">Nenhuma ONU.</p>
                  )}
                </QueryBoundary>
              </Panel>
              {configBackupDrivers.includes(olt.driver) && (
                <Panel title="Configuração">
                  <DeviceConfigBackups device={olt} writable={writable} />
                </Panel>
              )}
            </div>
            {details && (
              <DeviceDetails device={olt} onClose={() => setDetails(false)} />
            )}
          </>
        )}
      </QueryBoundary>
      {selected && (
        <OnuSheet onu={selected} rxMin={rxMin} onClose={() => set("onu", "")} />
      )}
      {authorizing && (
        <AuthorizeOnu
          onClose={() => setAuthorizing(false)}
          onDone={async () => {
            setAuthorizing(false);
            await refresh();
          }}
        />
      )}
    </>
  );
}
