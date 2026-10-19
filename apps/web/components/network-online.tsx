"use client";

import { useState, type ReactNode } from "react";
import { useNetworkFilters } from "@/lib/use-network-filters";
import { useQueryState } from "@/lib/use-query-state";
import Link from "@/platform/navigation/link";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Download, Filter, MapPin, Radio, RotateCcw, Search, SlidersHorizontal, X } from "lucide-react";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Table, TableHeader, TableHead, TableBody, TableRow, TableCell } from "@/components/ui/table";
import { Card, CardHeader, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { EmptyState } from "@/components/workspace-feedback";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useWorkspace } from "@/features/workspace/context";
import { NetworkQueryDialog } from "@/components/network-query-dialog";
import { matchesNetwork, filterLabels, type QueryKey } from "@/lib/network-query";
import { exportCsv } from "@/lib/format";
import styles from "./network-online.module.css";

const pageSize = 8;

export function NetworkOnline() {
  const { data, openSubscriber } = useWorkspace();
  const [filters, setFilters] = useNetworkFilters({ visibility: "online" });
  const [search, setSearch] = useQueryState("busca", "");
  const [dialog, setDialog] = useState(false);
  const [page, setPage] = useState(0);
  const connected = data.subscribers.filter(s => s.connection === "Online");
  const rows = data.subscribers.filter(s => matchesNetwork(s, filters, search));
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const current = Math.min(page, pages - 1);
  const visible = rows.slice(current * pageSize, (current + 1) * pageSize);
  const active = Object.entries(filters).filter(([key, value]) => key !== "visibility" && value);
  const pops = new Set(connected.map(s => s.pop).filter(Boolean)).size;
  const nas = new Set(connected.map(s => s.nas).filter(Boolean)).size;
  const ipv6Known = connected.filter(s => typeof s.access?.ipv6 === "boolean");
  const ipv6Count = ipv6Known.filter(s => s.access?.ipv6).length;
  const metrics = [
    { label: "Clientes conectados", value: String(connected.length).padStart(2, "0"), note: `${data.subscribers.length ? Math.round(connected.length / data.subscribers.length * 100) : 0}% dos clientes da base`, online: true },
    { label: "POPs com clientes online", value: String(pops).padStart(2, "0"), note: "Pontos de presença distintos" },
    { label: "Concentradores NAS", value: String(nas).padStart(2, "0"), note: "Associados aos clientes online" },
    { label: "Dual-Stack IPv6", value: ipv6Known.length ? String(ipv6Count) : "—", note: ipv6Known.length ? `${ipv6Known.length} clientes com informação de IPv6` : "Sem dados de IPv6 na base" },
  ];
  const clear = () => { setFilters({ visibility: "online" }); setSearch(""); setPage(0); };

  return <NetworkOnlineView metrics={metrics} actions={      <div className={styles.actions}>
        {active.length > 0 && <Button variant="ghost" size="sm" onClick={clear}><RotateCcw data-icon="inline-start" />Limpar filtros</Button>}
        <Link href="/rede/mapa" className={buttonVariants({ variant: "outline", size: "sm" })}><MapPin data-icon="inline-start" />Mapa</Link>
        <Button size="sm" onClick={() => setDialog(true)}><SlidersHorizontal data-icon="inline-start" />Fazer consulta{active.length > 0 && <span>({active.length})</span>}</Button>
      </div>} filterBar={<>    {active.length > 0 && <div className={styles.filters}><span><Filter size={13} />Filtros aplicados</span>{active.map(([key, value]) => <Badge key={key} variant="secondary">{filterLabels[key as QueryKey]}: {value === "yes" ? "Sim" : value === "no" ? "Não" : value}<button aria-label={`Remover filtro ${filterLabels[key as QueryKey]}`} onClick={() => { setFilters(prev => ({ ...prev, [key]: "" })); setPage(0); }}><X size={12} /></button></Badge>)}</div>}</>} rows={rows} visible={visible} connectedCount={connected.length} search={search} setSearch={value=>{setSearch(value);setPage(0);}} clear={clear} current={current} pages={pages} onPage={setPage} onExport={()=>exportCsv("nexo-acessos-online", ["Cliente", "Login", "IP", "MAC", "POP", "OLT", "PON", "Plano", "Download", "Upload", "Uptime"], rows.map(s => [s.name, s.access?.login || "", s.access?.ip || "", s.access?.mac || "", s.pop, s.access?.olt || "", s.access?.pon || "", s.plan, s.access?.download || "", s.access?.upload || "", s.access?.uptime || ""]))} openSubscriber={openSubscriber} source={`Estado cadastrado · ${data.snapshot.asOf}`} sourceNote="Sem leitura RADIUS ao vivo. Tráfego e duração ausentes são exibidos como “—”.">    {dialog && <NetworkQueryDialog open={dialog} onOpenChange={setDialog} filters={filters} subscribers={data.subscribers} onApply={value => { setFilters({ ...value, visibility: "online" }); setSearch(""); setPage(0); toast.success("Consulta aplicada."); }} />}</NetworkOnlineView>;
}

export type OnlineIdentity={id:string;name:string;contract:string;pop:string;nas:string;plan:string;access?:{login?:string;ip?:string;mac?:string;olt?:string;pon?:string;download?:string;upload?:string;uptime?:string}};
export type OnlineMetric={label:string;value:string;note:string;online?:boolean};
export function NetworkOnlineView({metrics,actions,filterBar,children,rows,visible,connectedCount,search,setSearch,clear,current,pages,onPage,onExport,openSubscriber,source,sourceNote,searchPlaceholder="Filtrar por cliente, IP, MAC ou login…",selectionHeader,selectionCell,rowAction}:{metrics:OnlineMetric[];actions?:ReactNode;filterBar?:ReactNode;children?:ReactNode;rows:OnlineIdentity[];visible:OnlineIdentity[];connectedCount:number;search:string;setSearch:(value:string)=>void;clear:()=>void;current:number;pages:number;onPage:(value:number)=>void;onExport:()=>void;openSubscriber:(id:string)=>void;source:string;sourceNote:string;searchPlaceholder?:string;selectionHeader?:ReactNode;selectionCell?:(row:OnlineIdentity)=>ReactNode;rowAction?:(row:OnlineIdentity)=>ReactNode}) {
 const pageSize=8;
  return <section className={styles.page}>
    <header className={styles.header}>
      <div><h1>Usuários conectados<span className={styles.statusDot} /></h1><p>Consulte os acessos online por rede, endereço ou dados do assinante.</p></div>
      {actions}
    </header>
    <div className={styles.metrics} aria-label="Resumo dos clientes online">{metrics.map(metric => <Card key={metric.label} size="sm"><CardHeader><CardDescription>{metric.label}</CardDescription></CardHeader><CardContent><strong>{metric.value}</strong></CardContent><CardFooter><span data-online={metric.online || undefined}>{metric.online && <span className={styles.statusDot} />}{metric.note}</span></CardFooter></Card>)}</div>
    {filterBar}
    <div className={styles.results}>
      <div className={styles.toolbar}>
        <InputGroup className="max-w-sm"><InputGroupInput aria-label="Buscar conexões" placeholder={searchPlaceholder} value={search} onChange={e => { setSearch(e.target.value);  }} /><InputGroupAddon><Search /></InputGroupAddon></InputGroup>
        <div className={styles.tableActions}><span aria-live="polite">{rows.length} de {connectedCount} acessos</span><Button variant="outline" size="sm" disabled={!rows.length} onClick={onExport}><Download data-icon="inline-start" />Exportar</Button></div>
      </div>
      <Table className={styles.table}><TableHeader><TableRow>{selectionHeader && <TableHead>{selectionHeader}</TableHead>}<TableHead>Cliente / login</TableHead><TableHead>IP alocado / MAC</TableHead><TableHead>POP / OLT / PON</TableHead><TableHead>Plano de acesso</TableHead><TableHead className="text-right">Download / upload</TableHead><TableHead>Uptime</TableHead><TableHead className="text-right">Ação</TableHead></TableRow></TableHeader><TableBody>{visible.map(s => <TableRow key={s.id}>
        {selectionCell && <TableCell>{selectionCell(s)}</TableCell>}<TableCell><button className={styles.identity} onClick={() => openSubscriber(s.id)}><strong><span className={styles.statusDot} />{s.name}</strong><small>{s.access?.login || s.contract}</small></button></TableCell>
        <TableCell><span className={styles.mono}>{s.access?.ip || "Não informado"}</span><small className={styles.subline}>{s.access?.mac || "MAC não informado"}</small></TableCell>
        <TableCell><span>{s.pop}</span><small className={styles.subline}>{s.access?.olt ? `${s.access.olt}${s.access.pon ? ` · ${s.access.pon}` : ""}` : s.nas || "OLT não informada"}</small></TableCell>
        <TableCell><Badge variant="outline">{s.plan}</Badge></TableCell>
        <TableCell className="text-right"><span className={styles.traffic} data-available={!!s.access?.download}><ArrowDown size={12} />{s.access?.download || "—"}</span><span className={styles.traffic}><ArrowUp size={12} />{s.access?.upload || "—"}</span></TableCell>
        <TableCell><span className={styles.mono}>{s.access?.uptime || "—"}</span></TableCell>
        <TableCell className="text-right">{rowAction ? rowAction(s) : <Button variant="outline" size="xs" aria-label={`Detalhes de ${s.name}`} onClick={() => openSubscriber(s.id)}>Detalhes</Button>}</TableCell>
      </TableRow>)}</TableBody></Table>
      {rows.length === 0 && <EmptyState icon={Search} title="Nenhum acesso encontrado" description="Revise a busca ou os filtros da consulta."><Button variant="outline" onClick={clear}>Limpar filtros</Button></EmptyState>}
      <footer className={styles.tableFooter}><span>{rows.length ? `${current * pageSize + 1}–${Math.min((current + 1) * pageSize, rows.length)} de ${rows.length} clientes` : "0 clientes"}</span><div><span>Página {current + 1} de {pages}</span><Button variant="ghost" size="icon-sm" aria-label="Página anterior" disabled={current === 0} onClick={() => onPage(current - 1)}><ChevronLeft /></Button><Button variant="ghost" size="icon-sm" aria-label="Próxima página" disabled={current + 1 >= pages} onClick={() => onPage(current + 1)}><ChevronRight /></Button></div></footer>
    </div>
    <footer className={styles.source}><span><Radio size={13} />{source}</span><span>{sourceNote}</span></footer>
    {children}
  </section>;
}
