"use client";

import { useState, type FormEvent } from "react";
import { useQueryState } from "@/lib/use-query-state";
import { Download, Eye, FileCheck2, Search, ShieldAlert } from "lucide-react";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, FieldGroup, FieldLabel, FieldDescription, FieldError } from "@/components/ui/field";
import { Table, TableHeader, TableHead, TableBody, TableRow, TableCell } from "@/components/ui/table";
import { PageHeading, Panel, SourceFooter, Status } from "@/components/workspace-ui";
import { OpticalEmpty } from "@/components/optical-ui";
import { useWorkspace } from "@/components/workspace-provider";
import { findCurrentIpAssignments, parseIpTargets } from "@/lib/ip-traceability";
import { exportCsv } from "@/lib/format";

export function IpTraceability() {
  const { data, openSubscriber } = useWorkspace();
  const [ip, setIp] = useQueryState("ip", "");
  const [online, setOnline] = useQueryState("somenteOnline", "nao", ["sim", "nao"]);
  const onlineOnly = online === "sim";
  const setOnlineOnly = (value: boolean) => setOnline(value ? "sim" : "nao");
  const [error, setError] = useState("");
  const [submittedQuery, setSubmittedQuery] = useQueryState("consultaIp", "");
  const [submittedOnline, setSubmittedOnline] = useQueryState("consultaOnline", "nao", ["sim", "nao"]);
  const parsed = submittedQuery ? parseIpTargets(submittedQuery) : null;
  const submitted = parsed && !parsed.error ? { targets: parsed.targets, onlineOnly: submittedOnline === "sim" } : null;
  const rows = submitted ? findCurrentIpAssignments(data.subscribers, submitted.targets, submitted.onlineOnly) : [];
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const result = parseIpTargets(ip);
    setError(result.error ?? "");
    setSubmittedQuery(result.error ? "" : ip);
    setSubmittedOnline(onlineOnly ? "sim" : "nao");
  };
  return <div className="flex flex-col gap-6">
    <PageHeading eyebrow="RELATÓRIO · CONSULTA DE IP" title="Rastreabilidade de IP" description="Identificação de vínculos de acesso e escopo de consulta RADIUS / CGNAT." actions={<><Button variant="outline" disabled={!rows.length} onClick={() => exportCsv("nexo-vinculos-ip-cenario-atual", ["Origem", "Data do cenário", "Login", "Assinante", "Contrato", "IPv4 registrado", "MAC", "NAS", "POP", "Conexão"], rows.map(s => ["Cenário demonstrativo — não é histórico RADIUS", data.snapshot.asOf, s.access?.login ?? "Não coletado", s.name, s.contract, s.access?.ip ?? "Não coletado", s.access?.mac ?? "Não coletado", s.nas, s.pop, s.connection]))}><Download data-icon="inline-start" />Exportar vínculos</Button><Button variant="outline" disabled title="Indisponível: não há histórico RADIUS/CGNAT nem evidências judiciais nesta base."><FileCheck2 data-icon="inline-start" />Relatório judicial</Button></>} />
    <Alert><ShieldAlert /><AlertTitle>Sem histórico RADIUS / CGNAT nesta base</AlertTitle><AlertDescription>A consulta abaixo pesquisa somente o IP registrado no cenário demonstrativo. Não identifica o titular de um IP em uma data passada, não cruza IP público e porta CGNAT e não produz evidência para ofícios. A ausência de resultado não comprova ausência de uso do IP.</AlertDescription></Alert>
    <Panel title="Filtros de pesquisa de IP" description="Use um IPv4 ou um bloco CIDR para consultar vínculos atuais na amostra.">
      <form onSubmit={submit} className="flex flex-col gap-5">
        <FieldGroup><Field data-invalid={Boolean(error)}><FieldLabel htmlFor="trace-ip">Endereço IPv4 registrado / bloco</FieldLabel><Textarea id="trace-ip" value={ip} onChange={e => setIp(e.target.value)} aria-invalid={Boolean(error)} aria-describedby={error ? "trace-error" : "trace-help"} placeholder="Ex.: 100.64.25.84 ou 100.64.0.0/16" rows={2} /><FieldDescription id="trace-help">Até 100 IPs ou blocos, separados por linhas, espaços ou vírgulas.</FieldDescription>{error && <FieldError id="trace-error">{error}</FieldError>}</Field></FieldGroup>
        <FieldGroup className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{[["Início do período", "datetime-local"], ["Fim do período", "datetime-local"], ["IP público CGNAT", "text"], ["Porta de origem CGNAT", "text"]].map(([label, type], index) => <Field key={label} data-disabled><FieldLabel htmlFor={`trace-unavailable-${index}`}>{label}</FieldLabel><Input id={`trace-unavailable-${index}`} type={type} disabled placeholder="Sem histórico disponível" /><FieldDescription>Requer logs históricos.</FieldDescription></Field>)}</FieldGroup>
        <div className="flex flex-wrap items-center justify-between gap-4"><Field orientation="horizontal" className="w-auto"><input id="trace-online" type="checkbox" checked={onlineOnly} onChange={e => setOnlineOnly(e.target.checked)} /><FieldLabel htmlFor="trace-online">Apenas vínculos online no cenário</FieldLabel></Field><div className="flex flex-wrap gap-2"><Button type="button" variant="ghost" onClick={() => { setIp(""); setOnlineOnly(false); setSubmittedQuery(""); setSubmittedOnline("nao"); setError(""); }}>Limpar filtros</Button><Button type="submit"><Search data-icon="inline-start" />Consultar vínculos atuais</Button></div></div>
      </form>
    </Panel>
    <Panel title="Vínculos de IP no cenário" description={submitted ? `${rows.length} registros para ${submitted.targets.join(", ")}. Consulta do cenário, não de sessões históricas.` : "Preencha os filtros para iniciar uma consulta."}>
      <div aria-live="polite"><Table><TableHeader><TableRow>{["Login / assinante", "Contrato", "IPv4 registrado", "MAC", "NAS / POP", "Conexão", "Ação"].map(label => <TableHead key={label}>{label}</TableHead>)}</TableRow></TableHeader><TableBody>{rows.map(s => <TableRow key={s.id}><TableCell><strong>{s.access?.login ?? "Não coletado"}</strong><div className="text-xs text-muted-foreground">{s.name}</div></TableCell><TableCell>{s.contract}</TableCell><TableCell className="font-mono">{s.access?.ip}</TableCell><TableCell className="font-mono">{s.access?.mac ?? "Não coletado"}</TableCell><TableCell>{s.nas}<div className="text-xs text-muted-foreground">{s.pop}</div></TableCell><TableCell><Status value={s.connection} /></TableCell><TableCell><Button variant="ghost" size="sm" onClick={() => openSubscriber(s.id)} aria-label={`Abrir ficha de ${s.name}`}><Eye data-icon="inline-start" />Ficha</Button></TableCell></TableRow>)}</TableBody></Table>{!rows.length && <OpticalEmpty title={submitted ? "Nenhum vínculo encontrado no cenário" : "Aguardando consulta de IP"} description={submitted ? "Não há vínculo atual correspondente na amostra. Esta consulta não verifica histórico, alocações de portas CGNAT ou sessões anteriores." : "Consulte os endereços registrados nos dados de acesso dos assinantes. Nenhum IP ou registro histórico é gerado automaticamente."} />}</div>
    </Panel>
    <SourceFooter sample="Vínculos atuais da amostra · não substitui logs RADIUS / CGNAT" />
  </div>;
}
