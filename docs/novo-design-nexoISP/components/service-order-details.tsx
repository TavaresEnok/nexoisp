"use client";

import { useRef, useState } from "react";
import { ArrowUpRight, ClipboardList, FileText, Info, Paperclip, Printer, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ProfileFacts, ProfileSection } from "@/components/subscriber-profile-sections";
import { Status } from "@/components/workspace-ui";
import { buildWorkOrderPrintDocument } from "@/lib/work-order-print";
import { date } from "@/lib/format";
import type { Subscriber, WorkOrder } from "@/lib/types";
import styles from "./service-records.module.css";
import { printDocument as printFrameDocument } from "@/platform/browser";

export function ServiceOrderDetails({ order, subscriber, provider, reference, onOpenSubscriber }: { order: WorkOrder; subscriber?: Subscriber; provider: string; reference: string; onOpenSubscriber?: () => void }) {
  const [tab, setTab] = useState("dados");
  const [printReady, setPrintReady] = useState(false);
  const printFrame = useRef<HTMLIFrameElement>(null);
  const printDocument = buildWorkOrderPrintDocument(order, subscriber, provider, reference);
  const print = () => {
    try {
      printFrameDocument(printFrame.current?.contentWindow);
    } catch {
      toast.error("Não foi possível abrir a impressão neste navegador.");
    }
  };
  return <div className={styles.detailRoot}>
    <div className={styles.orderSummary}><div><span className="mono">OS #{order.code}</span><Status value={order.status} /></div><p>{order.technician || "Técnico não atribuído"}<span>·</span>{order.time}<span>·</span>{order.duration} min previstos</p></div>
    <Tabs value={tab} onValueChange={value => setTab(String(value))}>
      <div className={styles.tabScroll}><TabsList variant="line" aria-label="Consulta da ordem de serviço"><TabsTrigger value="dados"><ClipboardList data-icon="inline-start" />Dados da OS</TabsTrigger><TabsTrigger value="ficha"><FileText data-icon="inline-start" />Ficha para impressão</TabsTrigger></TabsList></div>
      <TabsContent value="dados"><div className={styles.detailColumns}>
        <div>
          <ProfileSection title="Dados operacionais" caption="Informações registradas para esta visita."><ProfileFacts items={[["Serviço solicitado", order.type], ["Técnico responsável", order.technician || "Não atribuído"], ["Horário registrado", order.time], ["Duração prevista", `${order.duration} minutos`], ["Referência da agenda", date(reference)], ["Localidade da visita", order.neighborhood], ["Ocorrência de origem", "Vínculo não informado"], ["Contrato da OS", "Vínculo específico não informado"]]} /></ProfileSection>
          <ProfileSection title="Observação da visita" caption="Conteúdo interno registrado na OS; não incluído na impressão."><p className={styles.longText}>{order.notes || "Nenhuma observação informada nesta consulta."}</p></ProfileSection>
          <ProfileSection title="Execução e encerramento" caption="A situação da OS não substitui a evidência do serviço."><ProfileFacts items={[["Status registrado", <Status key="status" value={order.status} />], ["Check-in", "Não informado"], ["Data de encerramento", "Não informada"], ["Serviço executado", "Relato não disponível"]]} /></ProfileSection>
        </div>
        <aside>
          <ProfileSection title="Assinante da visita" caption="Contexto cadastral do titular." action={onOpenSubscriber && <Button variant="ghost" size="icon-sm" aria-label="Abrir contexto do assinante" onClick={onOpenSubscriber}><ArrowUpRight /></Button>}>
            <div className={styles.clientContext}><strong>{subscriber?.name ?? order.name}</strong><span>Cliente #{subscriber?.code ?? "não disponível"}</span><p>{subscriber?.address ?? "Endereço não disponível"}</p><p>{subscriber?.phone ?? "Telefone não disponível"}</p></div>
          </ProfileSection>
          <ProfileSection title="Contexto técnico" caption="Cadastro do assinante, não uma leitura em tempo real."><ProfileFacts items={[["Plano cadastral", subscriber?.plan ?? "Não disponível"], ["Conexão registrada", subscriber ? <Status key="connection" value={subscriber.connection} /> : "Não disponível"], ["POP", subscriber?.pop ?? "Não disponível"], ["Concentrador", subscriber?.nas ?? "Não disponível"], ["Serial da ONU", subscriber?.onu || "Não cadastrado"]]} /></ProfileSection>
          <ProfileSection title="Anexos e assinaturas"><div className={styles.unavailable}><Paperclip size={16} /><p>Anexos, comentários e assinaturas eletrônicas não estão disponíveis nesta consulta.</p></div><Badge variant="outline"><ShieldCheck data-icon="inline-start" />Somente leitura</Badge></ProfileSection>
        </aside>
      </div></TabsContent>
      <TabsContent value="ficha" keepMounted>
        <div className={styles.printToolbar}><div><h3>Ficha técnica da visita</h3><p>A4 · conteúdo interno da OS não é exportado.</p></div><Button variant="outline" disabled={!printReady} onClick={print}><Printer data-icon="inline-start" />Imprimir / salvar PDF</Button></div>
        <iframe ref={printFrame} className={styles.printFrame} title={`Ficha de impressão da OS ${order.code}`} sandbox="allow-same-origin allow-modals" srcDoc={printDocument} onLoad={() => setPrintReady(true)} />
        <p className="profile-footnote"><Info size={13} />A impressão abre o diálogo do navegador. Para gerar um arquivo, escolha salvar como PDF. Não há envio automático ao cliente.</p>
      </TabsContent>
    </Tabs>
  </div>;
}
