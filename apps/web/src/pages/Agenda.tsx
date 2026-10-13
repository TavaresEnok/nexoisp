import { useState } from 'react';
import { api, dt, useLoad } from '../api';
import { Badge, Card, Page, State } from '../ui';
import { WoBadge, WorkOrderDetail, WO_KIND } from './Field';

const today = () => new Date().toISOString().slice(0, 10);
const hhmm = (s: string) => new Date(s).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

/** Agenda de OS por técnico e dia, com sobreposição e janelas livres. */
export function Agenda() {
  const [date, setDate] = useState(today());
  const [days, setDays] = useState(1);
  const ag = useLoad<any>(`/agenda?date=${date}&days=${days}`);
  const [open, setOpen] = useState<string | null>(null);
  const [free, setFree] = useState<{ name: string; slots: any[] } | null>(null);
  const showFree = async (t: any) => {
    const r = await api<any>(`/agenda/free?assignee_id=${t.assignee_id}&date=${date}&minutes=60`);
    setFree({ name: t.name, slots: r.free });
  };
  return (
    <Page title="Agenda de OS">
      <div className="row" style={{ marginBottom: 10 }}>
        <input type="date" aria-label="Dia" value={date} onChange={(e) => setDate(e.target.value || today())} style={{ width: 170 }} />
        <select aria-label="Período" value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: 140 }}>
          <option value={1}>1 dia</option><option value={3}>3 dias</option><option value={7}>7 dias</option>
        </select>
      </div>
      <State loading={ag.loading && !ag.data} error={ag.error} empty={ag.data && ag.data.technicians.length === 0} emptyText="Nenhuma OS agendada no período.">
        {ag.data?.technicians.map((t: any) => (
          <Card key={t.assignee_id ?? 'none'} title={t.name} actions={t.assignee_id && <button className="sm" onClick={() => showFree(t)}>Horários livres</button>}>
            <table><thead><tr><th>Horário</th><th>OS</th><th>Assinante</th><th>Endereço</th><th>Situação</th></tr></thead>
              <tbody>{t.items.map((i: any) => (
                <tr key={i.id}>
                  <td className="small">{days > 1 && <>{new Date(i.scheduled_for).toLocaleDateString('pt-BR')} </>}{hhmm(i.scheduled_for)} <span className="muted">({i.estimated_minutes} min)</span>
                    {i.conflict && <> <Badge tone="red">sobreposta</Badge></>}</td>
                  <td><button className="sm" onClick={() => setOpen(i.id)}>#{i.number}</button> <span className="small muted">{WO_KIND[i.kind]}</span></td>
                  <td>{i.subscriber_name}</td><td className="small">{i.address || '—'}</td>
                  <td><WoBadge status={i.status} />{i.sla_overdue && <> <Badge tone="red">SLA</Badge></>}</td>
                </tr>))}</tbody></table>
          </Card>
        ))}
      </State>
      {free && (
        <Card title={`Horários livres de ${free.name} em ${date} (1 h, expediente 8h–18h)`} actions={<button className="sm" onClick={() => setFree(null)}>Fechar</button>}>
          {free.slots.length === 0 ? <p className="muted">Sem janela de 1 hora.</p> : <ul>{free.slots.map((s, i) => <li key={i}>{hhmm(s.from)} até {hhmm(s.to)}</li>)}</ul>}
        </Card>
      )}
      {ag.data && ag.data.awaiting_schedule.length > 0 && (
        <Card title={`Aguardando agendamento (${ag.data.awaiting_schedule.length})`}>
          <table><tbody>{ag.data.awaiting_schedule.map((w: any) => (
            <tr key={w.id}><td><button className="sm" onClick={() => setOpen(w.id)}>#{w.number}</button> <span className="small muted">{WO_KIND[w.kind]}</span></td>
              <td>{w.subscriber_name}</td><td className="small">{w.awaiting_reason ?? '—'}</td><td className="small muted">aberta {dt(w.created_at)}</td></tr>))}</tbody></table>
        </Card>
      )}
      {open && <WorkOrderDetail id={open} onClose={() => { setOpen(null); ag.reload(); }} />}
    </Page>
  );
}
