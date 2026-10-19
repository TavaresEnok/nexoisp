"use client";

import { ArrowUpRight, MapPin, ShieldCheck } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Status } from "@/components/workspace-ui";
import { ProfileSection, ProfileFacts } from "@/components/subscriber-profile-sections";
import { contractMonthlyTotal, type CatalogPlan, type ServiceContract } from "@/lib/commercial";
import { money, date } from "@/lib/format";
import type { Subscriber } from "@/lib/types";

export function ContractDetails({ contract: c, plans, subscriber, onClose, openSubscriber }: { contract: ServiceContract | null; plans: CatalogPlan[]; subscriber?: Subscriber; onClose: () => void; openSubscriber: (id: string) => void }) {
  const plan = plans.find(p => p.id === c?.planId);
  return <Sheet open={!!c} onOpenChange={open => { if (!open) onClose(); }}><SheetContent className="commercial-sheet">{c && <>
    <SheetHeader><p className="eyebrow">ASSINANTES / CONTRATO</p><SheetTitle>{c.code} · {c.label}</SheetTitle><SheetDescription>{subscriber?.name ?? "Titular não encontrado"} · um vínculo independente deste assinante.</SheetDescription><div className="flex flex-wrap gap-2"><Status value={c.status} /><Badge variant="outline">{plan?.serviceType ?? "Serviço"}</Badge></div></SheetHeader>
    <Tabs defaultValue="servicos" className="min-h-0 flex-1"><div className="commercial-tab-scroll"><TabsList variant="line"><TabsTrigger value="servicos">Plano e serviços</TabsTrigger><TabsTrigger value="local">Instalação</TabsTrigger><TabsTrigger value="financeiro">Condições</TabsTrigger></TabsList></div>
      <TabsContent value="servicos"><div className="commercial-detail-body"><ProfileSection title="Plano principal" caption="A mensalidade pertence a este contrato."><ProfileFacts items={[["Plano", plan?.name ?? "Plano não encontrado"], ["Serviço", plan?.serviceType ?? "Não informado"], ["Mensalidade base", money(c.price)], ["Início", date(c.since)]]} /></ProfileSection><ProfileSection title="Serviços adicionais" caption="Itens cobrados neste mesmo contrato; não confundidos com outros contratos do titular.">{c.additionalServices.length ? <div className="commercial-addons">{c.additionalServices.map(item => <div key={item.id}><span><strong>{item.name}</strong><small>{item.serviceType}</small></span><b>{money(item.price)} / mês</b></div>)}</div> : <p className="text-sm text-muted-foreground">Nenhum serviço adicional registrado neste contrato.</p>}</ProfileSection></div></TabsContent>
      <TabsContent value="local"><div className="commercial-detail-body"><ProfileSection title={c.label} caption="O endereço é do contrato, não necessariamente do titular."><div className="flex items-start gap-3"><MapPin className="size-5 shrink-0 text-muted-foreground" /><p className="text-sm">{c.address}</p></div><ProfileFacts items={[["Bairro", c.neighborhood], ["POP", c.pop], ["Titular", subscriber?.name ?? "Não encontrado"]]} /></ProfileSection></div></TabsContent>
      <TabsContent value="financeiro"><div className="commercial-detail-body"><ProfileSection title="Condições deste contrato" caption="Sem alterar os demais vínculos do assinante."><ProfileFacts items={[["Mensalidade base", money(c.price)], ["Adicionais recorrentes", money(contractMonthlyTotal(c) - c.price)], ["Total mensal contratado", money(contractMonthlyTotal(c))], ["Dia de vencimento", `Todo dia ${c.dueDay}`], ["Situação comercial", <Status key="status" value={c.status} />], ["Fidelidade / multa", "Não informada"], ["Documento assinado", "Nenhum arquivo vinculado"]]} /></ProfileSection><p className="profile-footnote">As cobranças legadas estão vinculadas ao assinante. Não são atribuídas automaticamente a este contrato, evitando misturar dívidas entre instalações.</p></div></TabsContent>
    </Tabs><div className="commercial-detail-body"><Button variant="outline" disabled={!subscriber} onClick={() => { onClose(); openSubscriber(c.subscriberId); }}>Abrir ficha do titular<ArrowUpRight data-icon="inline-end" /></Button></div><div className="commercial-sheet-footer"><ShieldCheck size={14} />Somente leitura · nenhum aceite ou cobrança é realizado</div>
  </>}</SheetContent></Sheet>;
}
