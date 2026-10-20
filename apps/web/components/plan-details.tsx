"use client";

import { useId, type ReactNode } from "react";
import Link from "@/platform/navigation/link";
import { ArrowLeft, ArrowDown, ArrowUp, ArrowUpRight, FileText, Gauge, Layers, LockKeyhole, MapPin, Network, Terminal, Wallet } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel, FieldDescription } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { money } from "@/lib/format";
import { planUsage, type CatalogPlan, type ServiceContract } from "@/lib/commercial";
import styles from "@/components/plans.module.css";

function ConfigField({ label, value, description, wide = false }: { label: string; value: string | number | null; description?: string; wide?: boolean }) {
  const id = useId();
  return <Field className={wide ? styles.wideField : undefined}><FieldLabel htmlFor={id}>{label}</FieldLabel><Input id={id} readOnly value={value ?? ""} placeholder="Não informado" />{description && <FieldDescription>{description}</FieldDescription>}</Field>;
}

function ConfigSection({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <section className={styles.configSection}><header><h2>{title}</h2><p>{description}</p></header>{children}</section>;
}

export function PlanDetails({ plan, contracts, onClose, operational = false, activeCount, actions }: { plan: CatalogPlan; contracts: ServiceContract[]; onClose: () => void; operational?: boolean; activeCount?: number; actions?: ReactNode }) {
  const usage = planUsage(plan.id, contracts);
  const currency = (value: number | null) => value === null ? null : money(value);
  const baseRecurring = usage.contracts.filter(c => c.status === "Ativo").reduce((sum, c) => sum + c.price, 0);
  const configFields = [plan.price, plan.upload, plan.billing, plan.sla, plan.ipv4Pool, plan.ipv6Pool, plan.policyIn, plan.policyOut, plan.radius, plan.onu];
  const defined = configFields.filter(value => value !== null && value !== "").length;
  return <div className={styles.page}>
    <div className={styles.detailHeading}><div className={styles.detailTitle}><Button variant="outline" size="icon" aria-label="Voltar ao catálogo" onClick={onClose}><ArrowLeft /></Button><div><p className="eyebrow">CATÁLOGO / CONFIGURAÇÃO DO PLANO</p><h1>{plan.name}</h1><p>Condições da oferta, perfil de banda e parâmetros de provisionamento.</p></div></div>{operational ? <div className="erp-inline-actions">{actions}<Badge variant="outline"><LockKeyhole data-icon="inline-start" />Catálogo do ERP</Badge></div> : <Badge variant="outline"><LockKeyhole data-icon="inline-start" />Somente leitura</Badge>}</div>
    <div className={styles.detailLayout}>
      <div className={styles.configuration}>
        <Tabs defaultValue="geral">
          <div className={styles.tabScroll}><TabsList variant="line" aria-label="Configuração do plano"><TabsTrigger value="geral"><FileText />Dados gerais</TabsTrigger><TabsTrigger value="banda"><Gauge />Banda & rede</TabsTrigger><TabsTrigger value="radius"><Terminal />RADIUS / ONU</TabsTrigger><TabsTrigger value="pops"><Network />POPs & vínculos</TabsTrigger></TabsList></div>
          <TabsContent value="geral"><div className={styles.sectionStack}>
            <ConfigSection title="Identificação do plano" description="Informações comerciais que definem a oferta."><FieldGroup className={styles.fieldGrid}><ConfigField label="Descrição comercial" value={plan.name} wide /><ConfigField label="Tipo de serviço" value={plan.serviceType} /><ConfigField label="Modalidade de cobrança" value={plan.billing} /><ConfigField label="Disponível para contratação" value={plan.active === null ? null : plan.active ? "Sim" : "Não"} /><ConfigField label="Garantia / grupo SLA" value={plan.sla} /></FieldGroup></ConfigSection>
            <ConfigSection title="Valores & condições" description="Preço de catálogo, descontos e condições de adesão."><FieldGroup className={styles.fieldGrid}><ConfigField label="Mensalidade de catálogo" value={currency(plan.price)} /><ConfigField label="Desconto" value={currency(plan.discount)} /><ConfigField label="Taxa de instalação" value={currency(plan.installationFee)} /><ConfigField label="Fidelidade" value={plan.loyaltyMonths === null ? null : `${plan.loyaltyMonths} meses`} /></FieldGroup><p className={styles.sectionNote}>O valor negociado com cada assinante pertence ao contrato e não altera o preço de catálogo.</p></ConfigSection>
          </div></TabsContent>
          <TabsContent value="banda"><div className={styles.sectionStack}>
            <ConfigSection title="Velocidade & gerenciamento de banda" description="Perfil contratado em Mbps, sem representar medição de tráfego."><div className={styles.bandPreview}><div><ArrowDown size={18} /><span>Download<strong>{plan.download ?? "—"}<small>Mbps</small></strong></span></div><div><ArrowUp size={18} /><span>Upload<strong>{plan.upload ?? "—"}<small>Mbps</small></strong></span></div></div><FieldGroup className={styles.fieldGrid}><ConfigField label="Download (Mbps)" value={plan.download} /><ConfigField label="Upload (Mbps)" value={plan.upload} /><ConfigField label="Policy de entrada (In)" value={plan.policyIn} /><ConfigField label="Policy de saída (Out)" value={plan.policyOut} /></FieldGroup></ConfigSection>
            <ConfigSection title="Endereçamento & tecnologia" description="Pools e tecnologia associados ao perfil de acesso."><FieldGroup className={styles.fieldGrid}><ConfigField label="Tecnologia de acesso" value={plan.technology} wide /><ConfigField label="Pool IPv4" value={plan.ipv4Pool} /><ConfigField label="Pool IPv6" value={plan.ipv6Pool} /></FieldGroup></ConfigSection>
          </div></TabsContent>
          <TabsContent value="radius"><div className={styles.sectionStack}>
            <ConfigSection title="Atributos RADIUS" description="Parâmetros customizados registrados para autenticação e autorização."><div className={styles.terminal}><div><Terminal size={13} /><span>radius.attributes</span><Badge variant="outline">{plan.radius ? "Registrado" : "Sem configuração"}</Badge></div><pre>{plan.radius || "Nenhum atributo RADIUS registrado para este plano."}</pre></div></ConfigSection>
            <ConfigSection title="Provisionamento ONU / OLT" description="Parâmetros registrados para o equipamento de acesso."><div className={styles.terminal}><div><Terminal size={13} /><span>onu.configuration</span><Badge variant="outline">{plan.onu ? "Registrado" : "Sem configuração"}</Badge></div><pre>{plan.onu || "Nenhum parâmetro ONU / OLT registrado para este plano."}</pre></div><p className={styles.sectionNote}>Esta consulta não executa comandos nem aplica configurações na rede.</p></ConfigSection>
          </div></TabsContent>
          <TabsContent value="pops"><div className={styles.sectionStack}>
            <ConfigSection title="POPs com contratos vinculados" description="Distribuição na base atual. Não representa cobertura autorizada para venda."><div className={styles.popList}>{operational ? <p className={styles.sectionNote}>A distribuição pode ser consultada nos contratos vinculados. Nenhum POP foi inferido.</p> : usage.pops.length ? usage.pops.map(pop => { const linked = usage.contracts.filter(c => c.pop === pop); return <div key={pop}><span className={styles.popIcon}><MapPin size={16} /></span><div><strong>{pop}</strong><small>{linked.filter(c => c.status === "Ativo").length} {linked.filter(c => c.status === "Ativo").length === 1 ? "contrato ativo" : "contratos ativos"}</small></div><Badge variant="secondary">{linked.length} {linked.length === 1 ? "contrato" : "contratos"}</Badge></div>; }) : <p className={styles.sectionNote}>Nenhum POP informado nos contratos deste plano.</p>}</div></ConfigSection>
            <ConfigSection title="Utilização do plano" description="Situação dos contratos vinculados, independentemente da conexão online."><dl className={styles.usageGrid}>{[["Ativos", usage.active], ["Suspensos", usage.suspended], ["Em instalação", usage.installing], ["Cancelados / encerrados", usage.canceled]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{operational ? label === "Ativos" ? activeCount ?? "—" : "—" : value}</dd></div>)}</dl><Link href={`/contratos?plano=${encodeURIComponent(plan.id)}`} className={buttonVariants({ variant: "outline" })}>Ver contratos deste plano<ArrowUpRight data-icon="inline-end" /></Link></ConfigSection>
          </div></TabsContent>
        </Tabs>
      </div>
      <aside className={styles.summary} aria-label="Resumo do plano"><section className={styles.summaryCard}><div className={styles.summaryIcon}><Layers size={22} /></div><Badge variant="secondary">{plan.serviceType}</Badge><h2>{plan.name}</h2><p>{plan.source === "legacy" ? "Plano identificado a partir dos contratos da base." : "Oferta registrada no catálogo comercial."}</p><Separator /><div className={styles.summaryPrice}><span>Mensalidade de catálogo</span><strong>{plan.price === null ? "Não definida" : money(plan.price)}</strong><small>{plan.price === null ? "Sem preço cadastrado na origem" : "por mês"}</small></div><Separator /><dl className={styles.summaryFacts}><div><dt>Contratos vinculados</dt><dd>{operational ? "Consulte os vínculos" : usage.contracts.length}</dd></div><div><dt>Assinantes distintos</dt><dd>{operational ? "—" : usage.subscribers}</dd></div><div><dt>POPs vinculados</dt><dd>{operational ? "—" : usage.pops.length}</dd></div></dl><Link href={`/contratos?plano=${encodeURIComponent(plan.id)}`} className={buttonVariants({ variant: "outline" })}>Consultar contratos<ArrowUpRight data-icon="inline-end" /></Link></section>
        <section className={styles.financialSummary}><span><Wallet size={15} />{operational ? "Contratos vigentes" : "Mensalidades ativas"}</span><strong>{operational ? `${activeCount ?? 0} contrato(s)` : money(baseRecurring)}</strong><p>{operational ? "Preços e condições são preservados por versão em cada vínculo comercial." : `Soma dos valores base de ${usage.active} contratos ativos. Sem serviços adicionais.`}</p></section>
        <div className={styles.configStatus}><LockKeyhole size={15} /><div><strong>{operational ? "Configuração registrada no ERP" : "Consulta da base demonstrativa"}</strong><p>{defined} de {configFields.length} parâmetros comerciais e técnicos informados. Campos vazios não foram presumidos.</p></div></div>
      </aside>
    </div>
    <div className={styles.detailFooter}><Button variant="ghost" onClick={onClose}><ArrowLeft data-icon="inline-start" />Voltar ao catálogo</Button><span>{operational ? "Alterações comerciais preservam as versões já contratadas." : "Cadastro e edição não disponíveis nesta demonstração pública."}</span></div>
  </div>;
}
