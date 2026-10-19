import type { ReactNode } from "react";
import { ArrowUpRight, Network, Search, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableHeader, TableHead, TableRow, TableBody, TableCell } from "@/components/ui/table";
import { Panel, Status } from "@/components/workspace-ui";
import { EmptyState } from "@/components/workspace-feedback";
import type { NetworkNode } from "@/lib/types";

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
