import useSWR from "swr";
import { useNavigate, useSearchParams } from "react-router-dom";
import { z } from "zod";
import { Download, Server, Signal, Users, Workflow } from "lucide-react";
import {
  OpticalFilters,
  OpticalPage,
  PonPortTable,
} from "@/components/optical-network";
import { OpticalEmpty, OpticalNotice } from "@/components/optical-ui";
import { Panel, SourceFooter } from "@/components/workspace-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { QueryBoundary } from "@/features/shared/feedback";
import { exportCsv, normalize } from "@/lib/format";
import { api } from "@/platform/erp-client";

const portSchema = z.object({
  device_id: z.string(),
  olt: z.string(),
  pon_port: z.string(),
  onus: z.number(),
  online: z.number(),
  rx_avg: z.number().nullable(),
  pending: z.number(),
  subscribers: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      contract_id: z.string(),
      online: z.boolean().nullable(),
      rx_dbm: z.number().nullable(),
    }),
  ),
});
type Port = z.infer<typeof portSchema>;
const portId = (port: Port) => `${port.device_id}:${port.pon_port}`;
// "0/1/3" = quadro/slot e porta PON.
function split(value: string) {
  const parts = value.split("/");
  return {
    slot: parts.length > 1 ? parts.slice(0, -1).join("/") : "—",
    pon: parts.at(-1)!,
  };
}

// Tela FTTx - PON do v0 alimentada pelas ONUs vinculadas e pelas descobertas da OLT.
export function PonPorts() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const query = params.get("busca") ?? "";
  const olt = params.get("olt") ?? "";
  const selectedId = params.get("pon");
  const result = useSWR("erp-pon-ports", async () =>
    z.array(portSchema).parse(await api("/olt/pon-ports")),
  );
  const change = (key: string, value: string | null) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        value ? next.set(key, value) : next.delete(key);
        return next;
      },
      { replace: true },
    );
  const ports = result.data ?? [];
  const rows = ports.filter(
    (port) =>
      (!olt || port.olt === olt) &&
      normalize(`${port.olt} ${port.pon_port}`).includes(normalize(query)),
  );
  const selected = ports.find((port) => portId(port) === selectedId);
  const readings = ports.filter((port) => port.rx_avg !== null);
  const average = readings.length
    ? readings.reduce((sum, port) => sum + port.rx_avg! * port.online, 0) /
      Math.max(
        1,
        readings.reduce((sum, port) => sum + port.online, 0),
      )
    : null;
  return (
    <OpticalPage
      title="Portas PON"
      description="Portas identificadas pelas ONUs vinculadas e pelas descobertas relatadas pela OLT."
      mode="pon"
      actions={
        <Button
          variant="outline"
          disabled={!rows.length}
          onClick={() =>
            exportCsv(
              "nexo-pons",
              [
                "OLT",
                "Porta PON",
                "ONUs vinculadas",
                "Online",
                "Sinal médio RX (dBm)",
                "Descobertas pendentes",
              ],
              rows.map((port) => [
                port.olt,
                port.pon_port,
                port.onus,
                port.online,
                port.rx_avg ?? "Não coletado",
                port.pending,
              ]),
            )
          }
        >
          <Download data-icon="inline-start" />
          Exportar CSV
        </Button>
      }
      metrics={[
        {
          label: "OLTs com portas",
          value: new Set(ports.map((port) => port.device_id)).size,
          detail: "Com ONU vinculada ou descoberta",
          icon: Server,
        },
        {
          label: "PONs identificadas",
          value: ports.length,
          detail: "Pelo vínculo e pela descoberta",
          icon: Workflow,
        },
        {
          label: "ONUs vinculadas",
          value: ports.reduce((sum, port) => sum + port.onus, 0),
          detail: `${ports.reduce((sum, port) => sum + port.pending, 0)} descoberta(s) aguardando autorização`,
          icon: Users,
        },
        {
          label: "Sinal médio RX",
          value: average === null ? "—" : `${average.toFixed(1)} dBm`,
          detail: "ONUs online com leitura válida",
          icon: Signal,
        },
      ]}
    >
      <OpticalNotice>
        Consulta derivada das ONUs e das descobertas, sem coleta SNMP.
        Capacidade e VLAN da porta não são cadastradas; o sinal é a última
        leitura de cada ONU.
      </OpticalNotice>
      <OpticalFilters
        description="Filtre as portas identificadas na rede do provedor."
        searchLabel="porta PON"
        placeholder="OLT ou porta…"
        query={query}
        onQuery={(value) => change("busca", value || null)}
        filterLabel="OLT concentradora"
        allLabel="Todas as OLTs"
        value={olt}
        onValue={(value) => change("olt", value || null)}
        options={[...new Set(ports.map((port) => port.olt))]}
      />
      <Panel
        title="Identificação das portas PON"
        description={`${rows.length} registros nesta consulta.`}
      >
        <QueryBoundary
          loading={result.isLoading}
          error={result.error}
          retry={() => result.mutate()}
        >
          <PonPortTable
            onusLabel="ONUs vinculadas"
            rows={rows.map((port) => ({
              id: portId(port),
              olt: port.olt,
              ...split(port.pon_port),
              onus: port.onus,
              rx: port.rx_avg,
              capacity: port.pending
                ? `${port.pending} descoberta(s) pendente(s)`
                : undefined,
            }))}
            onSelect={(id) => change("pon", id)}
          />
          {!rows.length && (
            <OpticalEmpty
              title="Nenhuma porta PON identificada"
              description={
                ports.length
                  ? "Revise os filtros de pesquisa para ampliar a consulta."
                  : "As portas aparecem quando uma ONU é vinculada a um contrato ou descoberta pela OLT."
              }
            />
          )}
        </QueryBoundary>
      </Panel>
      <SourceFooter sample="Inventário óptico do provedor · sem alterações em equipamentos" />
      <Sheet
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) change("pon", null);
        }}
      >
        <SheetContent className="overflow-y-auto">
          <SheetHeader>
            <SheetTitle>
              {selected &&
                `Slot ${split(selected.pon_port).slot} · PON ${split(selected.pon_port).pon}`}
            </SheetTitle>
            <SheetDescription>{selected?.olt}</SheetDescription>
          </SheetHeader>
          <div className="flex flex-col gap-6 p-5">
            <h2>
              Assinantes vinculados{" "}
              <Badge variant="secondary">
                {selected?.subscribers.length ?? 0}
              </Badge>
            </h2>
            {selected?.subscribers.length ? (
              selected.subscribers.map((subscriber) => (
                <Button
                  variant="outline"
                  key={subscriber.contract_id}
                  onClick={() => navigate(`/assinantes?ficha=${subscriber.id}`)}
                >
                  {subscriber.name}
                  {subscriber.rx_dbm !== null &&
                    ` · ${subscriber.rx_dbm.toFixed(1)} dBm`}
                  {subscriber.online === false && " · offline"}
                </Button>
              ))
            ) : (
              <OpticalEmpty
                title="Sem vínculos de assinantes"
                description="Nenhuma ONU desta porta está vinculada a contrato; há apenas descobertas aguardando autorização."
              />
            )}
          </div>
        </SheetContent>
      </Sheet>
    </OpticalPage>
  );
}
