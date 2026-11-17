// Rede › ONUs: todas as ONUs do provedor, com o problema primeiro e a ficha a um clique.
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Download } from "lucide-react";
import { PageHeading, Panel } from "@/components/workspace-ui";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { QueryBoundary } from "@/features/shared/feedback";
import { useSession } from "@/features/session/provider";
import { can } from "@/features/session/model";
import { exportCsv, normalize } from "@/lib/format";
import { AuthorizeOnu } from "./onus";
import { OnuSheet, useOnuRefresh } from "./onu-sheet";
import {
  ago,
  conditionLabels,
  Dbm,
  formatDbm,
  Kpi,
  onuCondition,
  OnuConditionBadge,
  useDiscoveries,
  useNoc,
  useOnus,
  type Discovery,
  type OnuCondition,
} from "./kit";

const severity: Record<OnuCondition, number> = {
  offline: 0,
  absent: 1,
  weak: 2,
  unread: 3,
  online: 4,
  removed: 5,
};
const filters = [
  ["", "Todas"],
  ["problema", "Com problema"],
  ["online", "Online"],
  ["weak", "Sinal fraco"],
  ["offline", "Offline"],
] as const;
const PAGE = 50;

export function NetworkOnuList() {
  const { me } = useSession();
  const [params, setParams] = useSearchParams();
  const onus = useOnus();
  const found = useDiscoveries();
  const noc = useNoc();
  const refresh = useOnuRefresh();
  const rxMin = noc.data?.settings.onu_rx_min_dbm ?? null;
  const [authorizing, setAuthorizing] = useState<{
    discovery?: Discovery;
  } | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const query = params.get("busca") ?? "";
  const olt = params.get("olt") ?? "";
  const pon = params.get("pon") ?? "";
  const filter = params.get("situacao") ?? "";
  const set = (key: string, value: string) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value) next.set(key, value);
        else next.delete(key);
        if (key === "olt") next.delete("pon");
        return next;
      },
      { replace: true },
    );
  const all = (onus.data ?? []).filter((n) => n.desired_state === "authorized");
  const withCondition = all.map((n) => ({ n, c: onuCondition(n, rxMin) }));
  const count = (c: OnuCondition) =>
    withCondition.filter((r) => r.c === c).length;
  const olts = [
    ...new Map(all.map((n) => [n.device_id, n.device_name])).entries(),
  ];
  const pons = [
    ...new Set(
      all.filter((n) => !olt || n.device_id === olt).map((n) => n.pon_port),
    ),
  ].sort();
  const rows = withCondition
    .filter(
      ({ n, c }) =>
        (!olt || n.device_id === olt) &&
        (!pon || n.pon_port === pon) &&
        (!filter ||
          (filter === "problema"
            ? c !== "online"
            : filter === "offline"
              ? c === "offline" || c === "absent"
              : c === filter)) &&
        normalize(
          `${n.subscriber_name} ${n.serial} ${n.device_name} ${n.pon_port}`,
        ).includes(normalize(query.trim())),
    )
    .sort(
      (a, b) =>
        severity[a.c] - severity[b.c] ||
        (a.n.observed_rx_dbm ?? 0) - (b.n.observed_rx_dbm ?? 0) ||
        a.n.subscriber_name.localeCompare(b.n.subscriber_name),
    );
  const selected = all.find((n) => n.id === params.get("onu"));
  const pending = found.data ?? [];
  const operate = can(me, "network:operate");
  return (
    <>
      <PageHeading
        title="ONUs"
        description="Situação e sinal de cada cliente na fibra."
        actions={
          <>
            <Button
              variant="outline"
              disabled={!rows.length}
              onClick={() =>
                exportCsv(
                  "nexo-onus",
                  [
                    "Cliente",
                    "Serial",
                    "OLT",
                    "PON",
                    "RX (dBm)",
                    "TX (dBm)",
                    "Situação",
                    "Leitura",
                  ],
                  rows.map(({ n, c }) => [
                    n.subscriber_name,
                    n.serial,
                    n.device_name,
                    n.pon_port,
                    n.observed_rx_dbm ?? "",
                    n.observed_tx_dbm ?? "",
                    conditionLabels[c],
                    n.observed_at ?? "",
                  ]),
                )
              }
            >
              <Download data-icon="inline-start" />
              Exportar
            </Button>
            {operate && (
              <Button onClick={() => setAuthorizing({})}>Autorizar ONU</Button>
            )}
          </>
        }
      />
      <div className="metrics-grid">
        <Kpi
          label="Online"
          value={`${count("online") + count("weak")} / ${all.length}`}
          href="?situacao=online"
        />
        <Kpi
          label="Sinal fraco"
          value={count("weak")}
          detail={
            rxMin != null
              ? `Abaixo de ${formatDbm(rxMin)}`
              : "Sem limite definido"
          }
          href="?situacao=weak"
        />
        <Kpi
          label="Offline"
          value={count("offline") + count("absent")}
          href="?situacao=offline"
        />
        <Kpi label="Aguardando autorização" value={pending.length} />
      </div>
      <div className="erp-stack">
        {pending.length > 0 && (
          <Panel
            title="Aguardando autorização"
            description="ONUs que a OLT encontrou e ainda não têm contrato."
          >
            <Table>
              <TableHeader>
                <TableRow>
                  {["Serial", "OLT · PON", "Modelo", "Vista", ""].map(
                    (label) => (
                      <TableHead key={label}>{label}</TableHead>
                    ),
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {pending.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="mono">{d.serial}</TableCell>
                    <TableCell>
                      {d.device_name} · {d.pon_port}
                    </TableCell>
                    <TableCell>
                      {[d.vendor, d.model].filter(Boolean).join(" ") || "—"}
                    </TableCell>
                    <TableCell>{ago(d.last_seen_at)}</TableCell>
                    <TableCell className="text-right">
                      {operate && (
                        <Button
                          size="sm"
                          aria-label={`Autorizar ONU ${d.serial}`}
                          onClick={() => setAuthorizing({ discovery: d })}
                        >
                          Autorizar
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Panel>
        )}
        <Panel
          title="ONUs autorizadas"
          description={`${rows.length} de ${all.length}`}
        >
          <div className="mb-4 grid gap-3 md:grid-cols-[2fr_1fr_1fr_1fr]">
            <Input
              aria-label="Buscar ONU"
              placeholder="Cliente, serial ou PON"
              value={query}
              onChange={(event) => set("busca", event.target.value)}
            />
            <select
              aria-label="OLT"
              className="commercial-select"
              value={olt}
              onChange={(event) => set("olt", event.target.value)}
            >
              <option value="">Todas as OLTs</option>
              {olts.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
            <select
              aria-label="Porta PON"
              className="commercial-select"
              value={pon}
              onChange={(event) => set("pon", event.target.value)}
            >
              <option value="">Todas as PONs</option>
              {pons.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
            <select
              aria-label="Situação"
              className="commercial-select"
              value={filter}
              onChange={(event) => set("situacao", event.target.value)}
            >
              {filters.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <QueryBoundary
            loading={onus.isLoading}
            error={onus.error}
            retry={() => onus.mutate()}
          >
            {rows.length ? (
              <OnuTable
                rows={rows.slice(0, limit)}
                rxMin={rxMin}
                onOpen={(id) => set("onu", id)}
              />
            ) : (
              <p className="profile-footnote">Nenhuma ONU neste filtro.</p>
            )}
            {rows.length > limit && (
              <Button
                variant="outline"
                className="mt-4"
                onClick={() => setLimit(limit + PAGE)}
              >
                Mostrar mais {Math.min(PAGE, rows.length - limit)}
              </Button>
            )}
          </QueryBoundary>
        </Panel>
      </div>
      {selected && (
        <OnuSheet onu={selected} rxMin={rxMin} onClose={() => set("onu", "")} />
      )}
      {authorizing && (
        <AuthorizeOnu
          discovery={authorizing.discovery}
          onClose={() => setAuthorizing(null)}
          onDone={async () => {
            setAuthorizing(null);
            await refresh();
          }}
        />
      )}
    </>
  );
}

/** Tabela de ONUs usada na lista geral, na página da OLT e na da caixa. */
export function OnuTable({
  rows,
  rxMin,
  onOpen,
  hideOlt = false,
}: {
  rows: { n: import("./kit").Onu; c: OnuCondition }[];
  rxMin: number | null;
  onOpen: (id: string) => void;
  hideOlt?: boolean;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Cliente</TableHead>
          <TableHead>{hideOlt ? "PON" : "OLT · PON"}</TableHead>
          <TableHead>Sinal RX</TableHead>
          <TableHead>TX</TableHead>
          <TableHead>Situação</TableHead>
          <TableHead>Leitura</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map(({ n, c }) => (
          <TableRow
            key={n.id}
            className="cursor-pointer"
            onClick={() => onOpen(n.id)}
          >
            <TableCell>
              <button
                type="button"
                className="text-left font-medium hover:underline"
                onClick={(event) => {
                  event.stopPropagation();
                  onOpen(n.id);
                }}
              >
                {n.subscriber_name}
              </button>
              <small className="table-subline mono">{n.serial}</small>
            </TableCell>
            <TableCell>
              {hideOlt ? n.pon_port : `${n.device_name} · ${n.pon_port}`}
            </TableCell>
            <TableCell>
              <Dbm value={n.observed_rx_dbm} min={rxMin} />
            </TableCell>
            <TableCell>
              <Dbm
                value={n.observed_tx_dbm}
                min={null}
                className="text-muted-foreground"
              />
            </TableCell>
            <TableCell>
              <OnuConditionBadge value={c} />
            </TableCell>
            <TableCell className="text-muted-foreground">
              {ago(n.observed_at)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
