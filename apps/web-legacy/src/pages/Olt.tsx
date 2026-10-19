import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ago, api, dt, useLoad } from '../api';
import { can, useMe } from '../App';
import { ActionButton, Badge, Card, Field, Form, Modal, Page, State } from '../ui';
import { OpBadge, OperationModal, SimBadge } from './Service';

export const ONU_ACTION: Record<string, string> = { 'onu.authorize': 'Autorizar ONU', 'onu.deauthorize': 'Desautorizar ONU' };
const dbm = (v: any) => (v == null ? '—' : `${Number(v).toFixed(2)} dBm`);

function OnuStateBadge({ n }: { n: any }) {
  if (!n.observed_at) return <Badge>ainda não lida</Badge>;
  if (n.observed_state !== 'authorized') return <Badge>Não autorizada na OLT</Badge>;
  return n.observed_online ? <Badge tone="green">Online</Badge> : <Badge tone="red">Offline</Badge>;
}

/** Formulário de autorização: OLT + ONU descoberta (ou serial digitado) + perfil de linha + VLAN. */
export function AuthorizeForm({ contractId, discovery, onDone, onCancel }: { contractId?: string; discovery?: any; onDone: () => void; onCancel?: () => void }) {
  const devices = useLoad<any[]>('/devices');
  const found = useLoad<any[]>('/olt/discoveries');
  const [q, setQ] = useState('');
  const contracts = useLoad<any[]>(!contractId && q.length >= 2 ? `/contracts?status=active&limit=20&q=${encodeURIComponent(q)}` : null);
  const [f, setF] = useState<any>({ contract_id: contractId ?? '', device_id: discovery?.device_id ?? '', serial: discovery?.serial ?? '', pon_port: discovery?.pon_port ?? '',
    line_profile: localStorage.getItem('nexo_onu_profile') ?? '', service_profile: localStorage.getItem('nexo_onu_srv') ?? '', service_vlan: localStorage.getItem('nexo_onu_vlan') ?? '' });
  const huawei = devices.data?.find((d) => d.id === f.device_id)?.driver === 'olt_huawei';
  const olts = devices.data?.filter((d) => d.driver.startsWith('olt')) ?? [];
  const pending = found.data?.filter((x) => !f.device_id || x.device_id === f.device_id) ?? [];
  return (
    <Form submit="Autorizar ONU" onCancel={onCancel} onSubmit={async () => {
      if (!f.contract_id) throw new Error('Selecione o contrato');
      await api(`/contracts/${f.contract_id}/onu`, { body: { device_id: f.device_id, serial: f.serial, pon_port: f.pon_port, line_profile: f.line_profile, service_profile: f.service_profile || null, service_vlan: Number(f.service_vlan) } });
      localStorage.setItem('nexo_onu_srv', f.service_profile);
      localStorage.setItem('nexo_onu_profile', f.line_profile); localStorage.setItem('nexo_onu_vlan', String(f.service_vlan)); // conveniência: repete os últimos valores
      onDone();
    }}>
      {!contractId && (<>
        <Field label="Contrato (busque pelo assinante)"><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="nome do assinante…" autoFocus /></Field>
        {contracts.data && (
          <Field label="Selecione">
            <select value={f.contract_id} onChange={(e) => setF({ ...f, contract_id: e.target.value })} required>
              <option value="">{contracts.data.length ? 'Selecione…' : 'nenhum contrato vigente encontrado'}</option>
              {contracts.data.map((k) => <option key={k.id} value={k.id}>{k.subscriber_name} — {k.plan_name}</option>)}
            </select>
          </Field>
        )}
      </>)}
      <State loading={devices.loading} error={devices.error}>
        {olts.length === 0 && <div className="state">Cadastre uma OLT em Rede → Agentes e equipamentos.</div>}
        <div className="cols">
          <Field label="OLT">
            <select value={f.device_id} onChange={(e) => setF({ ...f, device_id: e.target.value })} required disabled={!!discovery}>
              <option value="">Selecione…</option>
              {olts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </Field>
          {!discovery && (
            <Field label="ONU aguardando autorização">
              <select value="" onChange={(e) => { const x = pending.find((p) => String(p.id) === e.target.value); if (x) setF({ ...f, device_id: x.device_id, serial: x.serial, pon_port: x.pon_port }); }}>
                <option value="">{pending.length ? `${pending.length} encontrada(s) — escolher…` : 'nenhuma no momento'}</option>
                {pending.map((x) => <option key={x.id} value={x.id}>{x.serial} · PON {x.pon_port}{x.model ? ` · ${x.model}` : ''}</option>)}
              </select>
            </Field>
          )}
        </div>
        <div className="cols">
          <Field label="Serial da ONU"><input className="mono" value={f.serial} onChange={(e) => setF({ ...f, serial: e.target.value })} required readOnly={!!discovery} /></Field>
          <Field label="Porta PON" hint="Ex.: 0/1/3"><input className="mono" value={f.pon_port} onChange={(e) => setF({ ...f, pon_port: e.target.value })} required readOnly={!!discovery} /></Field>
        </div>
        {huawei && <div className="state err">Driver Huawei ainda não homologado em equipamento real: valide em laboratório antes de usar numa OLT em produção.</div>}
        <div className="cols3">
          <Field label="Perfil de linha" hint="Nome do perfil já existente na OLT."><input value={f.line_profile} onChange={(e) => setF({ ...f, line_profile: e.target.value })} required /></Field>
          <Field label="Perfil de serviço" hint={huawei ? 'Obrigatório na Huawei (ont-srvprofile).' : 'Se a OLT usar.'}><input value={f.service_profile} onChange={(e) => setF({ ...f, service_profile: e.target.value })} required={huawei} /></Field>
          <Field label="VLAN de serviço"><input type="number" min="1" max="4094" value={f.service_vlan} onChange={(e) => setF({ ...f, service_vlan: e.target.value })} required /></Field>
        </div>
      </State>
    </Form>
  );
}

/** ONU do contrato: intenção, estado lido na OLT, sinal e operações com evidência. */
export function OnuPanel({ contract }: { contract: any }) {
  const { me } = useMe();
  const { data, loading, error, reload } = useLoad<any>(can(me, 'network:read') ? `/contracts/${contract.id}/onu` : null, 3000);
  const [opId, setOpId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  if (!can(me, 'network:read')) return null;
  const operate = can(me, 'network:operate');
  const n = data?.onu;
  const removed = n && n.desired_state === 'removed' && n.observed_state === 'absent' && n.observed_version === n.desired_version;
  const sim = n?.driver === 'olt_demo';
  const act = (a: string, reason?: string) => async () => { await api(`/onus/${n.id}/${a}`, { body: { reason } }); await reload(); };
  return (
    <Card tone={sim ? 'demo' : ''} title={<>ONU (fibra) {sim && <SimBadge />}</>} actions={operate && (<>
      {n && n.desired_state === 'authorized' && <ActionButton className="danger" confirm="Desautorizar esta ONU na OLT? O assinante ficará sem sinal de dados." onClick={act('deauthorize')}>Desautorizar</ActionButton>}
      {n && n.desired_state === 'authorized' && <ActionButton disabled={contract.status !== 'active'} title="Reenvia a configuração atual" onClick={act('authorize', 'reaplicar autorização')}>Reaplicar</ActionButton>}
      {(!n || removed) && contract.status === 'active' && <button className="primary" onClick={() => setAdding(true)}>{removed ? 'Vincular outra ONU' : 'Autorizar ONU'}</button>}
    </>)}>
      <State loading={loading && !data} error={error}>
        {data && !n && <div className="state">Nenhuma ONU vinculada a este contrato.</div>}
        {n && (<>
          {sim && <p className="small muted" style={{ marginTop: 0 }}>OLT de demonstração: nenhum equipamento real é alterado e o sinal exibido é fictício.</p>}
          {n.driver === 'olt_huawei' && <p className="small muted" style={{ marginTop: 0 }}><Badge tone="red">não homologado</Badge> Driver Huawei validado apenas contra um emulador de CLI.</p>}
          {n.drift && <div className="state err">Divergência: o estado lido na OLT difere da intenção e não há operação em andamento (possível alteração manual na OLT). Nada foi corrigido automaticamente.</div>}
          {!n.agent_online && <div className="state err">Agente {n.agent_name ? `“${n.agent_name}” ` : ''}offline: operações aguardam e a leitura de sinal fica desatualizada.</div>}
          {contract.status !== 'active' && n.desired_state === 'authorized' && <div className="state err">Contrato encerrado com ONU ainda autorizada. A remoção na OLT não é automática: use “Desautorizar” se for o caso.</div>}
          <div className="five" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
            <Card title="Equipamento"><span className="mono">{n.serial}</span><div className="small muted">{n.device_name} · PON {n.pon_port}</div></Card>
            <Card title="Desejada">
              {n.desired_state === 'authorized' ? <Badge tone="green">Autorizada</Badge> : <Badge>Removida</Badge>}
              <div className="small">perfil <span className="mono">{n.line_profile}</span>{n.service_profile && <> / <span className="mono">{n.service_profile}</span></>} · VLAN {n.service_vlan}</div>
              <div className="small muted">versão {n.desired_version} · {dt(n.desired_at)}</div>
            </Card>
            <Card title="Observada na OLT">
              <OnuStateBadge n={n} />
              {n.observed_at && <div className="small muted">lida {ago(n.observed_at)}</div>}
            </Card>
            <Card title="Sinal óptico">
              <div className="small">recebido (RX) <b>{dbm(n.observed_rx_dbm)}</b></div>
              <div className="small">transmitido (TX) <b>{dbm(n.observed_tx_dbm)}</b></div>
            </Card>
          </div>
          <table style={{ marginTop: 10 }}>
            <thead><tr><th>Solicitada</th><th>Ação</th><th>Versão</th><th>Situação</th><th>Motivo / nota</th><th>Por</th><th></th></tr></thead>
            <tbody>{data.operations.map((o: any) => (
              <tr key={o.id}><td>{dt(o.created_at)}</td><td>{ONU_ACTION[o.action]}</td><td>v{o.desired_version}</td><td><OpBadge status={o.status} /></td>
                <td className="small">{o.reason}{o.note && <span className="muted"> — {o.note}</span>}</td><td className="small">{o.requested_by ?? '—'}</td>
                <td><button className="sm" onClick={() => setOpId(o.id)}>evidências</button></td></tr>
            ))}</tbody>
          </table>
        </>)}
      </State>
      {adding && <Modal title={removed ? 'Vincular outra ONU ao contrato' : 'Autorizar ONU'} onClose={() => setAdding(false)}>
        <AuthorizeForm contractId={contract.id} onCancel={() => setAdding(false)} onDone={() => { setAdding(false); reload(); }} /></Modal>}
      {opId && <OperationModal id={opId} onClose={() => setOpId(null)} />}
    </Card>
  );
}

export function Onus() {
  const { me } = useMe();
  const found = useLoad<any[]>('/olt/discoveries', 5000);
  const onus = useLoad<any[]>('/onus', 5000);
  const [auth, setAuth] = useState<any>(null);
  const operate = can(me, 'network:operate');
  return (
    <Page title="ONUs" actions={operate && <button onClick={() => setAuth({})}>Autorizar por serial</button>}>
      <Card title="Aguardando autorização">
        <p className="small muted" style={{ marginTop: 0 }}>ONUs que as OLTs enxergam na fibra e que ainda não foram autorizadas. A lista vem do agente a cada ciclo de leitura.</p>
        <State loading={found.loading} error={found.error} empty={found.data?.length === 0}>
          <table>
            <thead><tr><th>Serial</th><th>OLT</th><th>Porta PON</th><th>Fabricante / modelo</th><th>Vista pela primeira vez</th><th>Última leitura</th><th></th></tr></thead>
            <tbody>{found.data?.map((x) => (
              <tr key={x.id}>
                <td className="mono">{x.serial}</td><td>{x.device_name} {x.driver === 'olt_demo' && <SimBadge />}</td><td className="mono">{x.pon_port}</td>
                <td className="small">{[x.vendor, x.model].filter(Boolean).join(' · ') || '—'}</td><td>{dt(x.first_seen_at)}</td><td>{ago(x.last_seen_at)}</td>
                <td>{operate && <button className="sm primary" onClick={() => setAuth({ discovery: x })}>Autorizar</button>}</td>
              </tr>
            ))}</tbody>
          </table>
        </State>
      </Card>
      <Card title="ONUs vinculadas a contratos">
        <State loading={onus.loading} error={onus.error} empty={onus.data?.length === 0}>
          <table>
            <thead><tr><th>Assinante</th><th>Serial</th><th>OLT / PON</th><th>Perfil · VLAN</th><th>Intenção</th><th>Estado na OLT</th><th className="num">RX</th><th className="num">TX</th><th>Lida</th></tr></thead>
            <tbody>{onus.data?.map((n) => (
              <tr key={n.id}>
                <td><Link to={`/contratos/${n.contract_id}`}>{n.subscriber_name}</Link></td><td className="mono">{n.serial}</td>
                <td className="small">{n.device_name} · {n.pon_port}</td><td className="small">{n.line_profile} · {n.service_vlan}</td>
                <td>{n.desired_state === 'authorized' ? <Badge tone="green">Autorizada</Badge> : <Badge>Removida</Badge>} {n.drift && <Badge tone="amber">divergência</Badge>}</td>
                <td><OnuStateBadge n={n} /></td><td className="num">{dbm(n.observed_rx_dbm)}</td><td className="num">{dbm(n.observed_tx_dbm)}</td><td className="small">{n.observed_at ? ago(n.observed_at) : '—'}</td>
              </tr>
            ))}</tbody>
          </table>
        </State>
      </Card>
      {auth && <Modal title="Autorizar ONU" onClose={() => setAuth(null)}>
        <AuthorizeForm discovery={auth.discovery} onCancel={() => setAuth(null)} onDone={() => { setAuth(null); found.reload(); onus.reload(); }} /></Modal>}
    </Page>
  );
}
