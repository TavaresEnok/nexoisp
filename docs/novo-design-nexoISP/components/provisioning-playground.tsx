"use client";

import { useState } from "react";
import { CheckCircle2, Play, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, FieldGroup, FieldLabel, FieldDescription } from "@/components/ui/field";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { CodePreview } from "@/components/technical-ui";
import { cliVariables, compileProvisioning, type CliVariables, type OnuTemplate } from "@/lib/technical-catalog";
import styles from "@/components/technical.module.css";

export function ProvisioningPlayground({ templates, initialTemplateId }: { templates: OnuTemplate[]; initialTemplateId?: string }) {
  const initial = templates.find(t => t.id === initialTemplateId) ?? templates[0];
  const [templateId, setTemplateId] = useState(initial?.id ?? "");
  const [source, setSource] = useState(initial ? [initial.gpon, initial.wan].filter(Boolean).join("\n\n") : "");
  const [variables, setVariables] = useState<CliVariables>({ vlan: "901", slot: "0", pon: "1", sn: "HWTC00000001", login: "assinante.lab" });
  const [result, setResult] = useState<ReturnType<typeof compileProvisioning> | null>(null);
  const labels: Record<keyof CliVariables, string> = { vlan: "VLAN", slot: "Slot", pon: "PON", sn: "Serial da ONU", login: "Login PPPoE" };
  return <section className={styles.catalog}><div className={styles.catalogHeader}><div><h2>Testador de variáveis CLI / OMCI</h2><p>Processe parâmetros de intenção sem conectar ou enviar comandos à OLT.</p></div></div><div className={styles.playground}><form className={styles.editor} onSubmit={e => { e.preventDefault(); setResult(compileProvisioning(source, variables)); }}><FieldGroup><Field><FieldLabel htmlFor="cli-preset">Template de referência</FieldLabel><select className={styles.select} id="cli-preset" value={templateId} onChange={e => { const preset = templates.find(t => t.id === e.target.value); setTemplateId(e.target.value); setSource(preset ? [preset.gpon, preset.wan].filter(Boolean).join("\n\n") : ""); setResult(null); }}><option value="">Personalizado</option>{templates.map(t => <option value={t.id} key={t.id}>{t.name}</option>)}</select></Field><FieldGroup className={styles.variables}>{cliVariables.map(key => <Field key={key}><FieldLabel htmlFor={`cli-${key}`}>{labels[key]}</FieldLabel><Input id={`cli-${key}`} value={variables[key]} autoComplete="off" maxLength={64} onChange={e => { setVariables({ ...variables, [key]: e.target.value }); setResult(null); }} /><FieldDescription>{`%${key}%`}</FieldDescription></Field>)}</FieldGroup><Field><FieldLabel htmlFor="cli-source">Template de entrada</FieldLabel><Textarea id="cli-source" value={source} spellCheck={false} maxLength={20000} onChange={e => { setSource(e.target.value); setTemplateId(""); setResult(null); }} /><FieldDescription>Edição temporária para este teste; não altera o catálogo. Não informe senhas.</FieldDescription></Field></FieldGroup><Button type="submit"><Play data-icon="inline-start" />Validar e processar</Button></form><div className={styles.result}><Alert><TriangleAlert /><AlertTitle>Validação local, não homologação</AlertTitle><AlertDescription>Verifica variáveis e formatos, não sintaxe do fabricante, firmware, disponibilidade ou aplicação em equipamento. Os perfis são exemplos de intenção.</AlertDescription></Alert>{result && (result.errors.length ? <Alert variant="destructive" role="alert"><TriangleAlert /><AlertTitle>Revise os parâmetros</AlertTitle><AlertDescription><ul>{result.errors.map(error => <li key={error}>{error}</li>)}</ul></AlertDescription></Alert> : <Alert role="status"><CheckCircle2 /><AlertTitle>Variáveis processadas</AlertTitle><AlertDescription>{result.used.length} variáveis substituídas. Nenhum comando foi executado.</AlertDescription></Alert>)}<CodePreview title="Resultado processado" code={result?.output ?? "Valide o template para visualizar o resultado."} filename={result?.output ? "nexo-intencao-provisionamento.txt" : undefined} /></div></div></section>;
}
