"use client";

import { useState, type ReactNode } from "react";
import { useQueryState } from "@/lib/use-query-state";
import Link from "@/platform/navigation/link";
import { ArrowDown, ArrowUp, ArrowDownToLine, ArrowUpDown, ArrowUpRight, ChevronRight, FileText, Gauge, Layers, Search, SlidersHorizontal, Users, Wallet } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableHeader, TableHead, TableRow, TableBody, TableCell } from "@/components/ui/table";
import { PageHeading, SourceFooter } from "@/components/workspace-ui";
import { EmptyState } from "@/components/workspace-feedback";
import { useWorkspace } from "@/features/workspace/context";
import { PlanDetails } from "@/components/plan-details";
import { getCommercialData, type CatalogPlan } from "@/lib/commercial";
import { exportCsv, money } from "@/lib/format";
import styles from "@/components/plans.module.css";
import { selectPlans } from "@/application/selectors/commercial";

export function Plans() {
  const { data } = useWorkspace();
  return <PlanCatalog {...getCommercialData(data)} />;
}

export function PlanCatalog({ plans, contracts, activeCounts, recurringTotal, actions, detailActions }: {
  plans: CatalogPlan[]; contracts: import("@/domain/commercial").ServiceContract[];
  activeCounts?: Record<string, number>; recurringTotal?: number | null; actions?: ReactNode; detailActions?: (plan: CatalogPlan) => ReactNode;
}) {
  const operational = Boolean(activeCounts);
  const data = { subscribers: [], commercialPlans: plans, contracts };
  const [query, setQuery] = useQueryState("busca", "");
  const [service, setService] = useQueryState("servico", "Todos", ["Todos", ...plans.map(p => p.serviceType)]);
  const [pop, setPop] = useQueryState("pop", "", ["", ...contracts.map(c => c.pop)]);
  const [sort, setSort] = useQueryState<"name" | "active" | "speed">("ordem", "name", ["name", "active", "speed"]);
  const [selected, setSelected] = useState<CatalogPlan | null>(null);
  const rows = selectPlans(data, { query, service, pop, sort }).map(row => ({ ...row, activeCount: activeCounts?.[row.plan.id] ?? row.usage.active })).sort((a, b) => sort === "active" ? b.activeCount - a.activeCount : 0);
  const pops = [...new Set(contracts.map(c => c.pop).filter(Boolean))].sort();
  const active = contracts.filter(c => c.status === "Ativo");
  const recurring = active.reduce((sum, c) => sum + c.price, 0);
  const download = Math.max(0, ...plans.map(p => p.download ?? 0));
  const services = ["Todos", ...new Set(plans.map(p => p.serviceType))];
  const reset = () => { setQuery(""); setService("Todos"); setPop(""); };
  const filtered = query || service !== "Todos" || pop;

  const selectedPlan = selected ? plans.find(plan => plan.id === selected.id) ?? selected : null;
  if (selectedPlan) return <PlanDetails key={selectedPlan.id} plan={selectedPlan} contracts={contracts} onClose={() => setSelected(null)} operational={operational} activeCount={activeCounts?.[selectedPlan.id]} actions={detailActions?.(selectedPlan)} />;

  return <div className={styles.page}>
    <PageHeading eyebrow="COMERCIAL / CATÁLOGO" title="Planos & ofertas" description="Perfis de banda, condições comerciais e utilização dos planos da sua rede." actions={<>{actions}<Button variant="outline" onClick={() => exportCsv("nexo-catalogo-planos", ["Plano", "Serviço", "Download Mbps", "Upload Mbps", "Preço de catálogo", "Ativos", "Suspensos", "Em instalação", "Total"], rows.map(({ plan: p, usage: u, activeCount }) => [p.name, p.serviceType, p.download ?? "Não informado", p.upload ?? "Não informado", p.price ?? "Não informado", activeCount, operational ? "Não consultado" : u.suspended, operational ? "Não consultado" : u.installing, operational ? "Não consultado" : u.contracts.length]))}><ArrowDownToLine data-icon="inline-start" />Exportar catálogo</Button></>} />

    <div className={styles.metrics}>
      {[{ label: "Planos no catálogo", value: plans.length, detail: `${services.length - 1} ${services.length === 2 ? "tipo de serviço" : "tipos de serviço"}`, icon: Layers },
        { label: "Contratos ativos", value: activeCounts ? Object.values(activeCounts).reduce((sum, value) => sum + value, 0) : active.length, detail: operational ? "Contratos vigentes por plano" : `${contracts.length} contratos na base`, icon: Users },
        { label: "Mensalidades ativas", value: operational ? (recurringTotal == null ? "—" : money(recurringTotal)) : money(recurring), detail: operational ? "Valores base dos contratos vigentes" : "Valores base · sem serviços adicionais", icon: Wallet },
        { label: "Maior perfil de banda", value: `${download} Mbps`, detail: "Download configurado no plano", icon: Gauge }].map(item => <section className={styles.metric} key={item.label}><div><span>{item.label}</span><item.icon size={16} aria-hidden="true" /></div><strong>{item.value}</strong><small>{item.detail}</small></section>)}
    </div>

    <section className={styles.catalog} aria-label="Catálogo de planos">
      <div className={styles.catalogHeader}><div><h2>Catálogo de planos <Badge variant="secondary">{plans.length}</Badge></h2><p>Consulte a configuração e os contratos de cada oferta.</p></div><span className={styles.readonly}><span />Consulta da base</span></div>
      <div className={styles.filters}>
        <Tabs value={service} onValueChange={value => setService(String(value))}><TabsList aria-label="Filtrar por serviço">{services.map(value => <TabsTrigger value={value} key={value}>{value === "Todos" ? "Todos os planos" : value === "Serviço" ? "Serviços" : value}</TabsTrigger>)}</TabsList></Tabs>
        <div className={styles.search}><Search size={15} aria-hidden="true" /><Input aria-label="Buscar planos" placeholder="Buscar nome, velocidade ou POP…" value={query} onChange={e => setQuery(e.target.value)} /></div>
      </div>
      <div className={styles.subfilters}><div><SlidersHorizontal size={14} aria-hidden="true" /><select aria-label="Filtrar por POP vinculado" disabled={operational} value={pop} onChange={e => setPop(e.target.value)}><option value="">Todos os POPs</option>{pops.map(p => <option key={p}>{p}</option>)}</select>{filtered && <Button variant="ghost" size="sm" onClick={reset}>Limpar filtros</Button>}</div><span>{rows.length} de {plans.length} planos</span></div>
      <Table className={styles.table}><TableHeader><TableRow>
        <TableHead><button onClick={() => setSort("name")} aria-label="Ordenar por nome">Plano / serviço<ArrowUpDown size={12} /></button></TableHead>
        <TableHead><button onClick={() => setSort("speed")} aria-label="Ordenar por velocidade">Perfil de banda<ArrowUpDown size={12} /></button></TableHead>
        <TableHead className="text-center"><button onClick={() => setSort("active")} aria-label="Ordenar por contratos ativos">Ativos<ArrowUpDown size={12} /></button></TableHead>
        <TableHead className="text-center">Suspensos</TableHead><TableHead className="text-center">Total</TableHead><TableHead className="text-right">Preço de catálogo</TableHead><TableHead className="text-right">Configuração</TableHead>
      </TableRow></TableHeader><TableBody>{rows.map(({ plan: p, usage: u, activeCount }) => <TableRow key={p.id}>
        <TableCell><button className={styles.planName} onClick={() => setSelected(p)}><span className={styles.planIcon}><Layers size={17} /></span><span><strong>{p.name}</strong><small>{p.serviceType} <span>·</span> {p.source === "legacy" ? "Origem: contratos" : p.active ? "Disponível" : p.active === false ? "Indisponível" : "Disponibilidade não informada"}</small></span></button></TableCell>
        <TableCell><div className={styles.speed}><span><ArrowDown size={13} /><strong>{p.download === null ? "—" : p.download}</strong><small>Mbps</small></span><span><ArrowUp size={12} />{p.upload === null ? "Upload não informado" : `${p.upload} Mbps`}</span></div></TableCell>
        <TableCell className="text-center"><span className={styles.activeCount}>{activeCount}</span></TableCell><TableCell className="text-center"><span className={styles.suspendedCount}>{operational ? "—" : u.suspended}</span></TableCell><TableCell className="text-center mono">{operational ? "—" : u.contracts.length}</TableCell>
        <TableCell className="text-right"><div className={styles.price}><strong>{p.price === null ? "Não definido" : money(p.price)}</strong><small>{p.price === null ? "Não inferido da mensalidade" : "por mês"}</small></div></TableCell>
        <TableCell className="text-right"><Button variant="ghost" size="sm" aria-label={`Abrir configuração de ${p.name}`} onClick={() => setSelected(p)}>Abrir<ChevronRight data-icon="inline-end" /></Button></TableCell>
      </TableRow>)}</TableBody></Table>
      {!rows.length && <EmptyState icon={FileText} title="Nenhum plano encontrado" description="Tente outro nome, velocidade ou POP."><Button variant="outline" onClick={reset}>Limpar filtros</Button></EmptyState>}
      <div className={styles.tableFooter}><span>{operational ? "Contagens técnicas não presumidas a partir do cadastro comercial" : `${rows.reduce((sum, row) => sum + row.usage.contracts.length, 0)} contratos nos planos exibidos`}</span><Link href="/contratos">Consultar contratos<ArrowUpRight size={13} /></Link></div>
    </section>
    <div className={styles.bottomNote}><span>{operational ? "Catálogo operacional. Versões anteriores permanecem nos contratos que as utilizaram." : "Planos legados identificados nos contratos. Dados ausentes permanecem sem definição."}</span><Link href="/contratos" className={buttonVariants({ variant: "ghost", size: "sm" })}>Contratos dos assinantes<ArrowUpRight data-icon="inline-end" /></Link></div>
    {!operational && <SourceFooter sample="Catálogo da base demonstrativa · consulta somente leitura" />}
  </div>;
}
