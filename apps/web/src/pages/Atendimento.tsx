import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, d, dt, download, money, useLoad } from '../api';
import { can, useMe } from '../App';
import { ActionButton, Badge, Card, Field, Form, Page, State } from '../ui';

const fmtBytes = (n: number) => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1).replace('.', ',')} ${u[i]}`;
};
const fmtDur = (s: number) => (s >= 86400 ? `${Math.floor(s / 86400)} d ` : '') + `${Math.floor((s % 86400) / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
const CAUSE: Record<string, string> = {
  'User-Request': 'Pedido do assinante', 'Lost-Carrier': 'Perda de portadora (link ou ONU)', 'Lost-Service': 'Perda de serviço', 'Idle-Timeout': 'Inatividade',
  'Session-Timeout': 'Fim do tempo da sessão', 'Admin-Reset': 'Reinício pelo administrador', 'Admin-Reboot': 'Reinício do equipamento', 'Port-Error': 'Erro de porta',
  'NAS-Error': 'Erro do concentrador', 'NAS-Request': 'Pedido do concentrador', 'NAS-Reboot': 'Reinício do concentrador', 'Service-Unavailable': 'Serviço indisponível',
};

// ---------------------------------------------------------------- busca
export function SearchBox() {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  return (
    <form className="find" role="search" onSubmit={(e) => { e.preventDefault(); if (q.trim().length >= 2) { nav(`/busca?q=${encodeURIComponent(q.trim())}`); setQ(''); } }}>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar cliente, login, IP, MAC, OS…" aria-label="Buscar cliente por nome, documento, login, IP, MAC, serial de ONU ou número de OS" />
    </form>
  );
}

export function Busca() {
  const [sp] = useSearchParams();
  const q = sp.get('q') ?? '';
  const { data, loading, error } = useLoad<any>(q.length >= 2 ? `/search?q=${encodeURIComponent(q)}` : null);
  return (
    <Page title="Busca" sub={q ? <>Resultados para “{q}”</> : undefined}>
      <State loading={loading} error={error} empty={data?.results.length === 0}>
        <table>
          <thead><tr><th>Cliente</th><th>Contrato</th><th>Acesso</th><th>Rede</th><th>Financeiro</th><th>Achado por</th></tr></thead>
          <tbody>{data?.results.map((r: any) => (
            <tr key={r.contract_id ?? r.subscriber_id}>
              <td><Link to={`/assinantes/${r.subscriber_id}`}>{r.subscriber_name}</Link><div className="small muted mono">{r.document ?? ''}</div></td>
              <td>{r.contract_id ? <Link to={`/contratos/${r.contract_id}`}>{r.plan_name ?? 'contrato'}</Link> : <span className="muted small">sem contrato</span>}
                {r.contract_status === 'ended' && <> <Badge>encerrado</Badge></>}</td>
              <td>{r.pppoe_username ? <span className="mono">{r.pppoe_username}</span> : <span className="muted">—</span>}
                {r.desired_policy === 'suspended' && <> <Badge tone="red">suspenso</Badge></>}</td>
              <td>{r.online === true ? <Badge tone="green">online</Badge> : r.online === false ? <Badge>offline</Badge> : <span className="muted">—</span>}
                {r.ip && <div className="small mono">{r.ip}</div>}</td>
              <td>{r.overdue == null ? <span className="muted small">—</span> : r.overdue > 0 ? <Badge tone="red">{r.overdue} vencida(s)</Badge> : <Badge tone="green">em dia</Badge>}</td>
              <td className="small">{[...new Set(r.matched)].join(', ')}</td>
            </tr>
          ))}</tbody>
        </table>
      </State>
    </Page>
  );
}

// ---------------------------------------------------------------- linha do tempo e contatos (ficha do assinante)
const KIND: Record<string, [string, 'blue' | 'green' | 'amber' | 'red' | undefined]> = {
  contract: ['Contrato', undefined], network: ['Rede', 'blue'], invoice: ['Fatura', 'amber'], payment: ['Pagamento', 'green'], work_order: ['OS', 'amber'], ticket: ['Atendimento', undefined],
};
export function Timeline({ subscriberId }: { subscriberId: string }) {
  const { data, loading, error } = useLoad<any[]>(`/subscribers/${subscriberId}/timeline`);
  return (
    <Card title="Linha do tempo">
      <State loading={loading && !data} error={error} empty={data?.length === 0}>
        <table><tbody>{data?.slice(0, 80).map((e, i) => {
          const [label, tone] = KIND[e.kind] ?? [e.kind, undefined];
          return (
            <tr key={i}><td className="small" style={{ whiteSpace: 'nowrap' }}>{dt(e.at)}</td><td><Badge tone={tone}>{label}</Badge></td>
              <td>{e.title}{e.detail && <div className="small muted">{e.detail}</div>}</td>
              <td className="small muted">{e.by ?? ''}{e.contract_id && <> · <Link to={`/contratos/${e.contract_id}`}>contrato</Link></>}</td></tr>
          );
        })}</tbody></table>
      </State>
    </Card>
  );
}

const CONTACT_KIND: Record<string, string> = { mobile: 'Celular', whatsapp: 'WhatsApp', landline: 'Telefone fixo', email: 'E-mail', responsible: 'Responsável' };
const PURPOSE: Record<string, string> = { general: 'Geral', billing: 'Cobrança', technical: 'Visita técnica' };
export function Contacts({ subscriberId }: { subscriberId: string }) {
  const { me } = useMe();
  const w = can(me, 'subscribers:write');
  const { data, loading, error, reload } = useLoad<any[]>(`/subscribers/${subscriberId}/contacts`);
  const [f, setF] = useState<any[] | null>(null);
  return (
    <Card title="Contatos" actions={w && !f && <button onClick={() => setF((data ?? []).map((c) => ({ ...c })))}>Editar contatos</button>}>
      {f ? (
        <Form submit="Salvar contatos" onCancel={() => setF(null)} onSubmit={async () => {
          await api(`/subscribers/${subscriberId}/contacts`, { method: 'PUT', body: { contacts: f.filter((c) => c.value.trim()).map((c) => ({ kind: c.kind, value: c.value, label: c.label || null, purpose: c.purpose, allow_notices: !!c.allow_notices })) } });
          setF(null); reload();
        }}>
          {f.map((c, i) => (
            <div key={i} className="row" style={{ flexWrap: 'wrap' }}>
              <select aria-label="Tipo" value={c.kind} onChange={(e) => setF(f.map((x, j) => (j === i ? { ...x, kind: e.target.value } : x)))}>
                {Object.entries(CONTACT_KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
              <input aria-label="Contato" style={{ flex: 1, minWidth: 180 }} value={c.value} onChange={(e) => setF(f.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
              <select aria-label="Finalidade" value={c.purpose} onChange={(e) => setF(f.map((x, j) => (j === i ? { ...x, purpose: e.target.value } : x)))}>
                {Object.entries(PURPOSE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
              <label className="row" style={{ gap: 4 }}><input type="checkbox" style={{ width: 'auto' }} checked={!!c.allow_notices}
                onChange={(e) => setF(f.map((x, j) => (j === i ? { ...x, allow_notices: e.target.checked } : x)))} /> aceita avisos</label>
              <button type="button" className="sm danger" onClick={() => setF(f.filter((_, j) => j !== i))}>Remover</button>
            </div>
          ))}
          <button type="button" onClick={() => setF([...f, { kind: 'mobile', value: '', purpose: 'general', allow_notices: false }])}>Adicionar contato</button>
          <p className="small muted">“Aceita avisos” registra o consentimento para mensagens de saída (cobrança, manutenção, OS). Sem ele, nenhum aviso é enviado a este contato.</p>
        </Form>
      ) : (
        <State loading={loading && !data} error={error} empty={data?.length === 0}>
          <table><tbody>{data?.map((c) => (
            <tr key={c.id}><td>{CONTACT_KIND[c.kind]}</td><td className="mono">{c.value}</td><td className="small">{PURPOSE[c.purpose]}</td>
              <td>{c.allow_notices ? <Badge tone="green">aceita avisos</Badge> : <span className="muted small">sem consentimento</span>}</td></tr>
          ))}</tbody></table>
        </State>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- sessões do contrato
export function Sessions({ contractId }: { contractId: string }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const qs = `${from ? `from=${from}` : ''}${from && to ? '&' : ''}${to ? `to=${to}` : ''}`;
  const { data, loading, error } = useLoad<any>(`/contracts/${contractId}/sessions${qs ? `?${qs}` : ''}`);
  if (!loading && data && data.rows.length === 0 && !qs) return null;
  const max = Math.max(1, ...(data?.daily ?? []).map((x: any) => x.bytes_in + x.bytes_out));
  return (
    <Card title="Sessões e consumo" actions={<ActionButton className="sm" onClick={() => download(`/contracts/${contractId}/sessions?format=csv${qs ? `&${qs}` : ''}`, 'sessoes.csv')}>Exportar CSV</ActionButton>}>
      <div className="row" style={{ marginBottom: 8 }}>
        <label className="row" style={{ gap: 4 }}>De <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="row" style={{ gap: 4 }}>até <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      <State loading={loading && !data} error={error} empty={data?.rows.length === 0}>
        {data && (<>
          <p className="small" style={{ marginTop: 0 }}>
            <b>{data.totals.sessions}</b> sessão(ões) · conectado <b>{fmtDur(data.totals.seconds)}</b> · download <b>{fmtBytes(data.totals.bytes_out)}</b> · upload <b>{fmtBytes(data.totals.bytes_in)}</b>
            {data.truncated && <span className="muted"> (mostrando as 1.000 mais recentes)</span>}
          </p>
          {data.daily.length > 1 && (
            <div role="img" aria-label="Consumo por dia" style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 70, marginBottom: 8, overflowX: 'auto' }}>
              {[...data.daily].reverse().slice(-60).map((x: any) => (
                <div key={x.day} title={`${x.day.split('-').reverse().join('/')}: ${fmtBytes(x.bytes_out)} baixados, ${fmtBytes(x.bytes_in)} enviados`}
                  style={{ width: 10, minHeight: 2, height: `${Math.max(3, ((x.bytes_in + x.bytes_out) / max) * 100)}%`, background: 'var(--blue, #3b82f6)', borderRadius: 2 }} />
              ))}
            </div>
          )}
          <div style={{ maxHeight: 360, overflow: 'auto' }}>
            <table>
              <thead><tr><th>Início</th><th>Fim</th><th>IP</th><th>MAC</th><th className="num">Tempo</th><th className="num">Down</th><th className="num">Up</th><th>Motivo do encerramento</th></tr></thead>
              <tbody>{data.rows.map((r: any) => (
                <tr key={r.session_key}><td className="small">{dt(r.started_at)}</td><td className="small">{r.stopped_at ? dt(r.stopped_at) : <Badge tone="green">em curso</Badge>}</td>
                  <td className="mono small">{r.ip ?? '—'}</td><td className="mono small">{r.mac ?? '—'}</td><td className="num small">{fmtDur(r.seconds)}</td>
                  <td className="num small">{fmtBytes(r.bytes_out)}</td><td className="num small">{fmtBytes(r.bytes_in)}</td>
                  <td className="small">{r.terminate_cause ? (CAUSE[r.terminate_cause] ?? r.terminate_cause) : r.stopped_at ? '—' : ''}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </>)}
      </State>
    </Card>
  );
}

// ---------------------------------------------------------------- online agora
export function Online() {
  const [q, setQ] = useState('');
  const { data, loading, error } = useLoad<any>(`/network/online${q ? `?q=${encodeURIComponent(q)}` : ''}`, 15000);
  return (
    <Page title="Online agora" actions={<>
      <input className="search" placeholder="Filtrar por nome, login ou IP…" value={q} onChange={(e) => setQ(e.target.value)} />
      <ActionButton onClick={() => download(`/network/online?format=csv${q ? `&q=${encodeURIComponent(q)}` : ''}`, 'usuarios-online.csv')}>Exportar CSV</ActionButton>
    </>}>
      <p className="muted small">Última leitura do concentrador pelo agente; não é tempo real. {data && <b>{data.total} online.</b>}</p>
      <State loading={loading && !data} error={error} empty={data?.rows.length === 0}>
        <table>
          <thead><tr><th>Cliente</th><th>Login</th><th>IP</th><th>MAC</th><th>Tempo</th><th>Concentrador</th><th>POP</th></tr></thead>
          <tbody>{data?.rows.map((r: any) => (
            <tr key={r.login}><td><Link to={`/contratos/${r.contract_id}`}>{r.subscriber_name}</Link>{r.desired_policy === 'suspended' && <> <Badge tone="red">suspenso</Badge></>}</td>
              <td className="mono">{r.login}</td><td className="mono">{r.ip}</td><td className="mono small">{r.mac ?? '—'}</td><td className="small">{r.uptime ?? '—'}</td><td>{r.nas}</td><td>{r.pop ?? '—'}</td></tr>
          ))}</tbody>
        </table>
      </State>
    </Page>
  );
}

// ---------------------------------------------------------------- POPs
export function Pops() {
  const { me } = useMe();
  const w = can(me, 'network:write');
  const { data, loading, error, reload } = useLoad<any[]>('/pops');
  const [f, setF] = useState<any>(null);
  return (
    <Page title="POPs" actions={w && <button className="primary" onClick={() => setF({ name: '', city: '', state: '' })}>Novo POP</button>}>
      {f && (
        <Card title="Novo POP">
          <Form submit="Salvar" onCancel={() => setF(null)} onSubmit={async () => { await api('/pops', { body: { name: f.name, city: f.city || null, state: f.state || null } }); setF(null); reload(); }}>
            <div className="cols3">
              <Field label="Nome"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required minLength={2} /></Field>
              <Field label="Cidade"><input value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} /></Field>
              <Field label="UF"><input value={f.state} maxLength={2} onChange={(e) => setF({ ...f, state: e.target.value })} /></Field>
            </div>
          </Form>
        </Card>
      )}
      <State loading={loading && !data} error={error} empty={data?.length === 0}>
        <table>
          <thead><tr><th>POP</th><th>Cidade</th><th className="num">Ativos</th><th className="num">Suspensos</th><th className="num">Encerrados</th><th>Situação</th><th></th></tr></thead>
          <tbody>{data?.map((p) => (
            <tr key={p.id}><td>{p.name}</td><td>{[p.city, p.state].filter(Boolean).join('/') || '—'}</td><td className="num">{p.active_contracts}</td><td className="num">{p.suspended_contracts}</td>
              <td className="num">{p.ended_contracts}</td><td>{p.active ? <Badge tone="green">ativo</Badge> : <Badge>inativo</Badge>}</td>
              <td>{w && <ActionButton className="sm" onClick={async () => { await api(`/pops/${p.id}`, { method: 'PATCH', body: { active: !p.active } }); reload(); }}>{p.active ? 'Desativar' : 'Ativar'}</ActionButton>}</td></tr>
          ))}</tbody>
        </table>
      </State>
    </Page>
  );
}

/** POP do contrato. */
export function ContractPop({ contract, onChange }: { contract: any; onChange: () => void }) {
  const { me } = useMe();
  const pops = useLoad<any[]>('/pops');
  const w = can(me, 'contracts:write') && contract.status === 'active';
  const cur = pops.data?.find((p) => p.id === contract.pop_id);
  return (
    <div className="row">
      {w ? (
        <select aria-label="POP do contrato" value={contract.pop_id ?? ''} onChange={async (e) => { await api(`/contracts/${contract.id}/pop`, { method: 'PUT', body: { pop_id: e.target.value || null } }); onChange(); }}>
          <option value="">Sem POP</option>
          {pops.data?.filter((p) => p.active || p.id === contract.pop_id).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      ) : <span>{cur?.name ?? 'Sem POP'}</span>}
    </div>
  );
}

/** Três situações separadas do contrato (comercial, acesso, velocidade): é o que o atendente precisa ver de relance. */
/** Três eixos separados (comercial × acesso × velocidade), com motivo, modo e confirmação do equipamento. */
export function ContractStates({ contract }: { contract: any }) {
  const { data } = useLoad<any>(`/contracts/${contract.id}/states`, 10000);
  if (!data) return <div className="row" style={{ gap: 6 }}><Badge>Carregando situação…</Badge></div>;
  const { commercial: cm, access: ac, speed: sp } = data;
  const MODE: Record<string, string> = { manual: 'manual', automatic: 'automático' };
  const com = cm.state === 'ended' ? <Badge>Contrato encerrado</Badge> : cm.state === 'credit_restricted' ? <Badge tone="amber">Contrato vigente · restrição de crédito</Badge> : <Badge tone="green">Contrato vigente</Badge>;
  const acc = ac.state === 'no_account' ? <Badge>Acesso não provisionado</Badge>
    : ac.state === 'blocked' ? <Badge tone="red">Acesso bloqueado{ac.mode ? ` (${MODE[ac.mode]})` : ''}</Badge> : <Badge tone="green">Acesso liberado</Badge>;
  return (
    <div>
      <div className="row" style={{ gap: 6 }}>
        {com}{acc}
        {ac.state !== 'no_account' && (sp.state === 'reduced' ? <Badge tone="amber">Velocidade reduzida{ac.cause === 'financial' ? ' por inadimplência' : ''}</Badge> : <Badge>Velocidade normal</Badge>)}
      </div>
      <div className="small muted" style={{ marginTop: 4 }}>
        {cm.state === 'ended' && <>Encerrado em {d(cm.end_date)}{cm.end_reason ? ` · motivo: ${cm.end_reason}` : ''}{cm.end_note ? ` · ${cm.end_note}` : ''}. </>}
        {cm.state === 'credit_restricted' && <>Restrição desde {dt(cm.credit_restricted_at)}. </>}
        {ac.since && ac.state !== 'no_account' && (ac.state === 'blocked' || sp.state === 'reduced') && cm.state !== 'ended' &&
          <>Desde {dt(ac.since)}{ac.reason ? ` · ${ac.reason}` : ''}{ac.applied === false ? ' · aguardando confirmação do equipamento' : ''}.</>}
      </div>
    </div>
  );
}
/** Anotações estruturadas: as com alerta aparecem em destaque ao abrir a ficha. */
export function SubscriberNotes({ subscriberId }: { subscriberId: string }) {
  const { me } = useMe();
  const w = can(me, 'subscribers:write');
  const notes = useLoad<any[]>(`/subscribers/${subscriberId}/notes`);
  const types = useLoad<any[]>(w ? '/catalogs?kind=note_type' : null);
  const [f, setF] = useState({ body: '', alert: false, type_id: '' });
  const alerts = notes.data?.filter((n) => n.alert) ?? [];
  return (<>
    {alerts.length > 0 && (
      <div className="state" style={{ textAlign: 'left', borderColor: 'var(--amber, #b7791f)' }} role="alert">
        <b>Atenção:</b> {alerts.map((n) => n.body).join(' · ')}
      </div>
    )}
    <Card title="Anotações">
      {w && (
        <div className="row" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
          <input aria-label="Anotação" style={{ flex: 1, minWidth: 220 }} placeholder="Nova anotação…" value={f.body} maxLength={2000} onChange={(e) => setF({ ...f, body: e.target.value })} />
          {types.data && types.data.length > 0 && <select aria-label="Tipo" style={{ width: 160 }} value={f.type_id} onChange={(e) => setF({ ...f, type_id: e.target.value })}><option value="">Sem tipo</option>{types.data.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>}
          <label className="row small"><input type="checkbox" style={{ width: 'auto' }} checked={f.alert} onChange={(e) => setF({ ...f, alert: e.target.checked })} /> alertar ao abrir</label>
          <ActionButton className="primary" disabled={!f.body.trim()} onClick={async () => { await api(`/subscribers/${subscriberId}/notes`, { body: { body: f.body, alert: f.alert, type_id: f.type_id || null } }); setF({ body: '', alert: false, type_id: '' }); notes.reload(); }}>Anotar</ActionButton>
        </div>
      )}
      <State empty={notes.data?.length === 0} emptyText="Sem anotações.">
        <table><tbody>{notes.data?.map((n) => (
          <tr key={n.id}><td style={{ whiteSpace: 'pre-wrap' }}>{n.alert && <Badge tone="amber">alerta</Badge>} {n.type_name && <Badge>{n.type_name}</Badge>} {n.body}
            <div className="small muted">{dt(n.created_at)} · {n.created_by_name ?? 'sistema'}</div></td>
            <td>{w && <ActionButton className="sm" onClick={async () => { await api(`/notes/${n.id}`, { method: 'PATCH', body: { archived: true } }); notes.reload(); }}>Arquivar</ActionButton>}</td></tr>
        ))}</tbody></table>
      </State>
    </Card>
  </>);
}
export { money, d };
