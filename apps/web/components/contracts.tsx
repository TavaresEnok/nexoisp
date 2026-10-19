"use client";

import { useState } from "react";
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
import { useWorkspace } from "@/components/workspace-provider";
import { ContractDetails } from "@/components/contract-details";
import { contractMonthlyTotal, getCommercialData, type ServiceContract } from "@/lib/commercial";
import { exportCsv, money } from "@/lib/format";
import { selectContracts } from "@/application/selectors/commercial";
import { contractViews } from "@/domain/view-states";

export function Contracts() {
  const { data, openSubscriber } = useWorkspace();
  const { plans, contracts } = getCommercialData(data);
  const searchParams = useSearchParams();
  const replaceQueryValues = useReplaceQueryValues();
  const planId = searchParams.get("plano");
  const subscriberId = searchParams.get("assinante");
  const [query, setQuery] = useQueryState("busca", "");
  const [status, setStatus] = useQueryState("situacao", "Todos", ["Todos", ...contracts.map(c => c.status)]);
  const [view, setView] = useQueryState("visualizacao", "contratos", contractViews);
  const [selected, setSelected] = useState<ServiceContract | null>(null);
  const { rows, groups } = selectContracts(data, { planId, subscriberId, status, query });
  const multiple = data.subscribers.filter(s => contracts.filter(c => c.subscriberId === s.id).length > 1).length;
  const clear = () => { setQuery(""); setStatus("Todos"); };
  const planName = (c: ServiceContract) => plans.find(p => p.id === c.planId)?.name ?? "Plano não encontrado";
  return <>
    <PageHeading eyebrow="ASSINANTES / CONTRATOS" title="Contratos dos assinantes" description="Um titular, vários contratos. Cada instalação ou serviço mantém seu próprio plano, endereço, mensalidade e vencimento." actions={<Button variant="outline" onClick={() => exportCsv("nexo-contratos", ["Contrato", "Titular", "Identificação", "Endereço", "Plano", "Adicionais", "Total mensal", "Vencimento", "Status"], rows.map(c => [c.code, data.subscribers.find(s => s.id === c.subscriberId)?.name ?? "", c.label, c.address, planName(c), c.additionalServices.map(a => a.name).join("; "), contractMonthlyTotal(c), c.dueDay, c.status]))}><Download data-icon="inline-start" />Exportar contratos</Button>} />
    <div className="commercial-metrics">{[["Contratos na base", contracts.length, "Vínculos independentes"], ["Titulares vinculados", new Set(contracts.map(c => c.subscriberId)).size, "Assinantes sem duplicação"], ["Com múltiplos contratos", multiple, "Titulares com mais de um vínculo"], ["Adicionais registrados", contracts.reduce((n, c) => n + c.additionalServices.length, 0), "Itens do mesmo contrato"]].map(([label, value, detail]) => <div key={label}><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>)}</div>
    {(planId || subscriberId) && <div className="flex flex-wrap items-center gap-3 text-sm"><Badge variant="secondary">{planId ? `Plano: ${plans.find(p => p.id === planId)?.name ?? "não encontrado"}` : `Titular: ${data.subscribers.find(s => s.id === subscriberId)?.name ?? "não encontrado"}`}</Badge><Button variant="ghost" size="sm" onClick={() => replaceQueryValues({ plano: null, assinante: null })}>Remover filtro de vínculo</Button></div>}
    <Panel title="Vínculos comerciais" description="Consulte cada contrato ou agrupe todos os vínculos de um titular." action={<Badge variant="outline">{rows.length} contratos</Badge>} className="list-panel">
      <div className="commercial-toolbar"><Tabs value={view} onValueChange={v => setView(String(v))}><TabsList variant="line" aria-label="Visualização dos contratos"><TabsTrigger value="contratos">Por contrato</TabsTrigger><TabsTrigger value="assinantes">Por assinante</TabsTrigger></TabsList></Tabs><div className="flex flex-wrap items-center gap-3"><select className="commercial-select" aria-label="Filtrar situação do contrato" value={status} onChange={e => setStatus(e.target.value)}>{["Todos", ...new Set(contracts.map(c => c.status))].map(v => <option key={v} value={v}>{v === "Todos" ? "Todas as situações" : v}</option>)}</select><div className="search-field"><Search size={15} /><Input aria-label="Buscar contratos" placeholder="Titular, contrato ou endereço…" value={query} onChange={e => setQuery(e.target.value)} /></div></div></div>
      {view === "contratos" ? <Table><TableHeader><TableRow><TableHead>Contrato / instalação</TableHead><TableHead>Titular</TableHead><TableHead>Plano / serviços</TableHead><TableHead>Situação</TableHead><TableHead>Vencimento</TableHead><TableHead className="text-right">Total mensal</TableHead><TableHead><span className="sr-only">Detalhes</span></TableHead></TableRow></TableHeader><TableBody>{rows.map(c => { const s = data.subscribers.find(s => s.id === c.subscriberId); return <TableRow key={c.id}><TableCell><button className="commercial-plan-name" onClick={() => setSelected(c)}><strong className="mono">{c.code}</strong><span>{c.label}</span><span className="commercial-address">{c.address}</span></button></TableCell><TableCell><button className="table-person" disabled={!s} onClick={() => openSubscriber(c.subscriberId)}><PersonAvatar small name={s?.name ?? "?"} /><strong>{s?.name ?? "Não encontrado"}</strong></button></TableCell><TableCell><div className="commercial-speed"><strong>{planName(c)}</strong><small>{c.additionalServices.length ? `${c.additionalServices.length} serviço(s) adicional(is)` : "Sem adicionais registrados"}</small></div></TableCell><TableCell><Status value={c.status} /></TableCell><TableCell>Dia {c.dueDay}</TableCell><TableCell className="text-right mono">{money(contractMonthlyTotal(c))}</TableCell><TableCell><Button variant="ghost" size="icon-sm" aria-label={`Detalhes do contrato ${c.code}`} onClick={() => setSelected(c)}><ArrowUpRight /></Button></TableCell></TableRow>; })}</TableBody></Table> : <div className="commercial-groups">{groups.map(({ subscriber: s, contracts: linked }) => <section key={s.id} className="commercial-group"><header><button className="table-person" onClick={() => openSubscriber(s.id)}><PersonAvatar name={s.name} /><strong>{s.name}</strong></button><Badge variant="secondary">{linked.length} contrato(s)</Badge><span className="ml-auto text-sm text-muted-foreground">{money(linked.filter(c => !["Cancelado", "Encerrado"].includes(c.status)).reduce((sum, c) => sum + contractMonthlyTotal(c), 0))} / mês · não encerrados</span></header><div>{linked.map(c => <button key={c.id} className="commercial-contract-card" onClick={() => setSelected(c)}><div className="flex items-center justify-between gap-3"><strong>{c.code} · {c.label}</strong><Status value={c.status} /></div><p>{planName(c)}</p><span><MapPin size={14} />{c.address}</span><div className="flex items-center justify-between gap-3"><b>{money(contractMonthlyTotal(c))} / mês</b><small>Vence dia {c.dueDay}<ArrowUpRight size={13} /></small></div></button>)}</div></section>)}</div>}
      {!rows.length && <EmptyState icon={FileText} title="Nenhum contrato encontrado" description="Confira a busca, a situação e os filtros de vínculo."><Button variant="outline" onClick={clear}>Limpar busca e situação</Button>{(planId || subscriberId) && <Link href="/contratos" className={buttonVariants({ variant: "ghost" })}>Ver todos os contratos</Link>}</EmptyState>}
    </Panel>
    <DemoNotice>Consulta somente leitura. A base legada contém um contrato por assinante; não criamos instalações ou serviços fictícios adicionais. A estrutura agora admite vários contratos por titular e adicionais por contrato.</DemoNotice><SourceFooter sample="Contratos identificados na base demonstrativa" /><ContractDetails contract={selected} plans={plans} subscriber={data.subscribers.find(s => s.id === selected?.subscriberId)} onClose={() => setSelected(null)} openSubscriber={openSubscriber} />
  </>;
}
