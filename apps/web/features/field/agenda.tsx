import { useState } from "react";
import useSWR from "swr";
import { useSearchParams } from "react-router-dom";
import { z } from "zod";
import { PageHeading, Panel, Status } from "@/components/workspace-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableHeader, TableHead, TableRow, TableBody, TableCell } from "@/components/ui/table";
import { FormField } from "@/features/shared/form";
import { QueryBoundary, ConnectedNotice } from "@/features/shared/feedback";
import { useSession } from "@/features/session/provider";
import { api } from "@/platform/erp-client";
import { orderKinds, orderStates } from "./labels";

const agendaItem = z.object({ id: z.string().uuid(), number: z.coerce.number(), kind: z.string(), status: z.string(), subscriber_name: z.string(), scheduled_for: z.string(), estimated_minutes: z.coerce.number(), address: z.string(), conflict: z.boolean(), sla_overdue: z.boolean() });
const agendaSchema = z.object({ date: z.string(), days: z.coerce.number(), timezone: z.string(), technicians: z.array(z.object({ assignee_id: z.string().nullable(), name: z.string(), items: z.array(agendaItem) })), awaiting_schedule: z.array(z.object({ id: z.string().uuid(), number: z.coerce.number(), kind: z.string(), subscriber_name: z.string(), awaiting_reason: z.string().nullable(), created_at: z.string() })) });
const freeSchema = z.object({ timezone: z.string(), minutes: z.coerce.number(), free: z.array(z.object({ from: z.string(), to: z.string() })) });
function today() { const date = new Date(); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }

export function OperationalAgenda() {
  const { me } = useSession();
  const [params, setParams] = useSearchParams();
  const date = params.get("dia") || today();
  const days = ["1", "3", "7"].includes(params.get("dias") ?? "") ? params.get("dias")! : "1";
  const technician = params.get("tecnico") ?? "";
  const [freeFor, setFreeFor] = useState<{ id: string; name: string } | null>(null);
  const path = `/agenda?${new URLSearchParams({ date, days, ...(technician ? { assignee_id: technician } : {}) })}`;
  const result = useSWR(["erp-agenda", path], async ([, path]) => agendaSchema.parse(await api(path)), { refreshInterval: 30000 });
  const staff = useSWR("erp-staff", () => api<{ id: string; name: string }[]>("/staff"));
  const free = useSWR(freeFor ? ["erp-agenda", "free", date, freeFor.id] : null, async ([, , date, id]) => freeSchema.parse(await api(`/agenda/free?${new URLSearchParams({ date, assignee_id: id, minutes: "60", from_hour: "8", to_hour: "18" })}`)));
  const change = (key: string, value: string) => { const next = new URLSearchParams(params); value ? next.set(key, value) : next.delete(key); setFreeFor(null); setParams(next, { replace: true }); };
  const open = (id: string) => { const next = new URLSearchParams(params); next.set("ordem", id); setParams(next); };
  const stamp = (value: string, timezone: string) => new Date(value).toLocaleString("pt-BR", { timeZone: timezone, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  return <><ConnectedNotice demo={me?.demo} /><PageHeading title="Agenda de OS" description="Visitas por técnico, sobreposições e janelas de atendimento." />
    <Panel title="Planejar as visitas" description="A agenda segue o fuso horário do provedor."><div className="erp-columns">
      <FormField label="Dia da agenda"><Input type="date" required value={date} onChange={event => change("dia", event.target.value || today())} /></FormField>
      <FormField label="Período da agenda"><select className="commercial-select" value={days} onChange={event => change("dias", event.target.value)}>{[1, 3, 7].map(value => <option key={value} value={value}>{value} dia{value > 1 ? "s" : ""}</option>)}</select></FormField>
      <FormField label="Técnico da agenda"><select className="commercial-select" value={technician} onChange={event => change("tecnico", event.target.value)}><option value="">Todos os técnicos</option>{staff.data?.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}</select></FormField>
    </div></Panel>
    <QueryBoundary loading={result.isLoading || staff.isLoading} error={result.error || staff.error} retry={() => Promise.all([result.mutate(), staff.mutate()])}>
      {result.data && <div className="erp-stack"><p className="profile-footnote">Fuso horário: {result.data.timezone} · a fila de espera abrange todo o provedor.</p>
        {!result.data.technicians.length && <Panel title="Visitas do período"><p className="profile-footnote">Nenhuma OS agendada neste período.</p></Panel>}
        {result.data.technicians.map(tech => <Panel key={tech.assignee_id ?? "none"} title={tech.name} action={tech.assignee_id && <Button variant="outline" size="sm" onClick={() => setFreeFor({ id: tech.assignee_id!, name: tech.name })}>Horários livres de {tech.name}</Button>}>
          <Table><TableHeader><TableRow><TableHead>Horário</TableHead><TableHead>OS / serviço</TableHead><TableHead>Assinante / endereço</TableHead><TableHead>Situação</TableHead></TableRow></TableHeader><TableBody>{tech.items.map(item => <TableRow key={item.id}><TableCell>{stamp(item.scheduled_for, result.data!.timezone)} · {item.estimated_minutes} min{item.conflict && <Badge variant="destructive">Sobreposição</Badge>}</TableCell><TableCell><Button variant="outline" size="sm" onClick={() => open(item.id)}>Consultar OS {item.number}</Button><p>{orderKinds[item.kind] ?? item.kind}</p></TableCell><TableCell>{item.subscriber_name}<p className="profile-footnote">{item.address || "Endereço não informado"}</p></TableCell><TableCell><Status value={orderStates[item.status] ?? item.status} />{item.sla_overdue && <Badge variant="warning">Prazo excedido</Badge>}</TableCell></TableRow>)}</TableBody></Table>
        </Panel>)}
        {freeFor && <Panel title={`Horários livres de ${freeFor.name}`} description={`Dia ${date} · janela mínima de 60 minutos entre 8h e 18h`} action={<Button variant="ghost" size="sm" onClick={() => setFreeFor(null)}>Fechar horários livres</Button>}><QueryBoundary loading={free.isLoading} error={free.error} retry={() => free.mutate()}>{free.data && <><p className="profile-footnote">Fuso horário: {free.data.timezone}</p>{free.data.free.length ? free.data.free.map(slot => <p key={slot.from}>{stamp(slot.from, free.data!.timezone)} até {stamp(slot.to, free.data!.timezone)}</p>) : <p>Sem janela de uma hora neste dia.</p>}</>}</QueryBoundary></Panel>}
        <Panel title="Aguardando agendamento" description={`${result.data.awaiting_schedule.length} OS na fila do provedor`}><div className="erp-stack">{result.data.awaiting_schedule.length ? result.data.awaiting_schedule.map(item => <div className="erp-contract-card" key={item.id}><header><strong>{item.subscriber_name} · {orderKinds[item.kind] ?? item.kind}</strong><Button variant="outline" size="sm" onClick={() => open(item.id)}>Agendar OS {item.number}</Button></header><p>{item.awaiting_reason || "Motivo não informado"}</p><small>Aberta em {stamp(item.created_at, result.data!.timezone)}</small></div>) : <p className="profile-footnote">Nenhuma OS aguardando agendamento.</p>}</div></Panel>
      </div>}
    </QueryBoundary></>;
}
