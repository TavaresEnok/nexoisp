import { useState } from "react";
import { z } from "zod";
import { Panel } from "@/components/workspace-ui";
import { Table, TableHeader, TableHead, TableRow, TableBody, TableCell } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ProfileFacts } from "@/components/subscriber-profile-sections";
import { RecordEditor } from "@/features/shared/record-editor";
import { FormField } from "@/features/shared/form";
import { QueryBoundary } from "@/features/shared/feedback";
import { ActionButton } from "@/features/shared/action";
import { useSession } from "@/features/session/provider";
import { can } from "@/features/session/model";
import { api } from "@/platform/erp-client";
import { useAgents, useNetworkRefresh } from "./queries";
import { stamp } from "./models";
const credentialSchema=z.object({id:z.string().uuid(),token:z.string().min(1),signing_public_key:z.string().min(1)});
export function AgentDirectory(){
 const {me}=useSession();const writable=can(me,'network:write');const result=useAgents();const refresh=useNetworkRefresh();const [creating,setCreating]=useState(false);const [credential,setCredential]=useState<z.infer<typeof credentialSchema>|null>(null);
 return <Panel title="Agentes locais" description="Conexão e sincronização conforme o último relato recebido." action={writable&&<Button onClick={()=>setCreating(true)}>Novo agente</Button>}><QueryBoundary loading={result.isLoading} error={result.error} retry={()=>result.mutate()}>{result.data?.filter(agent=>!agent.internal).length?<Table><TableHeader><TableRow>{['Agente / certificado','Conexão','Último contato / sincronização','Versão','Equipamentos / fila','Ações'].map(label=><TableHead key={label}>{label}</TableHead>)}</TableRow></TableHeader><TableBody>{result.data.filter(agent=>!agent.internal).map(agent=><TableRow key={agent.id}>
 <TableCell><strong>{agent.name}</strong><p className="profile-footnote mono">{agent.id}</p><p className="profile-footnote">{agent.cert_fingerprint?`Certificado fixado: ${agent.cert_fingerprint}`:'Certificado ainda não apresentado'}</p>{agent.cert_pinned_at&&<small>Fixado em {stamp(agent.cert_pinned_at)}</small>}</TableCell><TableCell><Badge variant={agent.status==='revoked'?'destructive':agent.online?'outline':'warning'}>{agent.status==='revoked'?'Revogado':agent.online?'Online':'Offline'}</Badge></TableCell><TableCell>{stamp(agent.last_seen_at)}<p className="profile-footnote">Sincronização: {stamp(agent.last_sync_at)}</p></TableCell><TableCell>{agent.version??'—'}</TableCell><TableCell>{agent.devices} equipamento(s) · {agent.open_operations} operação(ões){agent.oldest_pending&&<p className="profile-footnote">Pendente desde {stamp(agent.oldest_pending)}</p>}</TableCell>
 <TableCell>{writable&&<div className="erp-inline-actions"><ActionButton confirm="Gerar outro token? O token atual deixa de funcionar imediatamente." onClick={async()=>{const value=credentialSchema.parse(await api(`/agents/${agent.id}`,{method:'PATCH',body:{rotate_token:true}}));setCredential(value);await refresh();}}>Rotacionar token</ActionButton>{agent.cert_fingerprint&&<ActionButton confirm="Descartar o certificado fixado? O próximo certificado válido apresentado pelo agente será aceito como substituto." onClick={async()=>{await api(`/agents/${agent.id}`,{method:'PATCH',body:{reset_certificate:true}});await refresh();}}>Aceitar novo certificado</ActionButton>}<ActionButton danger={agent.status==='active'} confirm={agent.status==='active'?'Revogar o agente e interromper o recebimento de novas operações?':undefined} onClick={async()=>{await api(`/agents/${agent.id}`,{method:'PATCH',body:{status:agent.status==='active'?'revoked':'active'}});await refresh();}}>{agent.status==='active'?'Revogar agente':'Reativar agente'}</ActionButton></div>}</TableCell>
 </TableRow>)}</TableBody></Table>:<p className="profile-footnote">Nenhum agente local cadastrado.</p>}</QueryBoundary>
 {creating&&<RecordEditor title="Novo agente" description="Identifique o servidor ou local onde o agente será instalado." initial={{name:''}} fields={[{key:'name',label:'Nome do agente',required:true,maxLength:80}]} submit="Criar agente" onClose={()=>setCreating(false)} onSubmit={async values=>{const value=credentialSchema.parse(await api('/agents',{body:values}));setCreating(false);setCredential(value);await refresh();}} />}
 {credential&&<Dialog open onOpenChange={open=>{if(!open)setCredential(null);}}><DialogContent className="erp-editor"><DialogHeader><DialogTitle>Credenciais do agente</DialogTitle><DialogDescription>Copie agora. O token é exibido somente nesta emissão e será descartado ao fechar esta janela.</DialogDescription></DialogHeader><ProfileFacts items={[["ID do agente",credential.id],["Identidade do certificado",`CN=agent:${credential.id}`]]} /><FormField label="Token do agente"><Input readOnly className="mono" autoComplete="off" value={credential.token} onFocus={event=>event.currentTarget.select()} /></FormField><FormField label="Chave pública de assinatura"><Textarea readOnly className="mono" value={credential.signing_public_key} onFocus={event=>event.currentTarget.select()} /></FormField><Button onClick={()=>setCredential(null)}>Já guardei as credenciais</Button></DialogContent></Dialog>}
 </Panel>;
}
