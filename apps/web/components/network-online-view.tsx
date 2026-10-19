import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Download, Radio, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Table, TableHeader, TableHead, TableBody, TableRow, TableCell } from "@/components/ui/table";
import { Card, CardHeader, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { EmptyState } from "@/components/workspace-feedback";
import styles from "./network-online.module.css";
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
