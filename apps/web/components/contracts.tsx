"use client";

import { useState, type ReactNode } from "react";
import { useSearchParams } from "@/platform/navigation/react";
import { useQueryState, useReplaceQueryValues } from "@/lib/use-query-state";
import Link from "@/platform/navigation/link";
import { ArrowUpRight, Download, FileText, Search, MapPin } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableHeader, TableHead, TableRow, TableBody, TableCell } from "@/components/ui/table";
import { Panel, PageHeading, Status, PersonAvatar, SourceFooter, DemoNotice } from "@/components/workspace-ui";
import { EmptyState } from "@/components/workspace-feedback";
import { useWorkspace } from "@/features/workspace/context";
import { ContractDetails } from "@/components/contract-details";
import { contractMonthlyTotal, getCommercialData, type ServiceContract } from "@/lib/commercial";
import { exportCsv, money } from "@/lib/format";
import { filterContractCatalog } from "@/application/selectors/commercial";
import { QueryBoundary } from "@/features/shared/feedback";
import { contractViews } from "@/domain/view-states";

export function Contracts() {
  const { data, openSubscriber } = useWorkspace();
  return <ContractCatalog {...getCommercialData(data)} subscribers={data.subscribers} openSubscriber={openSubscriber} />;
}
export function ContractCatalog({ plans, contracts, subscribers, openSubscriber, operational = false, total, pagination, onOpen, loading, error, onExport, exportBusy }: {
 plans: import("@/domain/commercial").CatalogPlan[]; contracts: ServiceContract[]; subscribers: { id: string; name: string }[]; openSubscriber: (id: string) => void;
 operational?: boolean; total?: number; pagination?: ReactNode; onOpen?: (contract: ServiceContract) => void; loading?: boolean; error?: unknown; onExport?: () => void; exportBusy?: boolean;
}) {
 const data = { subscribers };
  const searchParams = useSearchParams();
  const replaceQueryValues = useReplaceQueryValues();
  const planId = searchParams.get("plano");
  const subscriberId = searchParams.get("assinante");
  const [query, setQuery] = useQueryState("busca", "", undefined, { resetPage: operational });
  const [status, setStatus] = useQueryState("situacao", "Todos", ["Todos", ...(operational ? ["Vigente", "Encerrado"] : contracts.map(c => c.status))], { resetPage: operational });
  const [view, setView] = useQueryState("visualizacao", "contratos", contractViews);
  const [selected, setSelected] = useState<ServiceContract | null>(null);
  const { rows, groups } = filterContractCatalog({ plans, contracts, subscribers }, { planId: operational ? null : planId, subscriberId: operational ? null : subscriberId, status: operational ? "Todos" : status, query: operational ? "" : query });
  const openContract = (contract: ServiceContract) => onOpen ? onOpen(contract) : setSelected(contract);
  const multiple = data.subscribers.filter(s => contracts.filter(c => c.subscriberId === s.id).length > 1).length;
  const clear = () => { setQuery(""); setStatus("Todos"); };
  const planName = (c: ServiceContract) => plans.find(p => p.id === c.planId)?.name ?? "Plano não encontrado";
  return <>
    <PageHeading eyebrow="ASSINANTES / CONTRATOS" title="Contratos dos assinantes" description="Um titular, vários contratos. Cada instalação ou serviço mantém seu próprio plano, endereço, mensalidade e vencimento." actions={<Button variant="outline" disabled={exportBusy} onClick={onExport ?? (() => exportCsv("nexo-contratos", ["Contrato", "Titular", "Identificação", "Endereço", "Plano", "Adicionais", "Total mensal", "Vencimento", "Status"], rows.map(c => [c.code, data.subscribers.find(s => s.id === c.subscriberId)?.name ?? "", c.label, c.address, planName(c), c.additionalServices.map(a => a.name).join("; "), contractMonthlyTotal(c), c.dueDay, c.status])))}><Download data-icon="inline-start" />Exportar contratos</Button>} />
    <div className="commercial-metrics">{[[operational ? "Contratos na consulta" : "Contratos na base", total ?? contracts.length, "Vínculos independentes"], [operational ? "Titulares nesta página" : "Titulares vinculados", new Set(contracts.map(c => c.subscriberId)).size, "Assinantes sem duplicação"], ["Com múltiplos contratos", multiple, operational ? "Titulares nesta página" : "Titulares com mais de um vínculo"], ["Adicionais registrados", operational ? "Na ficha" : contracts.reduce((n, c) => n + c.additionalServices.length, 0), "Itens do mesmo contrato"]].map(([label, value, detail]) => <div key={label}><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>)}</div>
    {(planId || subscriberId) && <div className="flex flex-wrap items-center gap-3 text-sm"><Badge variant="secondary">{planId ? `Plano: ${plans.find(p => p.id === planId)?.name ?? "não encontrado"}` : `Titular: ${data.subscribers.find(s => s.id === subscriberId)?.name ?? "não encontrado"}`}</Badge><Button variant="ghost" size="sm" onClick={() => replaceQueryValues({ plano: null, assinante: null, ...(operational ? { pagina: null } : {}) })}>Remover filtro de vínculo</Button></div>}
    <Panel title="Vínculos comerciais" description={operational ? "Consulta paginada. O agrupamento reúne os vínculos disponíveis nesta página." : "Consulte cada contrato ou agrupe todos os vínculos de um titular."} action={<Badge variant="outline">{total ?? rows.length} contratos</Badge>} className="list-panel">
      <div className="commercial-toolbar"><Tabs value={view} onValueChange={v => setView(String(v))}><TabsList variant="line" aria-label="Visualização dos contratos"><TabsTrigger value="contratos">Por contrato</TabsTrigger><TabsTrigger value="assinantes">Por assinante</TabsTrigger></TabsList></Tabs><div className="flex flex-wrap items-center gap-3"><select className="commercial-select" aria-label="Filtrar situação do contrato" value={status} onChange={e => setStatus(e.target.value)}>{["Todos", ...(operational ? ["Vigente", "Encerrado"] : new Set(contracts.map(c => c.status)))].map(v => <option key={v} value={v}>{v === "Todos" ? "Todas as situações" : v}</option>)}</select><div className="search-field"><Search size={15} /><Input aria-label="Buscar contratos" placeholder="Titular, contrato ou endereço…" value={query} onChange={e => setQuery(e.target.value)} /></div></div></div>
      <QueryBoundary loading={loading} error={error}>{view === "contratos" ? <Table><TableHeader><TableRow><TableHead>Contrato / instalação</TableHead><TableHead>Titular</TableHead><TableHead>Plano / serviços</TableHead><TableHead>Situação</TableHead><TableHead>Vencimento</TableHead><TableHead className="text-right">{operational ? "Mensalidade base" : "Total mensal"}</TableHead><TableHead><span className="sr-only">Detalhes</span></TableHead></TableRow></TableHeader><TableBody>{rows.map(c => { const s = data.subscribers.find(s => s.id === c.subscriberId); return <TableRow key={c.id}><TableCell><button className="commercial-plan-name" onClick={() => openContract(c)}><strong className="mono">{c.code}</strong><span>{c.label}</span><span className="commercial-address">{c.address}</span></button></TableCell><TableCell><button className="table-person" disabled={!s} onClick={() => openSubscriber(c.subscriberId)}><PersonAvatar small name={s?.name ?? "?"} /><strong>{s?.name ?? "Não encontrado"}</strong></button></TableCell><TableCell><div className="commercial-speed"><strong>{planName(c)}</strong><small>{c.additionalServices.length ? `${c.additionalServices.length} serviço(s) adicional(is)` : operational ? "Consulte os adicionais na ficha" : "Sem adicionais registrados"}</small></div></TableCell><TableCell><Status value={c.status} /></TableCell><TableCell>Dia {c.dueDay}</TableCell><TableCell className="text-right mono">{money(contractMonthlyTotal(c))}</TableCell><TableCell><Button variant="ghost" size="icon-sm" aria-label={`Detalhes do contrato ${c.code}`} onClick={() => openContract(c)}><ArrowUpRight /></Button></TableCell></TableRow>; })}</TableBody></Table> : <div className="commercial-groups">{groups.map(({ subscriber: s, contracts: linked }) => <section key={s.id} className="commercial-group"><header><button className="table-person" onClick={() => openSubscriber(s.id)}><PersonAvatar name={s.name} /><strong>{s.name}</strong></button><Badge variant="secondary">{linked.length} contrato(s)</Badge><span className="ml-auto text-sm text-muted-foreground">{money(linked.filter(c => !["Cancelado", "Encerrado"].includes(c.status)).reduce((sum, c) => sum + contractMonthlyTotal(c), 0))} / mês · não encerrados</span></header><div>{linked.map(c => <button key={c.id} className="commercial-contract-card" onClick={() => openContract(c)}><div className="flex items-center justify-between gap-3"><strong>{c.code} · {c.label}</strong><Status value={c.status} /></div><p>{planName(c)}</p><span><MapPin size={14} />{c.address}</span><div className="flex items-center justify-between gap-3"><b>{money(contractMonthlyTotal(c))} / mês</b><small>Vence dia {c.dueDay}<ArrowUpRight size={13} /></small></div></button>)}</div></section>)}</div>}
      {!rows.length && <EmptyState icon={FileText} title="Nenhum contrato encontrado" description="Confira a busca, a situação e os filtros de vínculo."><Button variant="outline" onClick={clear}>Limpar busca e situação</Button>{(planId || subscriberId) && <Link href="/contratos" className={buttonVariants({ variant: "ghost" })}>Ver todos os contratos</Link>}</EmptyState>}
      </QueryBoundary>{pagination}
    </Panel>
    {!operational && <><DemoNotice>Consulta somente leitura. A base legada contém um contrato por assinante; não criamos instalações ou serviços fictícios adicionais. A estrutura agora admite vários contratos por titular e adicionais por contrato.</DemoNotice><SourceFooter sample="Contratos identificados na base demonstrativa" /></>}<ContractDetails contract={selected} plans={plans} subscriber={data.subscribers.find(s => s.id === selected?.subscriberId)} onClose={() => setSelected(null)} openSubscriber={openSubscriber} />
  </>;
}
