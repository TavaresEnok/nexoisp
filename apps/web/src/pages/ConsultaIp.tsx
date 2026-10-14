import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useLoad } from '../api';
import { Badge, Card, Field, Form, Page, State } from '../ui';

/** Fusos que aparecem em ofícios. O horário digitado é interpretado no fuso escolhido; o relatório mostra no mesmo fuso. */
const ZONES: [string, string][] = [['-03:00', 'Brasília (UTC−3)'], ['+00:00', 'UTC / GMT'], ['-02:00', 'UTC−2 (Fernando de Noronha)'], ['-04:00', 'UTC−4 (Manaus, Cuiabá)'], ['-05:00', 'UTC−5 (Acre)']];
const MODE: Record<string, string> = {
  cgnat_port: 'IP público de CGNAT com porta: identifica o IP privado exato',
  cgnat_shared: 'IP público de CGNAT SEM porta: compartilhado entre vários assinantes',
  direct: 'IP entregue diretamente (sem CGNAT) ou IP privado informado',
  ipv6: 'IPv6: delegação de prefixo ao contrato',
};

/** Data no fuso escolhido, com o deslocamento escrito (o ofício e a resposta precisam falar do mesmo horário). */
function fmt(iso: string | null, offset: string) {
  if (!iso) return 'em andamento';
  const sign = offset.startsWith('-') ? -1 : 1, [h, m] = offset.slice(1).split(':').map(Number);
  const d = new Date(new Date(iso).getTime() + sign * (h * 60 + m) * 60_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} (UTC${offset === '+00:00' ? '' : offset})`;
}
const csvCell = (v: unknown) => { const s = v == null ? '' : String(v); return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`; };

export function ConsultaIp() {
  const [f, setF] = useState({ ip: '', port: '', start: '', end: '', zone: '-03:00', margin: '0', reference: '' });
  const [res, setRes] = useState<any>(null);
  const hist = useLoad<any[]>('/legal/ip-lookup/history');
  const iso = (local: string) => (local.length === 16 ? `${local}:00` : local) + f.zone;
  const csv = () => {
    const head = ['assinante', 'cpf_cnpj', 'telefone', 'email', 'endereco', 'login', 'ip', 'ip_publico', 'portas', 'inicio', 'fim', 'mac', 'concentrador'];
    const lines = res.sessions.map((s: any) => [s.name, s.document, s.phone, s.email, s.address, s.login, s.ip, s.cgnat?.public_ip ?? '', s.cgnat ? `${s.cgnat.port_start}-${s.cgnat.port_end}` : '',
      fmt(s.started_at, f.zone), fmt(s.stopped_at, f.zone), s.mac, s.nas_ip].map(csvCell).join(';'));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + [head.join(';'), ...lines].join('\r\n')], { type: 'text/csv' }));
    a.download = `consulta-ip-${res.query.ip}.csv`; a.click(); URL.revokeObjectURL(a.href);
  };
  return (
    <Page title="Consulta de IP (ofício)">
      <style>{`@media print { .side, .topbar, nav, .no-print, button { display: none !important } .shell { display: block !important } .main { margin: 0 !important; padding: 0 !important } a { color: inherit; text-decoration: none } }`}</style>
      <div className="no-print">
        <p className="muted small">Para responder requisição judicial ou policial: informe o endereço, a porta (se o ofício trouxer) e o horário. Com IP de CGNAT, a porta identifica um único assinante; sem ela, aparecem todos os que compartilharam o IP no período. Toda consulta fica registrada na auditoria com o número do ofício.</p>
        <Card title="Dados do ofício">
          <Form submit="Pesquisar" onSubmit={async () => {
            const start = iso(f.start), end = iso(f.end || f.start);
            setRes(await api('/legal/ip-lookup', { body: { ip: f.ip.trim(), port: f.port ? Number(f.port) : null, from: start, to: end, margin_minutes: Number(f.margin) || 0, reference: f.reference } }));
            hist.reload();
          }}>
            <div className="cols3">
              <Field label="Endereço IP (v4 ou v6)"><input className="mono" value={f.ip} onChange={(e) => setF({ ...f, ip: e.target.value })} required placeholder="177.0.0.10" /></Field>
              <Field label="Porta de origem (opcional)" hint="Essencial quando o IP é de CGNAT."><input type="number" min="1" max="65535" value={f.port} onChange={(e) => setF({ ...f, port: e.target.value })} /></Field>
              <Field label="Nº do ofício / processo"><input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} required minLength={3} maxLength={120} /></Field>
            </div>
            <div className="cols3">
              <Field label="Data e hora (início)"><input type="datetime-local" step="1" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} required /></Field>
              <Field label="Até (opcional)" hint="Vazio = o mesmo instante."><input type="datetime-local" step="1" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} /></Field>
              <Field label="Fuso do horário informado no ofício"><select value={f.zone} onChange={(e) => setF({ ...f, zone: e.target.value })}>{ZONES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
            </div>
            <Field label="Margem (minutos para mais e para menos)" hint="Use quando os relógios podem divergir. Zero = exatamente o período informado."><input type="number" min="0" max="60" value={f.margin} onChange={(e) => setF({ ...f, margin: e.target.value })} style={{ width: 120 }} /></Field>
          </Form>
        </Card>
      </div>

      {res && (
        <Card title={`Resultado — ${res.query.ip}${res.query.port ? `:${res.query.port}` : ''}`} actions={<div className="row no-print">
          <button onClick={() => window.print()}>Imprimir relatório</button>
          {res.sessions.length > 0 && <button onClick={csv}>Exportar CSV</button>}
        </div>}>
          <p className="small">Ofício/processo <b>{res.query.reference}</b> · período {fmt(res.query.from, f.zone)} a {fmt(res.query.to, f.zone)}{res.query.margin_minutes ? ` (com margem de ${res.query.margin_minutes} min)` : ''}
            <br />Consulta feita por {res.generated_by} em {fmt(res.generated_at, f.zone)} · {MODE[res.mode]}</p>
          {res.notes.map((n: string, i: number) => <div key={i} className="state" style={{ textAlign: 'left' }}>{n}</div>)}
          {res.ipv6.length > 0 && (
            <table><thead><tr><th>Assinante</th><th>CPF/CNPJ</th><th>Prefixo delegado</th><th>Desde</th><th>Contato</th><th>Endereço</th></tr></thead>
              <tbody>{res.ipv6.map((d: any, i: number) => (
                <tr key={i}><td><Link to={`/assinantes/${d.subscriber_id}`}>{d.name}</Link></td><td className="mono">{d.document ?? '—'}</td><td className="mono small">{d.prefix}</td>
                  <td className="small">{fmt(d.created_at, f.zone)}</td><td className="small">{[d.phone, d.email].filter(Boolean).join(' · ') || '—'}</td><td className="small">{d.address || '—'}</td></tr>))}</tbody></table>
          )}
          {res.mode !== 'ipv6' && (
            <State empty={res.sessions.length === 0} emptyText="Nenhuma sessão com este endereço no período.">
              <p><b>{res.subscribers}</b> assinante(s) em <b>{res.sessions.length}</b> sessão(ões).</p>
              <table>
                <thead><tr><th>Assinante</th><th>CPF/CNPJ</th><th>Login</th><th>Endereço IP</th><th>Início</th><th>Fim</th><th>MAC</th><th>Contato / endereço</th></tr></thead>
                <tbody>{res.sessions.map((s: any, i: number) => (
                  <tr key={i}>
                    <td><Link to={`/assinantes/${s.subscriber_id}`}>{s.name}</Link></td>
                    <td className="mono">{s.document ?? '—'}</td>
                    <td className="mono small">{s.login}</td>
                    <td className="mono small">{s.ip}{s.cgnat && <div className="muted">público {s.cgnat.public_ip}, portas {s.cgnat.port_start}–{s.cgnat.port_end}</div>}</td>
                    <td className="small">{fmt(s.started_at, f.zone)}</td>
                    <td className="small">{s.stopped_at ? fmt(s.stopped_at, f.zone) : <Badge tone="green">em andamento</Badge>}</td>
                    <td className="mono small">{s.mac ?? '—'}</td>
                    <td className="small">{[s.phone, s.email].filter(Boolean).join(' · ')}<div className="muted">{s.address}</div></td>
                  </tr>))}</tbody>
              </table>
            </State>
          )}
          {res.fixed.length > 0 && <p className="small muted">IP fixo cadastrado hoje: {res.fixed.map((x: any) => `${x.ip} → ${x.name}`).join('; ')} (o histórico vale pelas sessões acima).</p>}
          <p className="small muted">Fonte: registro de sessões do provedor (accounting){res.records_since ? `, disponível desde ${fmt(res.records_since, f.zone)}` : ''}.</p>
        </Card>
      )}

      <div className="no-print">
        <Card title="Consultas anteriores">
          <State loading={hist.loading && !hist.data} error={hist.error} empty={hist.data?.length === 0} emptyText="Nenhuma consulta feita ainda.">
            <table><thead><tr><th>Quando</th><th>Quem</th><th>Ofício</th><th>Endereço</th><th>Período</th><th className="num">Assinantes</th></tr></thead>
              <tbody>{hist.data?.map((h, i) => (
                <tr key={i}><td className="small">{new Date(h.at).toLocaleString('pt-BR')}</td><td className="small">{h.user_name ?? '—'}</td><td>{h.detail.reference}</td>
                  <td className="mono small">{h.detail.ip}{h.detail.port ? `:${h.detail.port}` : ''}</td>
                  <td className="small">{new Date(h.detail.from).toLocaleString('pt-BR')} → {new Date(h.detail.to).toLocaleString('pt-BR')}</td><td className="num">{h.detail.subscribers}</td></tr>))}</tbody></table>
          </State>
        </Card>
      </div>
    </Page>
  );
}
