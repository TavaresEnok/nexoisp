import { useState } from 'react';
import { api, dt, useLoad } from '../api';
import { can, useMe } from '../App';
import { ActionButton, Badge, Card, Field, Form, KV, State, toast } from '../ui';

const fmtUp = (s: number | null) => (s == null ? '—' : s >= 86400 ? `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`);
const recent = (iso: string | null) => !!iso && Date.now() - new Date(iso).getTime() < 15 * 60_000;

/** Roteador do cliente pelo TR-069: estado, Wi-Fi, reiniciar e reler. */
export function ContractCpe({ contractId }: { contractId: string }) {
  const { me } = useMe();
  const st = useLoad<any>(`/contracts/${contractId}/cpe`);
  const op = can(me, 'network:operate');
  const [serial, setSerial] = useState('');
  const [cands, setCands] = useState<any[] | null>(null);
  const [wifi, setWifi] = useState<{ index: string; ssid: string; password: string } | null>(null);
  if (!st.data?.enabled) return null;
  const d = st.data.device;
  const done = (r: any) => toast(r.note);
  return (
    <Card title="Roteador do cliente (TR-069)" actions={st.data.linked && op && <div className="row">
      <ActionButton className="sm" onClick={async () => { done(await api(`/contracts/${contractId}/cpe/refresh`, { method: 'POST' })); st.reload(); }}>Reler</ActionButton>
      <ActionButton className="sm" confirm="Reiniciar o roteador do cliente? A conexão dele cai por alguns minutos." onClick={async () => done(await api(`/contracts/${contractId}/cpe/reboot`, { method: 'POST' }))}>Reiniciar</ActionButton>
      <ActionButton className="sm danger" confirm="Desvincular este roteador do contrato?" onClick={async () => { await api(`/contracts/${contractId}/cpe/link`, { method: 'DELETE' }); st.reload(); }}>Desvincular</ActionButton></div>}>
      <State loading={st.loading} error={st.error}>
        {!st.data.linked && (op ? (<>
          <p className="small muted" style={{ marginTop: 0 }}>Procure o roteador que informa a conta PPPoE deste contrato ou digite o número de série da etiqueta.</p>
          <div className="row"><input placeholder="Número de série (opcional)" value={serial} onChange={(e) => setSerial(e.target.value)} />
            <ActionButton className="sm" onClick={async () => setCands(await api(`/contracts/${contractId}/cpe/candidates${serial ? `?serial=${encodeURIComponent(serial)}` : ''}`))}>Procurar</ActionButton></div>
          {cands && (cands.length === 0 ? <div className="state small">Nenhum roteador encontrado. Ele precisa ter contatado o servidor de gerência (endereço configurado nele).</div>
            : cands.map((c) => <div key={c.id} className="row" style={{ marginTop: 6, justifyContent: 'space-between' }}>
              <span className="small">{c.manufacturer} {c.product} · série <span className="mono">{c.serial}</span> · {c.matched_by === 'pppoe' ? 'informa a conta deste contrato' : 'número de série'} · visto {dt(c.last_inform)}</span>
              <ActionButton className="sm primary" onClick={async () => { await api(`/contracts/${contractId}/cpe/link`, { body: { acs_device_id: c.id, serial: serial || undefined } }); setCands(null); st.reload(); }}>Vincular</ActionButton></div>))}
        </>) : <span className="muted small">Nenhum roteador vinculado.</span>)}
        {st.data.linked && !d && <div className="state err">O roteador vinculado não está mais no servidor de gerência.</div>}
        {d && (<>
          <KV items={[['Roteador', `${d.manufacturer ?? ''} ${d.product ?? ''}`], ['Série', <span className="mono">{d.serial}</span>], ['Firmware', d.firmware ?? '—'],
            ['Último contato', <>{dt(d.last_inform)} {recent(d.last_inform) ? <Badge tone="green">recente</Badge> : <Badge tone="amber">há mais de 15 min</Badge>}</>],
            ['Ligado há', fmtUp(d.uptime_s)], ['WAN', d.wan.ip ? `${d.wan.ip} (${d.wan.status ?? '?'})` : '—'], ['Conta PPPoE no roteador', d.ppp_usernames.join(', ') || '—']]} />
          <table style={{ marginTop: 8 }}><tbody>{d.wifi.map((w: any) => (
            <tr key={w.index}><td>Wi-Fi {w.index}</td><td><b>{w.ssid ?? '—'}</b> {w.enabled === false && <Badge>desligada</Badge>}</td>
              <td className="actions">{op && <button className="sm" onClick={() => setWifi({ index: w.index, ssid: w.ssid ?? '', password: '' })}>Alterar</button>}</td></tr>))}</tbody></table>
        </>)}
        {wifi && (
          <Form submit="Aplicar no roteador" onCancel={() => setWifi(null)} onSubmit={async () => {
            done(await api(`/contracts/${contractId}/cpe/wifi`, { body: { index: wifi.index, ssid: wifi.ssid || undefined, password: wifi.password || undefined } })); setWifi(null); st.reload();
          }}>
            <div className="cols2">
              <Field label="Nome da rede"><input value={wifi.ssid} maxLength={32} onChange={(e) => setWifi({ ...wifi, ssid: e.target.value })} /></Field>
              <Field label="Nova senha" hint="Em branco: mantém a atual. 8 a 63 caracteres."><input value={wifi.password} minLength={8} maxLength={63} onChange={(e) => setWifi({ ...wifi, password: e.target.value })} autoComplete="off" /></Field>
            </div>
          </Form>
        )}
      </State>
    </Card>
  );
}

/** Portal: o assinante troca nome e senha do próprio Wi-Fi. */
export function PortalWifi() {
  const list = useLoad<any[]>('/portal/cpe');
  const [f, setF] = useState<{ contract: string; index: string; ssid: string; password: string } | null>(null);
  if (!list.data?.length) return null;
  return (
    <Card title="Meu Wi-Fi">
      {list.data.map((c) => c.wifi.map((w: any) => (
        <div key={`${c.contract_id}${w.index}`} className="row" style={{ justifyContent: 'space-between' }}>
          <span>Rede <b>{w.ssid}</b></span><button className="sm" onClick={() => setF({ contract: c.contract_id, index: w.index, ssid: w.ssid ?? '', password: '' })}>Trocar nome ou senha</button></div>)))}
      {f && (
        <Form submit="Salvar no roteador" onCancel={() => setF(null)} onSubmit={async () => {
          const r = await api<any>(`/portal/cpe/${f.contract}/wifi`, { body: { index: f.index, ssid: f.ssid || undefined, password: f.password || undefined } }); toast(r.note); setF(null); list.reload();
        }}>
          <Field label="Nome da rede"><input value={f.ssid} maxLength={32} onChange={(e) => setF({ ...f, ssid: e.target.value })} /></Field>
          <Field label="Nova senha" hint="8 a 63 caracteres; em branco mantém a atual. Os aparelhos conectados precisarão da senha nova."><input value={f.password} minLength={8} maxLength={63} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" /></Field>
        </Form>
      )}
    </Card>
  );
}
