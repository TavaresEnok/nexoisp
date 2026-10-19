"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowUpRight, CalendarDays, ClipboardList, Headphones, Info, MessageSquareText, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { InputGroup, InputGroupInput, InputGroupAddon } from "@/components/ui/input-group";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/workspace-feedback";
import { ProfileFacts, ProfileSection } from "@/components/subscriber-profile-sections";
import { ServiceOrderDetails } from "@/components/service-order-details";
import { ActiveFilters, Status } from "@/components/workspace-ui";
import { getSubscriberServiceRecords } from "@/lib/service-records";
import { date } from "@/lib/format";
import type { Subscriber, WorkspaceData } from "@/lib/types";
import styles from "./service-records.module.css";

export function SubscriberService({ subscriber, data, navigate }: { subscriber: Subscriber; data: WorkspaceData; navigate: (href: string) => void }) {
  const [tab, setTab] = useState("ocorrencias");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("Todos");
  const [selected, setSelected] = useState<{ type: "order" | "ticket"; id: string } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const previousSelection = useRef<string | undefined>(undefined);
  const listScroll = useRef(0);
  const selectRecord = (selection: typeof selected) => {
    if (selection) listScroll.current = root.current?.closest<HTMLElement>('[data-slot="tabs-content"]')?.scrollTop ?? 0;
    setSelected(selection);
  };
  useLayoutEffect(() => {
    const selectionKey = selected ? `${selected.type}:${selected.id}` : undefined;
    if (previousSelection.current === selectionKey) return;
    const scrollContainer = root.current?.closest<HTMLElement>('[data-slot="tabs-content"]');
    scrollContainer?.scrollTo({ top: selected ? 0 : listScroll.current });
    const returnTarget = Array.from(root.current?.querySelectorAll<HTMLElement>("[data-record-id]") ?? []).find(element => element.dataset.recordId === previousSelection.current);
    const target = selected ? root.current?.querySelector<HTMLElement>("[data-detail-title]") : returnTarget ?? root.current?.querySelector<HTMLElement>('[data-slot="tabs-trigger"][data-active]');
    target?.focus({ preventScroll: true });
    previousSelection.current = selectionKey;
  }, [selected]);
  const { profile, tickets, orders, records, recordCount } = getSubscriberServiceRecords(subscriber, data, query, status);
  const order = selected?.type === "order" ? profile.orders.find(order => order.id === selected.id) : undefined;
  const ticket = selected?.type === "ticket" ? profile.tickets.find(ticket => ticket.id === selected.id) : undefined;
  const reset = () => { setQuery(""); setStatus("Todos"); };
  const changeTab = (value: string) => { setTab(value); setStatus("Todos"); };
  const statuses = [...new Set((tab === "ocorrencias" ? profile.tickets : profile.orders).map(item => item.status))];
  const statusItems = ["Todos", ...statuses].map(value => ({ value, label: value === "Todos" ? "Todas as situações" : value }));
  const count = tab === "ocorrencias" ? tickets.length : tab === "ordens" ? orders.length : records.length;
  const total = tab === "ocorrencias" ? profile.tickets.length : tab === "ordens" ? profile.orders.length : recordCount;
  const noResults = <EmptyState icon={Search} title={query || status !== "Todos" ? "Nenhum resultado para estes filtros" : "Nenhum registro vinculado"} description="A consulta considera somente os registros deste assinante.">{(query || status !== "Todos") && <Button variant="outline" size="sm" onClick={reset}>Limpar filtros</Button>}</EmptyState>;

  if (order || ticket) return <div ref={root} className={styles.workspace}>
    <div className={styles.detailHeading}><Button variant="ghost" size="sm" onClick={() => selectRecord(null)}><ArrowLeft data-icon="inline-start" />Voltar para {tab === "ocorrencias" ? "ocorrências" : tab === "ordens" ? "ordens de serviço" : "anotações e registros"}</Button><Badge variant="outline">Somente leitura</Badge></div>
    {order ? <><header className={styles.heading}><div><p className="eyebrow">ORDEM DE SERVIÇO</p><h3 data-detail-title tabIndex={-1}>{order.type}</h3></div></header><ServiceOrderDetails key={order.id} order={order} subscriber={subscriber} provider={data.snapshot.provider} reference={data.snapshot.asOf} /></> : ticket && <>
      <header className={styles.heading}><div><p className="eyebrow">OCORRÊNCIA #{ticket.code}</p><h3 data-detail-title tabIndex={-1}>{ticket.subject}</h3></div><Status value={ticket.status} /></header>
      <div className={styles.detailColumns}><ProfileSection title="Dados da ocorrência" caption="Atendimento vinculado ao titular."><ProfileFacts items={[["Número", `#${ticket.code}`], ["Abertura", date(ticket.opened)], ["Responsável", ticket.agent || "Não atribuído"], ["Tipo de ocorrência", ticket.category], ["Canal de origem", ticket.channel], ["Prioridade", ticket.priority], ["SLA registrado", ticket.sla], ["Espera registrada", `${ticket.wait} min`]]} /></ProfileSection><ProfileSection title="Contexto do assinante"><ProfileFacts items={[["Titular", subscriber.name], ["Código", subscriber.code], ["Conexão cadastrada", <Status key="connection" value={subscriber.connection} />], ["Bairro", subscriber.neighborhood]]} /></ProfileSection></div>
      <ProfileSection title="Conteúdo disponível"><p className={styles.longText}>{ticket.subject}</p><p className="profile-footnote"><Info size={13} />Comentários, anexos e vínculo direto entre esta ocorrência e uma OS não foram informados na base. As OS abaixo pertencem ao assinante, não necessariamente a este chamado.</p></ProfileSection>
      <Button variant="outline" onClick={() => { setSelected(null); changeTab("ordens"); reset(); }}><CalendarDays data-icon="inline-start" />Consultar OS do assinante</Button>
    </>}
  </div>;

  return <div ref={root} className={styles.workspace}>
    <header className={styles.heading}><div><p className="eyebrow">ATENDIMENTO E CAMPO</p><h3>Uma história, todo o contexto.</h3><p>Ocorrências, visitas e registros de {subscriber.name.split(" ")[0]}.</p></div><Badge variant="outline">Consulta demonstrativa</Badge></header>
    <div className={styles.summary}>
      <button onClick={() => changeTab("ocorrencias")}><Headphones size={16} /><span><small>Ocorrências em aberto</small><strong>{String(profile.openTickets.length).padStart(2, "0")}</strong></span><ArrowUpRight size={14} /></button>
      <button onClick={() => changeTab("ordens")}><CalendarDays size={16} /><span><small>OS pendentes</small><strong>{String(profile.openOrders.length).padStart(2, "0")}</strong></span><ArrowUpRight size={14} /></button>
      <button onClick={() => changeTab("registros")}><MessageSquareText size={16} /><span><small>Anotações e registros</small><strong>{String(recordCount).padStart(2, "0")}</strong></span><ArrowUpRight size={14} /></button>
    </div>
    <Tabs value={tab} onValueChange={value => changeTab(String(value))} className={styles.recordsTabs}>
      <div className={styles.tabScroll}><TabsList variant="line" aria-label="Atendimento do assinante"><TabsTrigger value="ocorrencias"><Headphones data-icon="inline-start" />Ocorrências<Badge variant="secondary">{profile.tickets.length}</Badge></TabsTrigger><TabsTrigger value="ordens"><ClipboardList data-icon="inline-start" /><span className={styles.fullLabel}>Ordens de serviço</span><span className={styles.shortLabel}>OS</span><Badge variant="secondary">{profile.orders.length}</Badge></TabsTrigger><TabsTrigger value="registros"><MessageSquareText data-icon="inline-start" /><span className={styles.fullLabel}>Anotações e registros</span><span className={styles.shortLabel}>Registros</span><Badge variant="secondary">{recordCount}</Badge></TabsTrigger></TabsList></div>
      <div className={styles.toolbar}>
        <InputGroup><InputGroupInput aria-label="Buscar nos registros do assinante" placeholder="Buscar número, assunto ou responsável…" value={query} onChange={event => setQuery(event.target.value)} /><InputGroupAddon><Search /></InputGroupAddon></InputGroup>
        {tab !== "registros" && <Select value={status} onValueChange={value => setStatus(String(value ?? "Todos"))} items={statusItems}><SelectTrigger aria-label="Filtrar situação dos registros"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{statusItems.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent></Select>}
      </div>
      <ActiveFilters count={count} onClear={reset} filters={[
        ...(query.trim() ? [{ label: `Busca: ${query.trim()}`, onRemove: () => setQuery("") }] : []),
        ...(tab !== "registros" && status !== "Todos" ? [{ label: `Situação: ${status}`, onRemove: () => setStatus("Todos") }] : []),
      ]} />
      <TabsContent value="ocorrencias">
        {tickets.length ? <Table><TableHeader><TableRow><TableHead>Ocorrência / assunto</TableHead><TableHead>Situação</TableHead><TableHead>Abertura</TableHead><TableHead>Responsável / origem</TableHead><TableHead><span className="sr-only">Consultar</span></TableHead></TableRow></TableHeader><TableBody>{tickets.map(ticket => <TableRow key={ticket.id}><TableCell><button className={styles.recordLink} data-record-id={`ticket:${ticket.id}`} onClick={() => selectRecord({ type: "ticket", id: ticket.id })}><span className="mono">#{ticket.code}</span><strong>{ticket.subject}</strong><small>{ticket.category} · {ticket.priority}</small></button></TableCell><TableCell><Status value={ticket.status} /></TableCell><TableCell>{date(ticket.opened)}</TableCell><TableCell><span className={styles.cellStack}>{ticket.agent || "Não atribuído"}<small>{ticket.channel}</small></span></TableCell><TableCell><Button variant="ghost" size="icon-sm" aria-label={`Consultar ocorrência ${ticket.code}`} onClick={() => selectRecord({ type: "ticket", id: ticket.id })}><ArrowUpRight /></Button></TableCell></TableRow>)}</TableBody></Table> : noResults}
      </TabsContent>
      <TabsContent value="ordens">
        {orders.length ? <Table><TableHeader><TableRow><TableHead>OS / serviço</TableHead><TableHead>Situação</TableHead><TableHead>Agenda / previsão</TableHead><TableHead>Técnico</TableHead><TableHead><span className="sr-only">Consultar</span></TableHead></TableRow></TableHeader><TableBody>{orders.map(order => <TableRow key={order.id}><TableCell><button className={styles.recordLink} data-record-id={`order:${order.id}`} onClick={() => selectRecord({ type: "order", id: order.id })}><span className="mono">OS #{order.code}</span><strong>{order.type}</strong><small>{order.neighborhood}</small></button></TableCell><TableCell><Status value={order.status} /></TableCell><TableCell><span className={styles.cellStack}>{order.time}<small>{order.duration} min previstos</small></span></TableCell><TableCell>{order.technician || "Não atribuído"}</TableCell><TableCell><Button variant="ghost" size="icon-sm" aria-label={`Consultar OS ${order.code}`} onClick={() => selectRecord({ type: "order", id: order.id })}><ArrowUpRight /></Button></TableCell></TableRow>)}</TableBody></Table> : noResults}
      </TabsContent>
      <TabsContent value="registros"><p className={styles.recordNote}>Observações de OS e eventos já vinculados ao cliente. Não representam comentários de uma ocorrência; autoria e data de anotação não foram informadas.</p>
        {records.length ? <Table><TableHeader><TableRow><TableHead>Vínculo / origem</TableHead><TableHead>Conteúdo registrado</TableHead></TableRow></TableHeader><TableBody>{records.map(record => <TableRow key={record.id}><TableCell><span className={styles.cellStack}>{record.reference}<small>{record.source}</small><small>{record.time}</small></span></TableCell><TableCell><div className={styles.noteContent}><strong>{record.title}</strong><p>{record.content}</p>{record.orderId && <Button variant="link" size="sm" data-record-id={`order:${record.orderId}`} onClick={() => selectRecord({ type: "order", id: record.orderId! })}>Consultar OS<ArrowUpRight data-icon="inline-end" /></Button>}</div></TableCell></TableRow>)}</TableBody></Table> : noResults}
      </TabsContent>
      <footer className={styles.tableFooter}><span aria-live="polite">{count} de {total} registro(s)</span><Button variant="ghost" size="sm" onClick={() => navigate(`/${tab === "ordens" ? "operacoes" : "atendimentos"}?busca=${encodeURIComponent(subscriber.name)}`)}>{tab === "ordens" ? "Operações de campo" : "Central de atendimento"}<ArrowUpRight data-icon="inline-end" /></Button></footer>
    </Tabs>
    <p className="profile-footnote"><Info size={13} />Referência: {date(data.snapshot.asOf)}. Esta consulta não altera agendamentos, envia notificações ou acessa equipamentos.</p>
  </div>;
}
