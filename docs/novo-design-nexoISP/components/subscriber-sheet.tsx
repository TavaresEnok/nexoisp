"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "@/platform/navigation/react";
import { useQueryState } from "@/lib/use-query-state";
import { ArrowRight, ArrowUpRight, CalendarDays, CircleDollarSign, Download, Headphones, Info, Mail, Maximize2, Minimize2, Network, Phone, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Status, PersonAvatar } from "@/components/workspace-ui";
import { ProfileSection, ProfileFacts, SubscriberFinancial, SubscriberRegistration } from "@/components/subscriber-profile-sections";
import { SubscriberService } from "@/components/subscriber-service";
import { SubscriberConnection } from "@/components/subscriber-connection";
import { SubscriberContracts } from "@/components/subscriber-contracts";
import { SubscriberHistory } from "@/components/subscriber-history";
import { useWorkspace } from "@/components/workspace-provider";
import { getSubscriberProfile } from "@/lib/subscriber-profile";
import { money, date, exportCsv } from "@/lib/format";
import { cn } from "@/lib/utils";
import { getCommercialData, contractMonthlyTotal } from "@/lib/commercial";
import type { Subscriber } from "@/lib/types";
import { copyText } from "@/platform/browser";

export function SubscriberSheet({ subscriberId, onClose }: { subscriberId: string | null; onClose: () => void }) {
  const { data } = useWorkspace();
  const [expanded, setExpanded] = useState(false);
  const subscriber = data.subscribers.find(s => s.id === subscriberId);
  return <Sheet open={!!subscriberId} onOpenChange={open => { if (!open) { onClose(); setExpanded(false); } }}><SheetContent className={cn("subscriber-sheet", "subscriber-workspace", expanded && "subscriber-workspace-expanded")}>
    {subscriber ? <SubscriberDetails key={subscriber.id} subscriber={subscriber} onClose={onClose} expanded={expanded} onExpand={() => setExpanded(value => !value)} /> : <><SheetHeader><SheetTitle>Assinante não encontrado</SheetTitle><SheetDescription>O identificador da URL não corresponde à amostra disponível. Os demais filtros foram preservados.</SheetDescription></SheetHeader><div className="sheet-content-body"><Button variant="outline" onClick={onClose}>Fechar ficha inválida</Button></div></>}
  </SheetContent></Sheet>;
}

function SubscriberDetails({ subscriber: s, onClose, expanded, onExpand }: { subscriber: Subscriber; onClose: () => void; expanded: boolean; onExpand: () => void }) {
  const { data } = useWorkspace();
  const router = useRouter();
  const [tab, setTab] = useQueryState("abaFicha", "resumo", ["resumo", "cadastro", "contrato", "financeiro", "conexao", "atendimento", "historico"]);
  const tabScroll = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const scroller = tabScroll.current;
    if (!scroller) return;
    const revealActiveTab = () => {
      const active = scroller.querySelector<HTMLElement>('[data-slot="tabs-trigger"][data-active]');
      if (!active) return;
      const bounds = scroller.getBoundingClientRect();
      const target = active.getBoundingClientRect();
      if (target.left < bounds.left || target.right > bounds.right) scroller.scrollLeft += target.left - bounds.left - (bounds.width - target.width) / 2;
    };
    revealActiveTab();
    const observer = new ResizeObserver(revealActiveTab);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [tab]);
  const p = getSubscriberProfile(s, data);
  const linkedContracts = getCommercialData(data).contracts.filter(c => c.subscriberId === s.id);
  const monthlyTotal = linkedContracts.filter(c => !["Cancelado", "Encerrado"].includes(c.status)).reduce((sum, c) => sum + contractMonthlyTotal(c), 0);
  const navigate = (href: string) => { onClose(); router.push(href); };
  const copy = async (value: string) => { try { await copyText(value); toast.success("Copiado para a área de transferência."); } catch { toast.error("O navegador não permitiu copiar o texto."); } };
  const exportProfile = () => exportCsv(`nexo-ficha-${s.code}`, ["Código", "Nome", "Documento", "E-mail", "Telefone", "Endereço", "Bairro", "Plano", "Velocidade Mbps", "Mensalidade", "Contrato", "Situação comercial", "Conexão registrada", "POP", "Concentrador", "Serial ONU", "Vencido nos registros", "Faturas vinculadas", "Chamados abertos", "OS pendentes"], [[s.code, s.name, s.document, s.email, s.phone, s.address, s.neighborhood, s.plan, s.speed, s.price, s.contract, s.status, s.connection, s.pop, s.nas, s.onu, p.overdueTotal, p.invoices.length, p.openTickets.length, p.openOrders.length]]);
  const tabs = [["resumo", "Visão geral"], ["cadastro", "Cadastro"], ["contrato", "Contratos"], ["financeiro", "Financeiro"], ["conexao", "Conexão"], ["atendimento", "Atendimento e OS"], ["historico", "Histórico"]];
  return <>
    <SheetHeader className="subscriber-sheet-header"><div className="eyebrow">FICHA DO ASSINANTE <span className="mono">#{s.code}</span></div><div className="subscriber-identity"><PersonAvatar name={s.name} /><div><SheetTitle>{s.name}</SheetTitle><SheetDescription>{linkedContracts.length} contrato(s) · Cliente desde {date(s.since)} · {s.neighborhood}</SheetDescription></div></div><div className="subscriber-statuses"><Status value={s.status} /><Status value={s.connection} /><span className="subscriber-context"><ShieldCheck size={13} />Visão integrada do cliente</span></div></SheetHeader>
    <div className="subscriber-quick-actions"><Button variant="outline" onClick={() => navigate(`/atendimentos?busca=${encodeURIComponent(s.name)}`)}><Headphones data-icon="inline-start" />Atendimentos<ArrowUpRight data-icon="inline-end" /></Button><Button variant="outline" onClick={exportProfile}><Download data-icon="inline-start" />Exportar ficha</Button><Button variant="ghost" onClick={onExpand} className="profile-expand">{expanded ? <Minimize2 data-icon="inline-start" /> : <Maximize2 data-icon="inline-start" />}{expanded ? "Recolher ficha" : "Ampliar ficha"}</Button></div>
    <Tabs value={tab} onValueChange={value => setTab(String(value))} className="subscriber-tabs"><div ref={tabScroll} className="profile-tab-scroll"><TabsList variant="line" aria-label="Seções da ficha do assinante">{tabs.map(([value, label]) => <TabsTrigger key={value} value={value}>{label}{value === "financeiro" && p.overdue.length > 0 && <span className="nav-alert" />}{value === "atendimento" && p.openTickets.length > 0 && <span className="tab-count">{p.openTickets.length}</span>}</TabsTrigger>)}</TabsList></div>
      <TabsContent value="resumo"><div className="sheet-content-body">
        <div className="profile-kpis"><button onClick={() => setTab("contrato")}><span>Mensalidade total do titular</span><strong>{money(monthlyTotal)}</strong><small>{linkedContracts.length} contrato(s) · não encerrados<ArrowUpRight size={12} /></small></button><button onClick={() => setTab("financeiro")}><span>Saldo vencido registrado</span><strong className={cn(p.overdueTotal > 0 && "text-danger")}>{money(p.overdueTotal)}</strong><small>{p.overdue.length ? `${p.overdue.length} título(s) · até ${p.overdueDays} dias` : "Sem títulos vencidos na base"}<ArrowUpRight size={12} /></small></button><button onClick={() => setTab("atendimento")}><span>Atendimentos em aberto</span><strong>{String(p.openTickets.length).padStart(2, "0")}</strong><small>{p.tickets.length} no histórico disponível<ArrowUpRight size={12} /></small></button><button onClick={() => setTab("atendimento")}><span>Ordens de serviço pendentes</span><strong>{String(p.openOrders.length).padStart(2, "0")}</strong><small>{p.orders.length} vinculada(s)<ArrowUpRight size={12} /></small></button></div>
        {(s.connection === "Offline" || p.overdue.length > 0 || s.status === "Em instalação") && <div className="profile-attention"><div><span className="eyebrow">ANTES DA PRÓXIMA AÇÃO</span><h3>O que precisa de atenção</h3></div>{s.connection === "Offline" && <button onClick={() => setTab("conexao")}><Network size={17} /><span><strong>Acesso registrado como offline</strong><small>Confira o contexto do POP; o estado atual depende de consulta manual.</small></span><ArrowRight size={15} /></button>}{p.overdue.length > 0 && <button onClick={() => setTab("financeiro")}><CircleDollarSign size={17} /><span><strong>{money(p.overdueTotal)} em títulos vencidos</strong><small>Confira as cobranças antes de tratar uma suspensão como falha técnica.</small></span><ArrowRight size={15} /></button>}{s.status === "Em instalação" && <button onClick={() => setTab("atendimento")}><CalendarDays size={17} /><span><strong>Contrato em instalação</strong><small>Confira a OS e o responsável pelo provisionamento.</small></span><ArrowRight size={15} /></button>}</div>}
        <div className="profile-two-columns"><SubscriberContracts subscriberId={s.id} data={data} navigate={navigate} /><ProfileSection title="Contato e endereço cadastral" caption="Informação útil no primeiro atendimento." action={<button className="profile-text-action" onClick={() => setTab("cadastro")}>Cadastro<ArrowUpRight size={13} /></button>}><div className="profile-contact-links"><a href={`tel:${s.phone.replace(/[^+\d]/g, "")}`}><Phone size={15} /><span>{s.phone}</span></a><a href={`mailto:${s.email}`}><Mail size={15} /><span>{s.email}</span></a></div><ProfileFacts items={[["Endereço", s.address], ["Bairro", s.neighborhood], ["Documento", s.document], ["Código do cliente", s.code]]} /></ProfileSection></div>
        <div className="profile-two-columns"><ProfileSection title="Contexto técnico" caption="Cadastro do acesso, sem consultar equipamentos." action={<button className="profile-text-action" onClick={() => setTab("conexao")}>Detalhes<ArrowUpRight size={13} /></button>}><ProfileFacts items={[["Acesso registrado", <Status key="connection" value={s.connection} />], ["Concentrador", s.nas], ["ONU", s.onu || "Não cadastrada"], ["POP", s.pop]]} /><p className="profile-footnote"><ShieldCheck size={13} /> Sinal óptico e diagnóstico são consultados manualmente.</p></ProfileSection><ProfileSection title="Últimos movimentos" caption="Eventos vinculados a este assinante."><div className="profile-recent">{p.activities.slice(0, 3).map(a => <div key={a.id}><span className="timeline-dot" /><div><strong>{a.title}</strong><p>{a.description}</p><small>{a.time} · referência {date(data.snapshot.asOf)}</small></div></div>)}{!p.activities.length && <p className="profile-footnote">Nenhum evento adicional registrado.</p>}</div><button className="profile-text-action" onClick={() => setTab("historico")}>Ver histórico completo<ArrowRight size={13} /></button></ProfileSection></div>
        <p className="profile-footnote"><Info size={13} /> Resumo dos registros disponíveis. Referência: {date(data.snapshot.asOf)}. Não é monitoramento em tempo real.</p>
      </div></TabsContent>
      <TabsContent value="cadastro"><div className="sheet-content-body"><SubscriberRegistration subscriber={s} copy={copy} /></div></TabsContent>
      <TabsContent value="contrato"><div className="sheet-content-body"><SubscriberContracts subscriberId={s.id} data={data} navigate={navigate} /><p className="profile-footnote">Fidelidade, descontos e aceite não são presumidos. Consulte cada vínculo para separar instalação, serviços e condições comerciais.</p></div></TabsContent>
      <TabsContent value="financeiro"><div className="sheet-content-body"><SubscriberFinancial subscriber={s} data={data} navigate={navigate} /></div></TabsContent>
      <TabsContent value="conexao" keepMounted><div className="sheet-content-body"><SubscriberConnection subscriber={s} data={data} navigate={navigate} copy={copy} /></div></TabsContent>
      <TabsContent value="atendimento" keepMounted><div className="sheet-content-body"><SubscriberService subscriber={s} data={data} navigate={navigate} /></div></TabsContent>
      <TabsContent value="historico"><div className="sheet-content-body"><SubscriberHistory subscriber={s} data={data} /></div></TabsContent>
    </Tabs>
    <div className="sheet-bottom-note"><ShieldCheck size={13} />Dados do workspace demonstrativo · equipamentos não são consultados automaticamente</div>
  </>;
}
