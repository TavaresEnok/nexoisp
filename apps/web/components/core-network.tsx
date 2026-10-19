"use client";

import { useState, type ReactNode } from "react";
import { isDemoMode } from "@/application/execution-mode";
import { useQueryState } from "@/lib/use-query-state";
import { Download, Eye, Network, Router, Shield, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { PageHeading, SourceFooter } from "@/components/workspace-ui";
import { OpticalMetrics, OpticalEmpty } from "@/components/optical-ui";
import { TechnicalNotice } from "@/components/technical-ui";
import { coreSections, coreRecords, CoreRecordDetails, type CoreRecord } from "@/components/core-records";
import { cgnatCapacity, rangeSize, type TechnicalCatalog, type CoreTab } from "@/lib/technical-catalog";
import { exportCsv, normalize, number } from "@/lib/format";
import styles from "@/components/technical.module.css";

export function CoreNetwork({ catalog, initialTab = "pools" }: { catalog: TechnicalCatalog; initialTab?: CoreTab }) {
  const [tab, setTab] = useQueryState<CoreTab>("tab", initialTab, Object.keys(coreSections) as CoreTab[]);
  const [query, setQuery] = useQueryState("busca", "");
  const [nas, setNas] = useQueryState("nas", "", ["", ...catalog.nas.map(n => n.id)]);
  const [status, setStatus] = useQueryState("situacao", "", ["", ...coreRecords(catalog, tab).map(row => row.status)]);
  const [selected, setSelected] = useState<CoreRecord | null>(null);
  const all = coreRecords(catalog, tab);
  const rows = all.filter(row => normalize(row.search).includes(normalize(query)) && (!nas || row.nasId === nas) && (!status || row.status === status));
  const total = catalog.pools.reduce((sum, p) => sum + rangeSize(p.ranges), 0);
  const free = catalog.pools.reduce((sum, p) => sum + p.free, 0);
  const section = coreSections[tab];
  const insufficient = catalog.cgnat.filter(p => cgnatCapacity(p).deficit > 0).length;
  const reset = () => { setQuery(""); setNas(""); setStatus(""); };
  return <div className={styles.page}><PageHeading eyebrow="REDE / FTTx · CORE NETWORK" title="Endereçamento sob controle." description="Pools IP, concentradores RADIUS, tradução de portas e conectividade de gerência." actions={<Button variant="outline" disabled={!rows.length} onClick={() => exportCsv(`nexo-core-${tab}`, [...section.columns], rows.map(row => row.csv))}><Download data-icon="inline-start" />Exportar consulta</Button>} /><OpticalMetrics items={[
    { label: "Endereços nos pools", value: number(total), detail: `${number(free)} livres · total bruto das faixas`, icon: Network },
    { label: "NAS disponíveis no cenário", value: `${catalog.nas.filter(n => n.status === "Online").length} / ${catalog.nas.length}`, detail: "Estado estático · sem monitoramento real", icon: Router },
    { label: "Planos de CGNAT", value: catalog.cgnat.length, detail: `${insufficient} com capacidade insuficiente`, icon: Shield },
    { label: "Pontos de presença", value: catalog.pops.length, detail: "POPs do laboratório · não da rede real", icon: Users },
  ]} /><TechnicalNotice>{isDemoMode ? "Dados fictícios do cenário local, separados do inventário operacional." : "Dados fictícios de laboratório persistidos no Neon, separados do inventário operacional."} Consulta, filtros, exportação e cálculo local disponíveis. Sem alterações, segredos ou comandos remotos.</TechnicalNotice><Tabs value={tab} onValueChange={value => { setTab(value as CoreTab); reset(); setSelected(null); }}><div className="overflow-x-auto"><TabsList variant="line" aria-label="Áreas de Core Network">{(Object.keys(coreSections) as CoreTab[]).map(key => { const item = coreSections[key]; return <TabsTrigger key={key} value={key}><item.icon />{item.label}</TabsTrigger>; })}</TabsList></div><TabsContent value={tab} aria-label={section.label}><section className={styles.catalog}><div className={styles.catalogHeader}><div><h2>{section.title}<Badge variant="secondary">{all.length}</Badge></h2><p>{section.description}</p></div><Badge variant="outline">Cenário · {new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium", timeZone: "America/Recife" }).format(new Date(catalog.asOf))}</Badge></div><div className={styles.toolbar}><div className={styles.search}><Input aria-label={`Buscar em ${section.label}`} placeholder="Nome, endereço ou identificação…" value={query} onChange={e => setQuery(e.target.value)} /></div>{tab !== "pops" && <select aria-label="Filtrar por NAS" value={nas} onChange={e => setNas(e.target.value)}><option value="">Todos os concentradores</option>{catalog.nas.map(n => <option key={n.id} value={n.id}>{n.name}</option>)}</select>}<select aria-label="Filtrar estado" value={status} onChange={e => setStatus(e.target.value)}><option value="">Todos os estados</option>{[...new Set(all.map(row => row.status))].map(value => <option key={value}>{value}</option>)}</select>{(query || nas || status) && <Button variant="ghost" size="sm" onClick={reset}>Limpar</Button>}<small>{rows.length} de {all.length} registros</small></div><Table className={styles.table}><TableHeader><TableRow>{section.columns.map(label => <TableHead key={label}>{label}</TableHead>)}<TableHead className="text-right">Ações</TableHead></TableRow></TableHeader><TableBody>{rows.map(row => <TableRow key={row.id}>{row.cells.map((cell, index) => <TableCell key={index}>{cell}</TableCell>)}<TableCell className="text-right"><Button variant="ghost" size="icon-sm" aria-label={`Detalhes de ${row.name}`} onClick={() => setSelected(row)}><Eye /></Button></TableCell></TableRow>)}</TableBody></Table>{!rows.length && <OpticalEmpty title="Nenhum registro encontrado" description="Amplie a consulta alterando a busca, o concentrador ou o estado." />}<div className={styles.footer}><span>{rows.length} registros na seleção</span><span>{tab === "pools" ? "Contagem bruta · categorias exclusivas no cenário" : tab === "cgnat" ? "Capacidade por blocos inteiros de portas · RFC 5737" : "Informações de referência · sem telemetria em tempo real"}</span></div></section></TabsContent></Tabs><SourceFooter asOf={catalog.asOf} sample="Core Network demonstrativo no Neon · somente leitura" />{selected && <CoreRecordDetails record={selected} tab={tab} catalog={catalog} onClose={() => setSelected(null)} />}</div>;
}

export type CoreFrameTab = { value: CoreTab; href: string };
// Cabeçalho e abas do Core Network do v0 para páginas conectadas, uma rota por área.
export function CoreNetworkFrame({ tab, tabs, onTab, title = "Endereçamento sob controle.", description, actions, notice, children }: { tab: CoreTab; tabs: CoreFrameTab[]; onTab: (href: string) => void; title?: string; description: string; actions?: ReactNode; notice?: ReactNode; children: ReactNode }) {
  return <div className={styles.page}><PageHeading eyebrow="REDE / FTTx · CORE NETWORK" title={title} description={description} actions={actions} />{notice}<Tabs value={tab} onValueChange={value => { const target = tabs.find(item => item.value === value); if (target) onTab(target.href); }}><div className="overflow-x-auto"><TabsList variant="line" aria-label="Áreas de Core Network">{tabs.map(({ value }) => { const item = coreSections[value]; return <TabsTrigger key={value} value={value}><item.icon />{item.label}</TabsTrigger>; })}</TabsList></div></Tabs>{children}</div>;
}
