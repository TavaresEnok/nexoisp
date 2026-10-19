"use client";

import { useState } from "react";
import { useSearchParams } from "@/platform/navigation/react";
import { useQueryState } from "@/lib/use-query-state";
import { isDemoMode } from "@/application/execution-mode";
import {
  Radio,
  Activity,
  Router,
  ArrowUpRight,
  Download,
  ChevronRight,
  Signal,
  Info,
  Users,
  CircleCheck,
  Network,
  Search,
  Server,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableHeader, TableHead, TableRow, TableBody, TableCell } from "@/components/ui/table";
import { EmptyState } from "@/components/workspace-feedback";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { Button } from "@/components/ui/button";
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
import {
  Panel,
  PageHeading,
  Status,
  SourceFooter,
  PersonAvatar,
  DemoNotice,
} from "@/components/workspace-ui";
import { useWorkspace } from "@/features/workspace/context";
import type { ReactNode } from "react";
import { number, clock, exportCsv } from "@/lib/format";
import type { NetworkNode } from "@/lib/types";
import { selectNetworkNodes } from "@/application/selectors/network";
import { ContextCallout } from "@/components/workspace-feedback";

export function NetworkCenter() {
  const { data, openSubscriber } = useWorkspace();
  const { snapshot: s } = data;
  const params = useSearchParams();
  const [filter, setFilter] = useQueryState("situacao", params.get("filtro") === "atencao" ? "Atenção" : "Todos", ["Todos", ...data.nodes.map(n => n.status)]);
  const [query, setQuery] = useQueryState("busca", "");
  const [node, setNode] = useState<NetworkNode | null>(null);
  const [incident, setIncident] = useState(false);
  const rows = selectNetworkNodes(data.nodes, filter, query);
  const affected = data.subscribers.filter((a) => a.pop === "POP Norte");
  const traffic = data.nodes
    .filter((n) => n.traffic > 0)
    .map((n) => ({ name: n.name.replace("-01", ""), traffic: n.traffic }));
  return (
    <>
      <PageHeading
        title="Monitoramento de rede"
        description="Disponibilidade, equipamentos e impacto no assinante em uma visão só."
        actions={
          <>
            <span className="date-chip">
              <span className="live-dot" />
              Leitura do cenário · {clock(s.asOf)}
            </span>
            <Button
              variant="outline"
              onClick={() =>
                exportCsv(
                  "nexo-rede-demonstrativa",
                  [
                    "Equipamento",
                    "POP",
                    "Tipo",
                    "Status",
                    "Latência (ms)",
                    "CPU (%)",
                    "Tráfego (Gbps)",
                  ],
                  rows.map((n) => [
                    n.name,
                    n.pop,
                    n.type,
                    n.status,
                    n.latency,
                    n.cpu,
                    n.traffic,
                  ]),
                )
              }
            >
              <Download data-icon="inline-start" />
              Exportar leitura
            </Button>
          </>
        }
      />
      <button
        className="network-incident-banner"
        onClick={() => setIncident(true)}
      >
        <span className="priority-icon tone-warning">
          <Radio size={20} />
        </span>
        <span>
          <strong>Um alerta. Vários contextos conectados.</strong>
          <small>
            POP Norte · 12 ONUs com potência abaixo de −27 dBm no cenário.
          </small>
        </span>
        <Badge variant="secondary">Sinal degradado</Badge>
        <span className="incident-link">
          Investigar impacto
          <ArrowUpRight size={15} />
        </span>
      </button>
      <div className="metrics-grid">
        {[
          {
            title: "Sessões PPPoE online",
            value: number(s.online),
            detail: `de ${number(s.accounts)} contas provisionadas`,
            icon: Users,
          },
          {
            title: "Equipamentos disponíveis",
            value: `${s.equipmentOnline} / ${s.equipmentTotal}`,
            detail: "Leitura completa do cenário",
            icon: Router,
          },
          {
            title: "Latência média",
            value: `${s.latency.toFixed(1).replace(".", ",")} ms`,
            detail: "Não representa teste em tempo real",
            icon: Activity,
          },
          {
            title: "Disponibilidade",
            value: "99,98%",
            detail: "Histórico de 30 dias do cenário",
            icon: CircleCheck,
          },
        ].map((m) => (
          <div className="metric-card" key={m.title}>
            <div className="metric-heading">
              <span>{m.title}</span>
              <m.icon size={17} />
            </div>
            <div className="metric-main">
              <strong>{m.value}</strong>
            </div>
            <p>{m.detail}</p>
          </div>
        ))}
      </div>
      <div className="network-top-grid">
        <Panel
          title="De ponta a ponta"
          description="Tráfego por equipamento · leitura demonstrativa em Gbps"
        >
          <ChartContainer
            config={{
              traffic: { label: "Tráfego · Gbps", color: "var(--chart-1)" },
            }}
            className="traffic-chart"
          >
            <BarChart
              accessibilityLayer
              data={traffic}
              margin={{ top: 10, right: 10, left: -25, bottom: 0 }}
            >
              <CartesianGrid vertical={false} strokeDasharray="3 4" />
              <XAxis
                dataKey="name"
                axisLine={false}
                tickLine={false}
                tickMargin={10}
                interval={0}
                fontSize={8}
              />
              <YAxis
                axisLine={false}
                tickLine={false}
                fontSize={10}
                tickFormatter={(v) => `${v}G`}
              />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar
                dataKey="traffic"
                fill="var(--color-traffic)"
                radius={[4, 4, 0, 0]}
                maxBarSize={34}
              />
            </BarChart>
          </ChartContainer>
        </Panel>
        <Panel
          title="Sessões por concentrador"
          description="Online e provisionadas são medidas diferentes"
        >
          <div className="concentrators">
            {data.nodes
              .filter((n) => n.type === "Concentrador")
              .map((n) => (
                <button key={n.id} onClick={() => setNode(n)}>
                  <div>
                    <span className="mono">{n.name}</span>
                    <ArrowUpRight size={14} />
                  </div>
                  <strong>
                    {number(n.sessions)}
                    <small> / {number(n.capacity)}</small>
                  </strong>
                  <span className="concentrator-progress">
                    <i
                      style={{ width: `${(n.sessions / n.capacity) * 100}%` }}
                    />
                  </span>
                  <p>
                    {n.pop}
                    <span>
                      {((n.sessions / n.capacity) * 100)
                        .toFixed(1)
                        .replace(".", ",")}
                      % com sessão
                    </span>
                  </p>
                </button>
              ))}
          </div>
        </Panel>
      </div>
      <NetworkEquipmentTable rows={rows} filter={filter} setFilter={setFilter} query={query} setQuery={setQuery} onOpen={n => setNode(n as NetworkNode)} />
      <DemoNotice>
        {isDemoMode ? "Telemetria sintética e estática do cenário local." : "Telemetria sintética e estática, armazenada no Neon."} Nenhum agente, concentrador ou OLT real está conectado.
      </DemoNotice>
      <SourceFooter sample="Telemetria demonstrativa" />
      <Sheet open={!!node} onOpenChange={(open) => !open && setNode(null)}>
        <SheetContent className="ticket-sheet">
          {node && (
            <>
              <SheetHeader>
                <p className="eyebrow">IDENTIDADE DO EQUIPAMENTO</p>
                <SheetTitle className="mono">{node.name}</SheetTitle>
                <SheetDescription>
                  {node.type} · {node.vendor} · {node.pop}
                </SheetDescription>
                <Status value={node.status} />
              </SheetHeader>
              <div className="sheet-content-body">
                <dl className="detail-grid">
                  <div>
                    <dt>Endereço IP</dt>
                    <dd className="mono">{node.ip}</dd>
                  </div>
                  <div>
                    <dt>Última leitura do cenário</dt>
                    <dd>17 out. 2026 · 09:42</dd>
                  </div>
                  <div>
                    <dt>CPU</dt>
                    <dd>
                      {node.status === "Offline"
                        ? "Sem leitura"
                        : `${node.cpu}%`}
                    </dd>
                  </div>
                  <div>
                    <dt>Latência</dt>
                    <dd>
                      {node.status === "Offline"
                        ? "Sem leitura"
                        : `${node.latency} ms`}
                    </dd>
                  </div>
                  <div>
                    <dt>Tráfego</dt>
                    <dd>
                      {node.status === "Offline"
                        ? "Sem leitura"
                        : `${node.traffic} Gbps`}
                    </dd>
                  </div>
                  <div>
                    <dt>POP</dt>
                    <dd>{node.pop}</dd>
                  </div>
                </dl>
                {node.pop === "POP Norte" && (
                  <ContextCallout
                    icon={Radio}
                    title="Este POP possui um incidente."
                  >
                    <p>Há 12 ONUs com sinal degradado no cenário.</p>
                    <button
                      onClick={() => {
                        setNode(null);
                        setIncident(true);
                      }}
                    >
                      Ver impacto no assinante
                      <ArrowUpRight size={14} />
                    </button>
                  </ContextCallout>
                )}
                <p className="demo-notice">
                  <Info size={14} />
                  Não há reinicialização, bloqueio ou comando remoto nesta
                  demonstração.
                </p>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
      <Dialog open={incident} onOpenChange={setIncident}>
        <DialogContent className="incident-dialog">
          <DialogHeader>
            <p className="eyebrow">INCIDENTE DE REDE · CENÁRIO</p>
            <DialogTitle>Sinal degradado no POP Norte</DialogTitle>
            <DialogDescription>
              Alerta óptico registrado às 09:24 de 17 out. 2026.
            </DialogDescription>
          </DialogHeader>
          <div className="incident-summary">
            <div>
              <strong>12</strong>
              <span>ONUs no cenário</span>
            </div>
            <div>
              <strong>
                −27 <small>dBm</small>
              </strong>
              <span>limiar de atenção</span>
            </div>
            <div>
              <strong>{affected.length}</strong>
              <span>assinantes na amostra</span>
            </div>
          </div>
          <p className="muted-copy">
            O incidente pode explicar chamados de falta de conexão no mesmo POP.
            Consulte o contexto antes de abrir uma intervenção individual.
          </p>
          <div className="incident-subscribers">
            {affected.map((a) => (
              <button
                key={a.id}
                onClick={() => {
                  setIncident(false);
                  openSubscriber(a.id);
                }}
              >
                <PersonAvatar name={a.name} small />
                <span>
                  <strong>{a.name}</strong>
                  <small>
                    {a.signal} dBm · {a.neighborhood}
                  </small>
                </span>
                <Status value={a.connection} />
                <ChevronRight size={15} />
              </button>
            ))}
          </div>
          <p className="demo-notice">
            <Info size={14} />
            Correlação demonstrativa. Não é um diagnóstico automático de uma
            rede real.
          </p>
        </DialogContent>
      </Dialog>
    </>
  );
}

export type InventoryNode = Pick<NetworkNode,"id"|"name"|"ip"|"type"|"vendor"|"pop"> & { status:string; latency:number|null; cpu:number|null };
export function NetworkEquipmentTable({rows,filter,setFilter,query,setQuery,onOpen,operational=false,statusOptions,actions}:{rows:InventoryNode[];filter:string;setFilter:(value:string)=>void;query:string;setQuery:(value:string)=>void;onOpen:(node:InventoryNode)=>void;operational?:boolean;statusOptions?:string[];actions?:ReactNode}) {
return (<Panel
        title="Equipamentos com identidade"
        description={operational ? "Inventário retornado pelo ERP. Indicadores ausentes não são estimados." : "Amostra de 8 elementos da infraestrutura do cenário"}
        action={actions ?? <Badge variant="outline">Sem comandos remotos</Badge>}
        className="list-panel"
      >
        <div className="list-toolbar">
          <Tabs value={filter} onValueChange={(v) => setFilter(String(v))}>
            <TabsList variant="line">
              {(statusOptions ?? ["Todos", "Operacional", "Atenção", "Offline"]).map((v) => (
                <TabsTrigger key={v} value={v}>
                  {v === "Operacional" ? "Operacionais" : v}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <div className="search-field">
            <Search size={15} />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Nome, POP ou endereço IP…"
              aria-label="Buscar equipamentos"
            />
          </div>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Equipamento</TableHead>
              <TableHead>Tipo / fabricante</TableHead>
              <TableHead>POP</TableHead>
              <TableHead>Estado</TableHead>
              <TableHead>Latência</TableHead>
              <TableHead>CPU</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((n) => (
              <TableRow key={n.id}>
                <TableCell>
                  <button className="node-identity" onClick={() => onOpen(n)}>
                    <span className="node-icon">
                      <Server size={17} />
                    </span>
                    <span>
                      <strong className="mono">{n.name}</strong>
                      <small className="mono">{n.ip}</small>
                    </span>
                  </button>
                </TableCell>
                <TableCell>
                  {n.type}
                  <small className="table-subline">{n.vendor}</small>
                </TableCell>
                <TableCell className="subtle">{n.pop}</TableCell>
                <TableCell>
                  <Status value={n.status} />
                </TableCell>
                <TableCell className="mono">
                  {n.status === "Offline" || n.latency == null ? "—" : `${n.latency.toFixed(1)} ms`}
                </TableCell>
                <TableCell>
                  {n.cpu != null && <span className="cpu-meter">
                    <i style={{ width: `${n.cpu}%` }} />
                  </span>}
                  <small className="mono">
                    {n.status === "Offline" || n.cpu == null ? "—" : `${n.cpu}%`}
                  </small>
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Detalhes de ${n.name}`}
                    onClick={() => onOpen(n)}
                  >
                    <ArrowUpRight />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {rows.length === 0 && (
          <EmptyState icon={Network} title="Nenhum equipamento nesta seleção.">
            <Button
              variant="outline"
              onClick={() => {
                setFilter("Todos");
                setQuery("");
              }}
            >
              Limpar filtros
            </Button>
          </EmptyState>
        )}
        <div className="table-total">
          <span>{rows.length} equipamentos na seleção</span>
          <span>{operational ? "Estado conforme os relatos disponíveis no ERP" : "Endereços privados fictícios · somente leitura"}</span>
        </div>
      </Panel>);
}
