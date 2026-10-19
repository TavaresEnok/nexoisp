"use client";

import { useState } from "react";
import { Copy, Download, FileCode2, FileJson2, ScanLine, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { ProfileSection } from "@/components/subscriber-profile-sections";
import { TechnicalHeading, RadiusTable } from "@/components/subscriber-technical-panels";
import { buildOnuReadOnlyScript } from "@/lib/subscriber-profile";
import { buildHuaweiDiagnosticScript, MAX_EVIDENCE_LENGTH, parseHuaweiEvidence, parseRadiusEvidence, type OnuEvidence, type RadiusRecord } from "@/lib/subscriber-diagnostics";
import type { Subscriber } from "@/lib/types";
import { downloadContent } from "@/platform/browser";

export function downloadDiagnostic(content: string, filename: string) {
  downloadContent(filename, content);
}

export function OnuDiagnosticTools({ subscriber: s, evidence, onEvidence, copy }: { subscriber: Subscriber; evidence: OnuEvidence | null; onEvidence: (value: OnuEvidence | null) => void; copy: (value: string) => void }) {
  const [location, setLocation] = useState({ frame: "", slot: "", pon: "", ontId: "" });
  const [script, setScript] = useState<string | null>(null);
  const [raw, setRaw] = useState("");
  const [error, setError] = useState("");
  const generate = (full: boolean) => {
    try { setScript(full ? buildHuaweiDiagnosticScript(s.onu, location) : buildOnuReadOnlyScript(s.onu)); setError(""); }
    catch (e) { setScript(null); setError(e instanceof Error ? e.message : "Não foi possível gerar os comandos."); }
  };
  const analyze = () => {
    try {
      const parsed = parseHuaweiEvidence(raw, s.onu);
      onEvidence(parsed); setError("");
      const path = parsed.fields["f/s/p"]?.replace(/\s/g, "").split("/");
      if (path?.length === 3) setLocation({ frame: path[0], slot: path[1], pon: path[2], ontId: parsed.fields["ont-id"] ?? "" });
      toast.success("Saída interpretada. Consulte os painéis de Óptica e FTTx.");
    } catch (e) { setError(e instanceof Error ? e.message : "Não foi possível interpretar a saída."); }
  };
  return <><TechnicalHeading title="Diagnóstico manual" description="Prepare os comandos, execute no ambiente autorizado e analise o retorno. Nenhuma conexão é aberta por esta tela." /><ProfileSection title="01 · Preparar a coleta Huawei" caption="Confirme fabricante, modelo e firmware. O bloco com interface pressupõe o contexto de configuração apropriado na CLI."><div className="technical-script-toolbar"><Button variant="outline" onClick={() => generate(false)} disabled={!s.onu}><FileCode2 data-icon="inline-start" />Localizar por serial</Button><Badge variant="outline">Somente leitura</Badge><span className="mono">{s.onu || "Serial ausente"}</span></div><FieldGroup className="technical-location-fields">{([["frame", "Frame"], ["slot", "Slot"], ["pon", "PON"], ["ontId", "ONT-ID"]] as const).map(([key, label]) => <Field key={key}><FieldLabel htmlFor={`onu-${key}`}>{label}</FieldLabel><Input id={`onu-${key}`} value={location[key]} inputMode="numeric" maxLength={3} autoComplete="off" onChange={event => { setLocation(value => ({ ...value, [key]: event.target.value })); setScript(null); }} /></Field>)}</FieldGroup><div className="technical-script-toolbar"><Button variant="outline" disabled={!s.onu} onClick={() => generate(true)}><FileCode2 data-icon="inline-start" />Gerar coleta completa</Button><span>Identidade · óptica · estado · versão</span></div>{script && <div className="technical-terminal"><header><span>Prévia CLI · perfil Huawei</span><Badge variant="outline">Não executado</Badge></header><pre><code>{script}</code></pre><footer><Button variant="ghost" size="sm" onClick={() => copy(script)}><Copy data-icon="inline-start" />Copiar comandos</Button><Button variant="ghost" size="sm" onClick={() => downloadDiagnostic(script, `coleta-${s.code}-huawei.txt`)}><Download data-icon="inline-start" />Baixar .txt</Button></footer></div>}<p className="profile-footnote">Frame, slot, PON e ONT-ID precisam ser confirmados pelo operador. Gerar o bloco não confirma que a ONU está nessa porta.</p></ProfileSection><ProfileSection title="02 · Interpretar a saída da OLT" caption="Cole uma única coleta com SN, incluindo display ont info, optical-info e version. O serial precisa corresponder ao cadastro."><FieldGroup><Field data-invalid={!!error}><FieldLabel htmlFor="onu-evidence">Saída bruta Huawei</FieldLabel><textarea id="onu-evidence" className="technical-evidence-input mono" rows={9} maxLength={MAX_EVIDENCE_LENGTH} value={raw} aria-invalid={!!error} aria-describedby="onu-evidence-note" spellCheck={false} onChange={event => setRaw(event.target.value)} placeholder="Cole aqui o retorno obtido manualmente na CLI…" /></Field></FieldGroup><p id="onu-evidence-note" className="profile-footnote">Análise temporária desta ficha. Não salva no cadastro nem constitui auditoria. Não cole senhas ou configurações completas.</p>{error && <p className="technical-error" role="alert">{error}</p>}<div className="technical-script-toolbar"><Button onClick={analyze} disabled={!raw.trim() || !s.onu}><ScanLine data-icon="inline-start" />Interpretar saída</Button>{evidence && <><Button variant="outline" onClick={() => downloadDiagnostic(evidence.raw, `evidencia-onu-${s.code}.txt`)}><Download data-icon="inline-start" />Exportar evidência</Button><Button variant="ghost" onClick={() => { onEvidence(null); setRaw(""); setError(""); setScript(null); }}>Descartar análise</Button></>}</div></ProfileSection><p className="profile-footnote"><ShieldCheck size={13} />Sem polling, comandos livres, reinício, alteração de VLAN ou reautorização. A execução na OLT ainda não está conectada.</p></>;
}

export function RadiusImport({ records, onRecords }: { records: RadiusRecord[]; onRecords: (records: RadiusRecord[]) => void }) {
  const [login, setLogin] = useState("");
  const [raw, setRaw] = useState("");
  const [error, setError] = useState("");
  const [showImport, setShowImport] = useState(false);
  const analyze = () => {
    try { onRecords(parseRadiusEvidence(raw, login)); setError(""); setShowImport(false); toast.success("Sessões conferidas e organizadas para análise."); }
    catch (e) { setError(e instanceof Error ? e.message : "Formato inválido."); }
  };
  return <><ProfileSection title="Accounting e histórico de sessões" caption="Sem consulta automática ao servidor RADIUS. Analise uma exportação fornecida pelo operador." action={<Button variant="outline" size="sm" onClick={() => setShowImport(value => !value)}><FileJson2 data-icon="inline-start" />{showImport ? "Fechar importação" : "Analisar JSON"}</Button>}>
    {showImport && <div className="technical-import"><FieldGroup><Field><FieldLabel htmlFor="radius-login">Login esperado</FieldLabel><Input id="radius-login" value={login} maxLength={128} autoComplete="off" onChange={event => setLogin(event.target.value)} /></Field><Field data-invalid={!!error}><FieldLabel htmlFor="radius-evidence">Exportação RADIUS · JSON</FieldLabel><textarea id="radius-evidence" className="technical-evidence-input mono" rows={8} value={raw} maxLength={MAX_EVIDENCE_LENGTH} aria-invalid={!!error} spellCheck={false} onChange={event => setRaw(event.target.value)} placeholder="Cole um array de registros radacct…" /></Field></FieldGroup><details className="technical-format"><summary>Formato aceito e campos obrigatórios</summary><p>Array JSON, até 200 sessões do mesmo login. Obrigatórios: username, acctsessionid, acctstarttime (ISO com fuso), acctstoptime (ISO ou null), acctsessiontime (segundos) e nasipaddress (IPv4).</p><p>Opcionais: framedipaddress, callingstationid (MAC), acctterminatecause, acctinputoctets, acctoutputoctets, delegatedipv6prefix e nasportid. Contadores devem ser números inteiros em bytes, já somados aos gigawords na exportação.</p></details>{error && <p className="technical-error" role="alert">{error}</p>}<Button onClick={analyze} disabled={!login.trim() || !raw.trim()}><ScanLine data-icon="inline-start" />Validar sessões</Button></div>}
    {records.length ? <><div className="technical-session-summary"><span><strong>{records.length}</strong> sessões no arquivo</span><span>Login <strong className="mono">{records[0].username}</strong></span><span><strong>{records.filter(row => !row.acctstoptime).length}</strong> sem encerramento informado</span></div><RadiusTable records={records} /><p className="profile-footnote">Tempos e volumes refletem o arquivo, não o estado atual. Contadores de entrada e saída são apresentados na perspectiva do NAS, sem inferir download e upload.</p><div className="technical-script-toolbar"><Button variant="ghost" size="sm" onClick={() => downloadDiagnostic(JSON.stringify(records, null, 2), "radius-analisado.json")}><Download data-icon="inline-start" />Exportar sessões</Button><Button variant="ghost" size="sm" onClick={() => { onRecords([]); setRaw(""); setLogin(""); setError(""); }}>Descartar sessões</Button></div></> : <div className="technical-empty"><FileJson2 size={24} /><strong>Nenhuma sessão RADIUS carregada</strong><p>Início, duração, IP, MAC e motivos de encerramento aparecerão aqui após validar a exportação. Não são inferidos a partir do estado do assinante.</p></div>}
    <p className="profile-footnote">Análise temporária, sem gravação no cadastro. O login informado pelo operador deve corresponder a todos os registros; o cadastro atual não possui login para confirmação independente.</p></ProfileSection></>;
}
