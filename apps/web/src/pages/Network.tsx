import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ago, api, dt, useLoad, usePaged } from '../api';
import { can, useMe } from '../App';
import { ActionButton, Badge, Card, Field, Form, Modal, Page, Pager, State } from '../ui';
import { ACTION, OpBadge, OperationModal, SimBadge } from './Service';

export function HealthCards() {
  const { data: h } = useLoad<any>('/network/health', 5000);
  if (!h) return null;
  const item = (n: number, label: string, bad: boolean, to?: string) => (
    <Card><div className="stat"><b style={{ color: bad ? 'var(--red)' : undefined }}>{n}</b><span>{label}</span></div>{to && <Link to={to}>ver</Link>}</Card>
  );
  return (
    <div className="grid">
      {item(h.agents_offline, `agente(s) offline de ${h.agents}`, h.agents_offline > 0, '/rede')}
      {item(h.uncertain, 'operação(ões) incerta(s)', h.uncertain > 0, '/operacoes?filter=problem')}
      {item(h.failed_recent, 'falhas/expirações em 7 dias', h.failed_recent > 0, '/operacoes?filter=problem')}
      {item(h.drift, 'divergência(s) de estado', h.drift > 0, '/operacoes?filter=problem')}
      <Card><div className="stat"><b>{h.in_progress}</b><span>em andamento{h.oldest_pending_s != null && ` · fila mais antiga há ${h.oldest_pending_s}s`}</span></div></Card>
    </div>
  );
}

export function Network() {
  const { me } = useMe();
  const w = can(me, 'network:write');
  const agents = useLoad<any[]>('/agents', 5000);
  const devices = useLoad<any[]>('/devices', 5000);
  const [modal, setModal] = useState<'agent' | 'device' | null>(null);
  const [cred, setCred] = useState<any>(null);
  const [name, setName] = useState('');
  const blank = { name: '', driver: me.demo ? 'demo' : 'mikrotik_radius', host: '', api_port: '', credential_ref: '', agent_id: '' };
  const [f, setF] = useState<any>(blank);
  return (
    <Page title="Rede">
      <HealthCards />
      <Card title="Agentes locais" actions={w && <button className="primary" onClick={() => { setName(''); setModal('agent'); }}>Novo agente</button>}>
        <State loading={agents.loading} error={agents.error} empty={agents.data?.length === 0}>
          <table>
            <thead><tr><th>Agente</th><th>Conexão</th><th>Último contato</th><th>Última sincronização</th><th>Versão</th><th className="num">Equip.</th><th className="num">Fila</th><th></th></tr></thead>
            <tbody>{agents.data?.map((a) => (
              <tr key={a.id}>
                <td>{a.name}<div className="small muted mono">{a.id}</div>
                  <div className="small muted">{a.cert_fingerprint ? <>certificado fixado <span className="mono">{a.cert_fingerprint.slice(0, 17)}…</span></> : 'certificado ainda não apresentado'}</div></td>
                <td>{a.status === 'revoked' ? <Badge tone="red">Revogado</Badge> : a.online ? <Badge tone="green">Online</Badge> : <Badge tone="red">Offline</Badge>}</td>
                <td>{ago(a.last_seen_at)}</td>
                <td>{a.last_sync_at ? <>{ago(a.last_sync_at)}<div className="small muted">{dt(a.last_sync_at)}</div></> : 'nunca'}</td>
                <td className="mono">{a.version ?? '—'}</td>
                <td className="num">{a.devices}</td>
                <td className="num">{a.open_operations}{a.oldest_pending && <div className="small muted">desde {ago(a.oldest_pending)}</div>}</td>
                <td>{w && <div className="row" style={{ justifyContent: 'flex-end' }}>
                  <ActionButton className="sm" confirm="Gerar novo token? O token atual deixa de funcionar imediatamente."
                    onClick={async () => setCred(await api(`/agents/${a.id}`, { method: 'PATCH', body: { rotate_token: true } }))}>Rotacionar token</ActionButton>
                  {a.cert_fingerprint && <ActionButton className="sm" confirm="Descartar o certificado fixado? O próximo certificado válido apresentado por este agente passará a ser o único aceito. Use ao trocar o certificado."
                    onClick={async () => { await api(`/agents/${a.id}`, { method: 'PATCH', body: { reset_certificate: true } }); agents.reload(); }}>Aceitar novo certificado</ActionButton>}
                  <ActionButton className="sm danger" confirm={a.status === 'active' ? 'Revogar este agente? Ele deixará de receber operações.' : undefined}
                    onClick={async () => { await api(`/agents/${a.id}`, { method: 'PATCH', body: { status: a.status === 'active' ? 'revoked' : 'active' } }); agents.reload(); }}>
                    {a.status === 'active' ? 'Revogar' : 'Reativar'}</ActionButton>
                </div>}</td>
              </tr>
            ))}</tbody>
          </table>
        </State>
      </Card>
      <Card title="Equipamentos (NAS)" actions={w && <button className="primary" onClick={() => { setF(blank); setModal('device'); }}>Novo equipamento</button>}>
        <State loading={devices.loading} error={devices.error} empty={devices.data?.length === 0}>
          <table>
            <thead><tr><th>Equipamento</th><th>Integração</th><th>Endereço</th><th>Agente</th><th>Conectividade</th><th className="num">Contas / ONUs</th><th></th></tr></thead>
            <tbody>{devices.data?.map((d) => (
              <tr key={d.id}>
                <td>{d.name} {d.maintenance && <Badge tone="amber">manutenção</Badge>}</td>
                <td>{d.driver === 'demo' ? <>Concentrador PPPoE <SimBadge /></> : d.driver === 'olt_demo' ? <>OLT <SimBadge /></> : d.driver === 'olt_huawei' ? <>OLT Huawei SmartAX <Badge tone="red">não homologado em equipamento real</Badge></> : <>MikroTik + RADIUS <Badge tone="blue">validado em laboratório (CHR 7.24.5)</Badge></>}</td>
                <td className="mono">{d.host ?? '—'}{d.api_port ? `:${d.api_port}` : ''}{d.credential_ref && <div className="small muted">credencial: {d.credential_ref}</div>}</td>
                <td>{d.agent_name ?? <span className="muted">sem agente</span>} {d.agent_name && (d.agent_online ? <Badge tone="green">online</Badge> : <Badge tone="red">offline</Badge>)}</td>
                <td>{d.last_check ? <>{d.last_check.ok ? <Badge tone="green">ok</Badge> : <Badge tone="red">falha</Badge>} <span className="small muted">{ago(d.last_check_at)}</span><div className="small muted">{d.last_check.detail}</div></> : <span className="muted">não verificado</span>}</td>
                <td className="num">{d.driver.startsWith('olt') ? d.onus : d.accounts}</td>
                <td>{w && <div className="row" style={{ justifyContent: 'flex-end' }}>
                  {d.accounts > 0 && <ActionButton className="sm" confirm={`Reenviar ao equipamento a intenção atual de todas as contas (${d.accounts})? Use após reinstalar o site ou perder o RADIUS local.`}
                    onClick={async () => { const r = await api(`/devices/${d.id}/reapply`, { method: 'POST' }); alert(`${r.requested} operação(ões) solicitada(s).`); }}>Reaplicar todas as contas</ActionButton>}
                  <ActionButton className="sm" confirm={d.maintenance ? undefined : 'Em manutenção o ERP para de enviar escritas a este equipamento. Continuar?'}
                  onClick={async () => { await api(`/devices/${d.id}`, { method: 'PATCH', body: { maintenance: !d.maintenance } }); devices.reload(); }}>
                  {d.maintenance ? 'Encerrar manutenção' : 'Modo manutenção'}</ActionButton></div>}</td>
              </tr>
            ))}</tbody>
          </table>
        </State>
      </Card>
      {modal === 'agent' && (
        <Modal title="Novo agente" onClose={() => setModal(null)}>
          <Form submit="Criar agente" onCancel={() => setModal(null)} onSubmit={async () => { setCred(await api('/agents', { body: { name } })); setModal(null); agents.reload(); }}>
            <Field label="Nome do agente" hint="Ex.: nome do site ou do servidor onde será instalado."><input value={name} onChange={(e) => setName(e.target.value)} required autoFocus /></Field>
          </Form>
        </Modal>
      )}
      {modal === 'device' && (
        <Modal title="Novo equipamento" onClose={() => setModal(null)}>
          <Form onCancel={() => setModal(null)} onSubmit={async () => {
            await api('/devices', { body: { ...f, api_port: f.api_port ? Number(f.api_port) : null, agent_id: f.agent_id || null } });
            setModal(null); devices.reload();
          }}>
            <Field label="Nome"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required autoFocus /></Field>
            <Field label="Integração">
              <select value={f.driver} onChange={(e) => setF({ ...f, driver: e.target.value })}>
                <option value="mikrotik_radius">MikroTik RouterOS v7 + RADIUS local</option>
                <option value="olt_huawei">OLT Huawei SmartAX MA5600/MA5800 (CLI por SSH) — não homologado</option>
                {me.demo && <option value="demo">Concentrador PPPoE — demonstração (simulado)</option>}
                {me.demo && <option value="olt_demo">OLT — demonstração (simulada)</option>}
              </select>
            </Field>
            {!f.driver.endsWith('demo') && (<>
              <div className="cols">
                <Field label="Endereço (IP/host)"><input value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} required /></Field>
                <Field label={f.driver === 'olt_huawei' ? 'Porta SSH' : 'Porta da API'} hint={f.driver === 'olt_huawei' ? 'Padrão: 22' : 'Padrão api-ssl: 8729'}><input type="number" value={f.api_port} onChange={(e) => setF({ ...f, api_port: e.target.value })} placeholder={f.driver === 'olt_huawei' ? '22' : '8729'} /></Field>
              </div>
              <Field label="Referência da credencial" hint="Nome da credencial guardada no arquivo local do agente. A senha do equipamento não é enviada à nuvem.">
                <input value={f.credential_ref} onChange={(e) => setF({ ...f, credential_ref: e.target.value })} required />
              </Field>
            </>)}
            <Field label="Agente responsável">
              <select value={f.agent_id} onChange={(e) => setF({ ...f, agent_id: e.target.value })} required>
                <option value="">Selecione…</option>
                {agents.data?.filter((a) => a.status === 'active').map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </Field>
          </Form>
        </Modal>
      )}
      {cred && (
        <Modal title="Credenciais do agente" onClose={() => { setCred(null); agents.reload(); }} wide>
          <p>Guarde o token agora: ele <b>não será exibido novamente</b>. Configure no agente junto do certificado de cliente individual.</p>
          <pre className="ev">{`NEXO_AGENT_ID=${cred.id}\nNEXO_AGENT_TOKEN=${cred.token}\n# certificado de cliente: CN=agent:${cred.id}`}</pre>
          <p className="small muted">Em desenvolvimento, gere o certificado com <span className="mono">./nexo agent-cert {cred.id}</span>.</p>
        </Modal>
      )}
    </Page>
  );
}

export function Operations() {
  const initial = new URLSearchParams(window.location.search).get('filter') ?? 'all';
  const [filter, setFilter] = useState(initial);
  const list = usePaged<any>(`/operations?filter=${filter}`, 3000);
  const { data, loading, error } = list;
  const drift = useLoad<any[]>('/network/drift', 10000);
  const [opId, setOpId] = useState<string | null>(null);
  return (
    <Page title="Operações de rede" actions={
      <select style={{ width: 220 }} value={filter} onChange={(e) => setFilter(e.target.value)}>
        <option value="all">Todas</option><option value="open">Em andamento</option><option value="problem">Com problema ou atrasadas</option>
      </select>}>
      {!!drift.data?.length && (
        <Card title="Divergências entre intenção e estado observado">
          <table>
            <thead><tr><th>Assinante</th><th>Usuário PPPoE</th><th>Desejado</th><th>Observado</th><th>Lido</th><th></th></tr></thead>
            <tbody>{drift.data.map((r) => (
              <tr key={r.id}><td>{r.subscriber_name}</td><td className="mono">{r.pppoe_username}</td><td>{r.desired_policy} / {r.desired_profile}</td>
                <td>{r.observed_policy} / {r.observed_profile ?? '—'}</td><td>{ago(r.observed_at)}</td><td><Link to={`/contratos/${r.contract_id}`}>abrir contrato</Link></td></tr>
            ))}</tbody>
          </table>
        </Card>
      )}
      <State loading={loading && !data} error={error} empty={data?.length === 0}>
        <table>
          <thead><tr><th>Solicitada</th><th>Assinante</th><th>Usuário PPPoE</th><th>Ação</th><th>Situação</th><th>Tent.</th><th>Equipamento</th><th>Nota</th><th></th></tr></thead>
          <tbody>{data?.map((o) => (
            <tr key={o.id}>
              <td style={{ whiteSpace: 'nowrap' }}>{dt(o.created_at)}</td>
              <td><Link to={`/contratos/${o.contract_id}`}>{o.subscriber_name}</Link></td>
              <td className="mono">{o.pppoe_username}</td><td>{ACTION[o.action]} <span className="muted small">v{o.desired_version}</span></td>
              <td><OpBadge status={o.status} /></td><td>{o.attempts}</td><td>{o.device_name}</td>
              <td className="small muted">{o.note ?? o.reason}</td>
              <td><button className="sm" onClick={() => setOpId(o.id)}>evidências</button></td>
            </tr>
          ))}</tbody>
        </table>
        <Pager p={list} />
      </State>
      {opId && <OperationModal id={opId} onClose={() => setOpId(null)} />}
    </Page>
  );
}
