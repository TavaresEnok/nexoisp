import { useState } from 'react';
import { api, dt, useLoad, usePaged } from '../api';
import { can, useMe } from '../App';
import { Badge, Card, Field, Form, Page, Pager, State, toast } from '../ui';

/** Prazos de guarda do provedor. Vazio = padrão da instalação. Os mínimos legais são conferidos pelo servidor e pelo banco. */
function Retention() {
  const r = useLoad<any>('/settings/retention');
  const [f, setF] = useState<Record<string, string> | null>(null);
  if (!r.data) return null;
  const d = r.data, cur = f ?? { auth_log_days: String(d.auth_log_days ?? ''), sessions_days: String(d.sessions_days ?? ''), notice_log_days: String(d.notice_log_days ?? '') };
  const num = (v: string) => (v.trim() ? Number(v) : null);
  const row = (k: string, label: string, hint: string) => (
    <Field label={label} hint={`${hint} Padrão: ${d.defaults[k]} dias. Faixa: ${d.limits[k][0]} a ${d.limits[k][1]}.`}>
      <input type="number" min={d.limits[k][0]} max={d.limits[k][1]} value={cur[k]} placeholder={String(d.defaults[k])} onChange={(e) => setF({ ...cur, [k]: e.target.value })} /></Field>);
  return (
    <Card title="Retenção de dados">
      <Form submit="Salvar prazos" onSubmit={async () => { await api('/settings/retention', { method: 'PUT', body: { auth_log_days: num(cur.auth_log_days), sessions_days: num(cur.sessions_days), notice_log_days: num(cur.notice_log_days) } }); setF(null); r.reload(); toast('Prazos salvos; a limpeza periódica passa a usá-los.'); }}>
        <div className="cols3">
          {row('auth_log_days', 'Tentativas de autenticação (dias)', 'Log consultado pelo atendimento.')}
          {row('sessions_days', 'Registro de conexões (dias)', 'Mínimo de 1 ano (Marco Civil, art. 13); confirme o prazo com o jurídico.')}
          {row('notice_log_days', 'Registro de avisos enviados (dias)', 'Inclui o telefone usado.')}
        </div>
        <p className="small muted">{d.kept}</p>
      </Form>
    </Card>
  );
}

export function Audit() {
  const list = usePaged<any>('/audit');
  const { data, loading, error } = list;
  const { me } = useMe();
  return (
    <Page title="Auditoria">
      {can(me, 'settings:manage') && <Retention />}
      <State loading={loading} error={error} empty={data?.length === 0}>
        <table>
          <thead><tr><th>Quando</th><th>Autor</th><th>Ação</th><th>Entidade</th><th>Resultado</th><th>Detalhe</th></tr></thead>
          <tbody>{data?.map((a) => (
            <tr key={a.id}>
              <td style={{ whiteSpace: 'nowrap' }}>{dt(a.at)}</td>
              <td>{a.actor_name ?? '—'} <span className="muted small">({a.actor_type === 'user' ? 'usuário' : a.actor_type === 'agent' ? 'agente' : 'rotina'})</span>
                {a.detail?.support_access && <> <Badge tone="red">suporte</Badge></>}</td>
              <td className="mono">{a.action}</td>
              <td className="small">{a.entity_type}{a.entity_id && <span className="muted mono"> {String(a.entity_id).slice(0, 8)}</span>}</td>
              <td>{a.result === 'ok' ? <Badge tone="green">ok</Badge> : <Badge tone="red">{a.result === 'denied' ? 'negado' : a.result}</Badge>}</td>
              <td className="small muted mono" style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{Object.keys(a.detail ?? {}).length ? JSON.stringify(a.detail) : ''}</td>
            </tr>
          ))}</tbody>
        </table>
      <Pager p={list} />
      </State>
    </Page>
  );
}
