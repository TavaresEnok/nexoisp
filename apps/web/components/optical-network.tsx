"use client";

import { useState, type ReactNode } from "react";
import { useQueryState } from "@/lib/use-query-state";
import Link from "@/platform/navigation/link";
import { Cable, Download, Eye, Server, Signal, Users, Workflow } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel, FieldDescription } from "@/components/ui/field";
import { Badge } from "@/components/ui/badge";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { PageHeading, Panel, SourceFooter, Status } from "@/components/workspace-ui";
import { OpticalEmpty, OpticalMetrics, OpticalNavigation, OpticalNotice } from "@/components/optical-ui";
import { useWorkspace } from "@/features/workspace/context";
import { exportCsv, normalize } from "@/lib/format";
import { averageOpticalSignal, groupOpticalPorts, type PonGroup } from "@/lib/optical-network";
import type { NetworkNode } from "@/lib/types";

export function OpticalNetwork({ mode }: { mode: "olt" | "pon" | "cto" }) {
  const { data, openSubscriber } = useWorkspace();
  const [query, setQuery] = useQueryState("busca", "");
  const [oltFilter, setOltFilter] = useQueryState("olt", "", ["", ...data.subscribers.flatMap(s => s.access?.olt ? [s.access.olt] : [])]);
  const [status, setStatus] = useQueryState("situacao", "", ["", ...data.nodes.filter(n => n.type === "OLT").map(n => n.status)]);
  const [selectedOlt, setSelectedOlt] = useState<NetworkNode | null>(null);
  const [selectedPon, setSelectedPon] = useState<PonGroup | null>(null);
  const [schemaOpen, setSchemaOpen] = useState(false);
  const olts = data.nodes.filter(n => n.type === "OLT");
  const pons = groupOpticalPorts(data.subscribers);
  const opticalSubscribers = data.subscribers.filter(s => s.access?.olt);
  const rows = olts.filter(n => (!status || n.status === status) && normalize([n.name, n.ip, n.pop, n.vendor].join(" ")).includes(normalize(query)));
  const ponRows = pons.filter(p => (!oltFilter || p.olt === oltFilter) && normalize([p.olt, p.slot, p.pon].join(" ")).includes(normalize(query)));
  const average = averageOpticalSignal(opticalSubscribers);
  const title = mode === "olt" ? "Concentradores OLT" : mode === "pon" ? "Portas PON" : "Caixas de terminação óptica";
  const selectedSubscribers = selectedPon?.subscribers ?? data.subscribers.filter(s => s.access?.olt === selectedOlt?.name && Boolean(selectedOlt));
  const exportRows = () => {
    if (mode === "olt") exportCsv("nexo-olts", ["OLT", "Host IP", "Fabricante", "POP", "Status", "PONs identificadas", "ONUs vinculadas na amostra"], rows.map(n => [n.name, n.ip, n.vendor, n.pop, n.status, pons.filter(p => p.olt === n.name).length, data.subscribers.filter(s => s.access?.olt === n.name && s.onu).length]));
    else exportCsv("nexo-pons", ["OLT", "Slot", "PON", "ONUs vinculadas na amostra", "Sinal médio RX (dBm)"], ponRows.map(p => [p.olt, p.slot, p.pon, p.subscribers.filter(s => s.onu).length, averageOpticalSignal(p.subscribers) ?? "Não coletado"]));
  };
  return <OpticalPage title={title} description={mode === "olt" ? "Concentradores, vínculos ópticos e disponibilidade em uma visão centralizada." : mode === "pon" ? "Consulte as portas identificadas nos vínculos de acesso dos assinantes." : "Organização de caixas, portas e assinantes da rede FTTH."} actions={<>{mode !== "cto" && <Button variant="outline" disabled={mode === "olt" ? !rows.length : !ponRows.length} onClick={exportRows}><Download data-icon="inline-start" />Exportar CSV</Button>}<Button variant="outline" onClick={() => setSchemaOpen(true)}><Eye data-icon="inline-start" />Estrutura de cadastro</Button></>} mode={mode} metrics={mode === "cto" ? [
      { label: "CTOs cadastradas", value: "—", detail: "Cadastro ainda não disponível", icon: Cable },
      { label: "Portas ocupadas", value: "—", detail: "Sem vínculo de porta CTO", icon: Users },
      { label: "Portas disponíveis", value: "—", detail: "Capacidade não informada", icon: Workflow },
      { label: "Ocupação da rede", value: "—", detail: "Não calculada sem cadastro", icon: Signal },
    ] : [
      { label: "OLTs cadastradas", value: olts.length, detail: "Equipamentos do cenário", icon: Server },
      { label: "PONs identificadas", value: pons.length, detail: "Vínculos completos de OLT / slot / PON", icon: Workflow },
      { label: "ONUs vinculadas", value: opticalSubscribers.filter(s => s.onu).length, detail: "Apenas assinantes da amostra", icon: Users },
      { label: "Sinal médio RX", value: average === null ? "—" : `${average.toFixed(1)} dBm`, detail: "ONUs online com leitura válida", icon: Signal },
    ]}>
    <OpticalNotice>{mode === "cto" ? "A base não contém cadastro de CTOs, coordenadas de caixas ou ocupação por porta. Nenhuma caixa ou capacidade foi presumida a partir dos endereços dos assinantes." : "Dados do workspace, sem coleta SNMP em tempo real. Portas, capacidades e vínculos ausentes não são estimados. Cadastro, importação e alterações de equipamentos não estão habilitados neste ambiente."}</OpticalNotice>
    {mode !== "cto" && <OpticalFilters description="Filtre os registros disponíveis na base demonstrativa." searchLabel={mode === "olt" ? "OLT" : "porta PON"} placeholder={mode === "olt" ? "Nome, IP, fabricante ou POP…" : "OLT, slot ou porta…"} query={query} onQuery={setQuery} filterLabel={mode === "olt" ? "Status do equipamento" : "OLT concentradora"} allLabel={mode === "olt" ? "Todos os status" : "Todas as OLTs"} value={mode === "olt" ? status : oltFilter} onValue={value => mode === "olt" ? setStatus(value) : setOltFilter(value)} options={mode === "olt" ? [...new Set(olts.map(n => n.status))] : [...new Set([...olts.map(n => n.name), ...pons.map(p => p.olt)])]} />}
    <Panel title={mode === "olt" ? "Inventário de OLTs" : mode === "pon" ? "Identificação das portas PON" : "Inventário de CTOs"} description={mode === "cto" ? "Identificação, PON, ocupação e localização das caixas." : `${mode === "olt" ? rows.length : ponRows.length} registros nesta consulta.`}>
      {mode === "olt" ? <Table><TableHeader><TableRow>{["OLT / Host IP", "Fabricante", "POP", "PONs identificadas", "ONUs na amostra", "Status", "Ações"].map(label => <TableHead key={label}>{label}</TableHead>)}</TableRow></TableHeader><TableBody>{rows.map(n => <TableRow key={n.id}><TableCell><strong>{n.name}</strong><div className="font-mono text-xs text-muted-foreground">{n.ip}</div></TableCell><TableCell>{n.vendor}</TableCell><TableCell>{n.pop}</TableCell><TableCell>{pons.filter(p => p.olt === n.name).length}</TableCell><TableCell>{data.subscribers.filter(s => s.access?.olt === n.name && s.onu).length}</TableCell><TableCell><Status value={n.status} /></TableCell><TableCell><Button size="sm" variant="ghost" aria-label={`Detalhes de ${n.name}`} onClick={() => setSelectedOlt(n)}><Eye data-icon="inline-start" />Detalhes</Button></TableCell></TableRow>)}</TableBody></Table> : mode === "pon" ? <PonPortTable rows={ponRows.map(p => ({ id: p.id, olt: p.olt, slot: p.slot, pon: p.pon, onus: p.subscribers.filter(s => s.onu).length, rx: averageOpticalSignal(p.subscribers) }))} onSelect={id => setSelectedPon(ponRows.find(p => p.id === id) ?? null)} /> : <Table><TableHeader><TableRow>{["Identificação", "OLT / PON", "Portas totais", "Ocupadas", "Disponíveis", "Localização", "Status"].map(label => <TableHead key={label}>{label}</TableHead>)}</TableRow></TableHeader><TableBody /></Table>}
      {(mode === "cto" || (mode === "olt" ? !rows.length : !ponRows.length)) && <OpticalEmpty title={mode === "cto" ? "Cadastro de CTOs ainda não disponível" : "Nenhum registro encontrado"} description={mode === "cto" ? "A matriz de portas e a consulta de assinantes por caixa dependem do cadastro e do vínculo de cada porta. Consulte a estrutura de cadastro para ver os campos previstos." : mode === "pon" && !pons.length ? "Os assinantes da base não possuem vínculos completos de OLT, slot e PON. A consulta exibirá apenas portas com identificação registrada." : "Revise os filtros de pesquisa para ampliar a consulta."} />}
    </Panel>
    <SourceFooter sample="Inventário óptico demonstrativo · sem alterações em equipamentos" />
    <Sheet open={Boolean(selectedOlt || selectedPon)} onOpenChange={open => { if (!open) { setSelectedOlt(null); setSelectedPon(null); } }}><SheetContent className="overflow-y-auto"><SheetHeader><SheetTitle>{selectedOlt?.name ?? `Slot ${selectedPon?.slot} · PON ${selectedPon?.pon}`}</SheetTitle><SheetDescription>{selectedOlt ? "Dados do equipamento e assinantes com vínculo explícito." : selectedPon?.olt}</SheetDescription></SheetHeader><div className="flex flex-col gap-6 p-5">{selectedOlt && <><dl className="grid grid-cols-2 gap-4 text-sm">{[["Host IP", selectedOlt.ip], ["Fabricante", selectedOlt.vendor], ["POP", selectedOlt.pop], ["Status", selectedOlt.status], ["Latência", `${selectedOlt.latency} ms`], ["Uso de CPU", `${selectedOlt.cpu}%`]].map(([label, value]) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd className="mt-1 font-medium">{value}</dd></div>)}</dl><Link href={`/rede/ftth/fttx-pon?olt=${encodeURIComponent(selectedOlt.name)}`} className={buttonVariants({ variant: "outline" })} onClick={() => setSelectedOlt(null)}><Workflow data-icon="inline-start" />Consultar portas PON</Link></>}<h2>Assinantes vinculados <Badge variant="secondary">{selectedSubscribers.length}</Badge></h2>{selectedSubscribers.length ? selectedSubscribers.map(s => <Button variant="outline" key={s.id} onClick={() => { setSelectedOlt(null); setSelectedPon(null); openSubscriber(s.id); }}>{s.name}</Button>) : <OpticalEmpty title="Sem vínculos de assinantes" description="Nenhum assinante possui vínculo explícito com este equipamento ou porta na amostra atual." />}</div></SheetContent></Sheet>
    <OpticalSchema mode={mode} open={schemaOpen} onOpenChange={setSchemaOpen} />
  </OpticalPage>;
}

function OpticalSchema({ mode, open, onOpenChange }: { mode: "olt" | "pon" | "cto"; open: boolean; onOpenChange: (open: boolean) => void }) {
  const fields = mode === "olt" ? ["Fabricante / driver", "Nome da OLT", "Host IP", "Slots", "Protocolo de acesso", "Porta de acesso", "Usuário", "Senha", "SNMP versão", "SNMP community", "SNMP porta", "Limite de sinal RX alto", "Limite de sinal RX baixo"] : mode === "pon" ? ["OLT concentradora", "Descrição técnica", "Slot", "Porta PON", "Tecnologia FTTx", "VLAN ID", "Capacidade máxima de ONUs", "Limite de RX"] : ["Identificação da CTO", "OLT / Slot / PON", "Fabricante", "Total de portas", "Portas desativadas", "Tipo de conector", "Latitude / longitude", "Localização / observações", "Estação de transmissão"];
  return <Sheet open={open} onOpenChange={onOpenChange}><SheetContent className="overflow-y-auto"><SheetHeader><SheetTitle>Estrutura de cadastro · {mode.toUpperCase()}</SheetTitle><SheetDescription>Campos previstos a partir do modelo enviado. Prévia de estrutura, sem gravação.</SheetDescription></SheetHeader><div className="flex flex-col gap-5 p-5"><OpticalNotice>O cadastro exige persistência específica e autorização de escrita, ainda não disponíveis neste ambiente público. Não informe credenciais reais.</OpticalNotice><FieldGroup>{fields.map((label, index) => <Field key={label} data-disabled><FieldLabel htmlFor={`schema-${mode}-${index}`}>{label}</FieldLabel><Input id={`schema-${mode}-${index}`} disabled placeholder="Cadastro indisponível neste ambiente" type={label === "Senha" ? "password" : "text"} /></Field>)}<FieldDescription>{mode === "olt" ? "Comandos, TL1 e regras de provisionamento também dependem da integração com o driver do equipamento." : mode === "pon" ? "Cadastro em lote e importação CSV dependem da habilitação de escrita e validação dos vínculos com a OLT." : "Verificação de porta, limites de capacidade e matriz de ocupação dependem dos vínculos persistidos de cada ONU."}</FieldDescription></FieldGroup></div></SheetContent></Sheet>;
}

export function OpticalPage({ title, description, actions, mode, metrics, children }: { title: string; description: string; actions?: ReactNode; mode: string; metrics?: Parameters<typeof OpticalMetrics>[0]["items"]; children: ReactNode }) {
  return <div className="flex flex-col gap-6">
    <PageHeading eyebrow="INFRAESTRUTURA · REDE / FTTx" title={title} description={description} actions={actions} />
    <OpticalNavigation mode={mode} />
    {metrics && <OpticalMetrics items={metrics} />}
    {children}
  </div>;
}

// Peças da tela PON compartilhadas entre a demonstração e a operação.
export function OpticalFilters({ description, searchLabel, placeholder, query, onQuery, filterLabel, allLabel, value, onValue, options }: { description: string; searchLabel: string; placeholder: string; query: string; onQuery: (value: string) => void; filterLabel: string; allLabel: string; value: string; onValue: (value: string) => void; options: string[] }) {
  return <Panel title="Filtros de consulta" description={description}><FieldGroup className="grid gap-4 md:grid-cols-2"><Field><FieldLabel htmlFor="optical-search">Buscar {searchLabel}</FieldLabel><Input id="optical-search" placeholder={placeholder} value={query} onChange={e => onQuery(e.target.value)} /></Field><Field><FieldLabel htmlFor="optical-filter">{filterLabel}</FieldLabel><select id="optical-filter" className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={value} onChange={e => onValue(e.target.value)}><option value="">{allLabel}</option>{options.map(value => <option key={value}>{value}</option>)}</select></Field></FieldGroup></Panel>;
}
export type PonPortRow = { id: string; olt: string; slot: string; pon: string; onus: number; rx: number | null; capacity?: string };
export function PonPortTable({ rows, onSelect, onusLabel = "ONUs na amostra" }: { rows: PonPortRow[]; onSelect: (id: string) => void; onusLabel?: string }) {
  return <Table><TableHeader><TableRow>{["OLT", "Slot", "PON", onusLabel, "RX médio", "Capacidade / VLAN", "Ações"].map(label => <TableHead key={label}>{label}</TableHead>)}</TableRow></TableHeader><TableBody>{rows.map(p => <TableRow key={p.id}><TableCell>{p.olt}</TableCell><TableCell>{p.slot}</TableCell><TableCell>{p.pon}</TableCell><TableCell>{p.onus}</TableCell><TableCell>{p.rx?.toFixed(1) ?? "—"}</TableCell><TableCell>{p.capacity ?? "Não coletadas"}</TableCell><TableCell><Button variant="ghost" size="sm" onClick={() => onSelect(p.id)} aria-label={`Assinantes de ${p.olt}, slot ${p.slot}, PON ${p.pon}`}><Users data-icon="inline-start" />Assinantes</Button></TableCell></TableRow>)}</TableBody></Table>;
}
