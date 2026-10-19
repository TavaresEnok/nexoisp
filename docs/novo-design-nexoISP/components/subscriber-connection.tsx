"use client";

import { useState } from "react";
import { Activity, ArrowRight, Cable, FileCode2, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ProfileSection } from "@/components/subscriber-profile-sections";
import { AccessSession, OnuIdentity, OnuState, OperationalActions, OpticalMetrics, TechnicalHeading, TechnicalParameters } from "@/components/subscriber-technical-panels";
import { OnuDiagnosticTools, RadiusImport } from "@/components/subscriber-diagnostic-tools";
import type { OnuEvidence, RadiusRecord } from "@/lib/subscriber-diagnostics";
import { date } from "@/lib/format";
import type { Subscriber, WorkspaceData } from "@/lib/types";

export function SubscriberConnection({ subscriber: s, data, navigate, copy }: { subscriber: Subscriber; data: WorkspaceData; navigate: (href: string) => void; copy: (value: string) => void }) {
  const [tab, setTab] = useState("acesso");
  const [evidence, setEvidence] = useState<OnuEvidence | null>(null);
  const [records, setRecords] = useState<RadiusRecord[]>([]);
  const storedRx = s.onu && Number.isFinite(s.signal) ? s.signal : undefined;
  const diagnose = () => setTab("diagnostico");
  const sections = [["acesso", "Acesso"], ["fttx", "ONU e FTTx"], ["optica", "Óptica"], ["radius", "Sessões RADIUS"], ["parametros", "Parâmetros"], ["diagnostico", "Diagnóstico"]];
  return <div className="technical-workspace">
    <div className="profile-manual-banner"><ShieldCheck size={18} /><div><strong>Consultas somente quando você solicitar.</strong><p>Sem polling ou acesso automático à OLT e ao NAS. Cadastro e evidências manuais são identificados separadamente.</p></div><Badge variant="outline">Sob demanda</Badge></div>
    <Tabs value={tab} onValueChange={value => setTab(String(value))}>
      <div className="technical-tab-scroll"><TabsList variant="line" aria-label="Seções técnicas do assinante">{sections.map(([value, label]) => <TabsTrigger key={value} value={value}>{label}</TabsTrigger>)}</TabsList></div>
      <TabsContent value="acesso"><TechnicalHeading title="Visão técnica do acesso" description="Do concentrador à ONU: contexto para o primeiro diagnóstico." action={<Button variant="outline" size="sm" onClick={diagnose}><FileCode2 data-icon="inline-start" />Diagnosticar</Button>} />
        <div className="technical-overview"><div><Activity size={17} /><span>Estado registrado<strong>{s.connection}</strong><small>Não comprova sessão ativa agora</small></span></div><div><Cable size={17} /><span>Identidade da ONU<strong className="mono">{s.onu || "Não cadastrada"}</strong><small>{s.pop} · vínculo OLT pendente</small></span></div></div>
        <AccessSession subscriber={s} session={records[0]} />
        <ProfileSection title="Resumo óptico" caption={evidence ? "Evidência manual validada pelo serial. Horário real da coleta não confirmado." : `Valor armazenado · referência ${date(data.snapshot.asOf)} · sem horário individual.`} action={<button className="profile-text-action" onClick={() => setTab("optica")}>Detalhar<ArrowRight size={13} /></button>}><OpticalMetrics evidence={evidence} storedRx={storedRx} /></ProfileSection>
        <OperationalActions navigate={navigate} pop={s.pop} onDiagnose={diagnose} />
      </TabsContent>
      <TabsContent value="fttx"><TechnicalHeading title="ONU e caminho FTTx" description="Identidade, localização física e estado reportado pelo equipamento." action={<Button variant="outline" size="sm" onClick={diagnose}>Coleta manual<ArrowRight data-icon="inline-end" /></Button>} /><OnuIdentity subscriber={s} evidence={evidence} copy={copy} /><OnuState evidence={evidence} /></TabsContent>
      <TabsContent value="optica"><TechnicalHeading title="Telemetria óptica" description="Potências nos dois sentidos e condições do módulo, sem estimativas." action={<Badge variant="outline">{evidence ? "Saída manual" : "Sem coleta nesta ficha"}</Badge>} /><OpticalMetrics evidence={evidence} storedRx={storedRx} /><ProfileSection title="Como interpretar esta leitura" caption="Um número isolado não determina a causa de uma falha."><ul className="technical-guidance"><li><strong>RX na ONU e RX na OLT</strong><span>Compare os dois sentidos com os limites da classe óptica e do fabricante; não são leituras equivalentes.</span></li><li><strong>Temperatura, tensão e corrente</strong><span>Confronte os valores com as especificações do módulo e os alarmes retornados pela OLT.</span></li><li><strong>Origem e validade</strong><span>{evidence ? "Saída inserida pelo operador e conferida pelo serial. Não há confirmação independente de data, integridade ou origem." : "O RX cadastrado não possui horário de coleta. Os demais campos aguardam evidência manual."}</span></li></ul><Button variant="outline" onClick={diagnose}><FileCode2 data-icon="inline-start" />Preparar nova coleta</Button></ProfileSection><OnuState evidence={evidence} /></TabsContent>
      <TabsContent value="radius"><TechnicalHeading title="Sessões e accounting RADIUS" description="IP, NAS, MAC, duração e causas de encerramento por sessão." /><AccessSession subscriber={s} session={records[0]} /><RadiusImport records={records} onRecords={setRecords} /></TabsContent>
      <TabsContent value="parametros"><TechnicalParameters subscriber={s} /></TabsContent>
      <TabsContent value="diagnostico" keepMounted><OnuDiagnosticTools subscriber={s} evidence={evidence} onEvidence={setEvidence} copy={copy} /></TabsContent>
    </Tabs>
    <p className="profile-footnote">Análise temporária nesta ficha. Evidências não são gravadas no cadastro e são descartadas ao fechá-la. Ações remotas dependem de executor autorizado e auditoria.</p>
  </div>;
}
