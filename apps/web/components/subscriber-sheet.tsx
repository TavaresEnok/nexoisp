"use client";

import { useState } from "react";
import { SubscriberExpandButton, SubscriberOverview, SubscriberSheetHeader, SubscriberSheetTabs } from "@/components/subscriber-sheet-parts";
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
import { useWorkspace } from "@/features/workspace/context";
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
  const p = getSubscriberProfile(s, data);
  const linkedContracts = getCommercialData(data).contracts.filter(c => c.subscriberId === s.id);
  const monthlyTotal = linkedContracts.filter(c => !["Cancelado", "Encerrado"].includes(c.status)).reduce((sum, c) => sum + contractMonthlyTotal(c), 0);
  const navigate = (href: string) => { onClose(); router.push(href); };
  const copy = async (value: string) => { try { await copyText(value); toast.success("Copiado para a área de transferência."); } catch { toast.error("O navegador não permitiu copiar o texto."); } };
  const exportProfile = () => exportCsv(`nexo-ficha-${s.code}`, ["Código", "Nome", "Documento", "E-mail", "Telefone", "Endereço", "Bairro", "Plano", "Velocidade Mbps", "Mensalidade", "Contrato", "Situação comercial", "Conexão registrada", "POP", "Concentrador", "Serial ONU", "Vencido nos registros", "Faturas vinculadas", "Chamados abertos", "OS pendentes"], [[s.code, s.name, s.document, s.email, s.phone, s.address, s.neighborhood, s.plan, s.speed, s.price, s.contract, s.status, s.connection, s.pop, s.nas, s.onu, p.overdueTotal, p.invoices.length, p.openTickets.length, p.openOrders.length]]);
  const tabs = [["resumo", "Visão geral"], ["cadastro", "Cadastro"], ["contrato", "Contratos"], ["financeiro", "Financeiro"], ["conexao", "Conexão"], ["atendimento", "Atendimento e OS"], ["historico", "Histórico"]];
  return <>
    <SubscriberSheetHeader code={s.code} name={s.name} description={`${linkedContracts.length} contrato(s) · Cliente desde ${date(s.since)} · ${s.neighborhood}`} statuses={[s.status, s.connection]} context="Visão integrada do cliente" />
    <div className="subscriber-quick-actions"><Button variant="outline" onClick={() => navigate(`/atendimentos?busca=${encodeURIComponent(s.name)}`)}><Headphones data-icon="inline-start" />Atendimentos<ArrowUpRight data-icon="inline-end" /></Button><Button variant="outline" onClick={exportProfile}><Download data-icon="inline-start" />Exportar ficha</Button><SubscriberExpandButton expanded={expanded} onExpand={onExpand} /></div>
    <SubscriberSheetTabs value={tab} onChange={setTab} tabs={tabs.map(([value, label]) => ({ value, label, alert: value === "financeiro" && p.overdue.length > 0, count: value === "atendimento" && p.openTickets.length > 0 ? p.openTickets.length : undefined }))}>
      <TabsContent value="resumo"><SubscriberOverview
        kpis={[
          { label: "Mensalidade total do titular", value: money(monthlyTotal), detail: `${linkedContracts.length} contrato(s) · não encerrados`, onClick: () => setTab("contrato") },
          { label: "Saldo vencido registrado", value: money(p.overdueTotal), danger: p.overdueTotal > 0, detail: p.overdue.length ? `${p.overdue.length} título(s) · até ${p.overdueDays} dias` : "Sem títulos vencidos na base", onClick: () => setTab("financeiro") },
          { label: "Atendimentos em aberto", value: String(p.openTickets.length).padStart(2, "0"), detail: `${p.tickets.length} no histórico disponível`, onClick: () => setTab("atendimento") },
          { label: "Ordens de serviço pendentes", value: String(p.openOrders.length).padStart(2, "0"), detail: `${p.orders.length} vinculada(s)`, onClick: () => setTab("atendimento") },
        ]}
        attention={[
          ...(s.connection === "Offline" ? [{ icon: Network, title: "Acesso registrado como offline", detail: "Confira o contexto do POP; o estado atual depende de consulta manual.", onClick: () => setTab("conexao") }] : []),
          ...(p.overdue.length > 0 ? [{ icon: CircleDollarSign, title: `${money(p.overdueTotal)} em títulos vencidos`, detail: "Confira as cobranças antes de tratar uma suspensão como falha técnica.", onClick: () => setTab("financeiro") }] : []),
          ...(s.status === "Em instalação" ? [{ icon: CalendarDays, title: "Contrato em instalação", detail: "Confira a OS e o responsável pelo provisionamento.", onClick: () => setTab("atendimento") }] : []),
        ]}
        contracts={<SubscriberContracts subscriberId={s.id} data={data} navigate={navigate} />}
        contact={{ phone: s.phone, email: s.email, facts: [["Endereço", s.address], ["Bairro", s.neighborhood], ["Documento", s.document], ["Código do cliente", s.code]], caption: "Informação útil no primeiro atendimento.", onOpen: () => setTab("cadastro") }}
        technical={{ caption: "Cadastro do acesso, sem consultar equipamentos.", facts: [["Acesso registrado", <Status key="connection" value={s.connection} />], ["Concentrador", s.nas], ["ONU", s.onu || "Não cadastrada"], ["POP", s.pop]], footnote: "Sinal óptico e diagnóstico são consultados manualmente.", onOpen: () => setTab("conexao") }}
        recent={{ items: p.activities.slice(0, 3).map(a => ({ id: a.id, title: a.title, description: a.description, meta: `${a.time} · referência ${date(data.snapshot.asOf)}` })), onAll: () => setTab("historico") }}
        footnote={`Resumo dos registros disponíveis. Referência: ${date(data.snapshot.asOf)}. Não é monitoramento em tempo real.`}
      /></TabsContent>
      <TabsContent value="cadastro"><div className="sheet-content-body"><SubscriberRegistration subscriber={s} copy={copy} /></div></TabsContent>
      <TabsContent value="contrato"><div className="sheet-content-body"><SubscriberContracts subscriberId={s.id} data={data} navigate={navigate} /><p className="profile-footnote">Fidelidade, descontos e aceite não são presumidos. Consulte cada vínculo para separar instalação, serviços e condições comerciais.</p></div></TabsContent>
      <TabsContent value="financeiro"><div className="sheet-content-body"><SubscriberFinancial subscriber={s} data={data} navigate={navigate} /></div></TabsContent>
      <TabsContent value="conexao" keepMounted><div className="sheet-content-body"><SubscriberConnection subscriber={s} data={data} navigate={navigate} copy={copy} /></div></TabsContent>
      <TabsContent value="atendimento" keepMounted><div className="sheet-content-body"><SubscriberService subscriber={s} data={data} navigate={navigate} /></div></TabsContent>
      <TabsContent value="historico"><div className="sheet-content-body"><SubscriberHistory subscriber={s} data={data} /></div></TabsContent>
    </SubscriberSheetTabs>
    <div className="sheet-bottom-note"><ShieldCheck size={13} />Dados do workspace demonstrativo · equipamentos não são consultados automaticamente</div>
  </>;
}

