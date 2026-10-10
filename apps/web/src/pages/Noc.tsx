import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ago, api, dt, useLoad } from '../api';
import { can, useMe } from '../App';
import { Badge, Card, Field, Form, Meter, Modal, Page, State } from '../ui';

const SEV: Record<string, [string, 'gray' | 'green' | 'red' | 'amber' | 'blue']> = { critical: ['Crítico', 'red'], warning: ['Atenção', 'amber'], info: ['Informação', 'blue'], ok: ['OK', 'green'] };
const SevBadge = ({ s }: { s: string }) => <Badge tone={SEV[s]?.[1]}>{SEV[s]?.[0] ?? s}</Badge>;

function Settings({ cfg, onDone, onCancel }: { cfg: any; onDone: () => void; onCancel: () => void }) {
  const [rx, setRx] = useState(cfg.onu_rx_min_dbm == null ? '' : String(cfg.onu_rx_min_dbm));
  const [min, setMin] = useState(String(cfg.pon_outage_min));
  const [rm, setRm] = useState(!!cfg.onu_remove_on_contract_end);
  return (
    <Form onCancel={onCancel} onSubmit={async () => { await api('/noc/settings', { method: 'PUT', body: { onu_rx_min_dbm: rx === '' ? null : Number(rx.replace(',', '.')), pon_outage_min: Number(min), onu_remove_on_contract_end: rm } }); onDone(); }}>
      <Field label="Sinal mínimo aceitável da ONU (RX, em dBm)" hint="Em branco: o sistema mostra o sinal, mas não o classifica. O valor depende do equipamento e do projeto óptico do provedor.">
        <input value={rx} onChange={(e) => setRx(e.target.value)} placeholder="ex.: -27" inputMode="decimal" /></Field>
      <Field label="ONUs sem sinal na mesma porta PON para suspeitar de falha coletiva" hint="Além desse mínimo, é preciso que pelo menos metade das ONUs da porta esteja sem sinal.">
        <input type="number" min="2" max="500" value={min} onChange={(e) => setMin(e.target.value)} required /></Field>
      <label className="row" style={{ margin: '6px 0' }}><input type="checkbox" style={{ width: 'auto' }} checked={rm} onChange={(e) => setRm(e.target.checked)} />
        <span>Desautorizar a ONU na OLT automaticamente quando o contrato for encerrado</span></label>
      <p className="small muted" style={{ marginTop: 0 }}>Desligado, o sistema apenas avisa no contrato e a remoção fica por conta do operador.</p>
    </Form>
  );
}

export function Noc() {
  const { me } = useMe();
  const { data: o, loading, error, reload } = useLoad<any>('/noc/overview', 10000);
  const [cfg, setCfg] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const c = o?.counters;
  const stat = (n: any, label: string, bad = false) => <Card><div className="stat"><b style={{ color: bad ? 'var(--red)' : undefined }}>{n}</b><span>{label}</span></div></Card>;
  return (
    <Page title="NOC" actions={can(me, 'network:write') && o && <button onClick={() => setCfg(true)}>Limiares e regras</button>}>
      <State loading={loading && !o} error={error}>
        {o && (<>
          <p className="small muted" style={{ marginTop: 0 }}>Painel somente de leitura, atualizado {ago(o.generated_at)}. Os alertas vêm de regras fixas sobre as leituras dos agentes; nenhum deles altera a rede.</p>
          <div className="grid">
            {stat(c.agents_offline, c.agents_offline === 1 ? 'agente offline' : 'agentes offline', c.agents_offline > 0)}
            {stat(`${c.sessions} de ${c.accounts}`, `sessões PPPoE online, ${c.suspended} ${c.suspended === 1 ? 'suspensa' : 'suspensas'}`)}
            {stat(`${c.onus_down} de ${c.onus}`, 'ONUs sem sinal', c.onus_down > 0)}
            {stat(c.work_orders, `OS em aberto${c.work_orders_late ? ` · ${c.work_orders_late} vencida(s)` : ''}`, c.work_orders_late > 0)}
            {stat(c.tickets_technical, c.tickets_technical === 1 ? 'atendimento técnico em aberto' : 'atendimentos técnicos em aberto')}
          </div>
          <Card title={`Alertas (${o.alerts.length})`}>
            <State empty={o.alerts.length === 0} emptyText="Nenhum alerta agora.">
              <table>
                <thead><tr><th>Gravidade</th><th>Alerta</th><th></th></tr></thead>
                <tbody>{o.alerts.map((a: any, i: number) => (
                  <tr key={i}><td style={{ width: 110 }}><SevBadge s={a.severity} /></td>
                    <td><b>{a.title}</b>{a.detail && <div className="small muted">{a.detail}</div>}
                      {open === i && a.items && (
                        <ul className="steps">{a.items.map((x: any) => (
                          <li key={x.id} className="small">{x.contract_id ? <Link to={`/contratos/${x.contract_id}`}>{x.subscriber_name ?? x.target}</Link> : (x.target ?? x.serial)}
                            {x.serial && <span className="mono"> {x.serial} · {x.device_name} · PON {x.pon_port}</span>}
                            {x.observed_rx_dbm != null && <span> · RX {Number(x.observed_rx_dbm).toFixed(2)} dBm</span>}
                            {x.status && <span> · {x.action} · {x.status}{x.note ? ` — ${x.note}` : ''}</span>}
                            <span className="muted"> · {ago(x.observed_at ?? x.updated_at)}</span></li>
                        ))}</ul>
                      )}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{a.items && <button className="sm" onClick={() => setOpen(open === i ? null : i)}>{open === i ? 'ocultar' : `ver ${a.items.length}`}</button>} {a.link && <Link to={a.link}>abrir</Link>}</td></tr>
                ))}</tbody>
              </table>
            </State>
          </Card>
          <Card title="Portas PON">
            <State empty={o.pons.length === 0}>
              <table>
                <thead><tr><th>OLT</th><th>Porta PON</th><th className="num">ONUs autorizadas</th><th>Sem sinal</th><th>Situação</th><th>Última leitura</th></tr></thead>
                <tbody>{o.pons.map((g: any) => (
                  <tr key={`${g.device_id}|${g.pon_port}`}><td>{g.device_name}</td><td className="mono">{g.pon_port}</td><td className="num">{g.total}</td><td><div className="row" style={{ flexWrap: 'nowrap' }}><Meter value={g.down} max={g.total} warn={0.01} bad={0.5} /><span className="small">{g.down}</span></div></td>
                    <td>{g.outage ? <Badge tone="red">possível falha coletiva</Badge> : g.down ? <Badge tone="amber">falhas isoladas</Badge> : <Badge tone="green">normal</Badge>}</td><td className="small">{ago(g.read_at)}</td></tr>
                ))}</tbody>
              </table>
            </State>
            <p className="small muted">Sinal fraco: {o.settings.onu_rx_min_dbm == null ? 'sem limite definido pelo provedor (o sistema não classifica)' : `abaixo de ${o.settings.onu_rx_min_dbm} dBm`} · falha coletiva a partir de {o.settings.pon_outage_min} ONUs e metade da porta.</p>
          </Card>
        </>)}
      </State>
      {cfg && o && <Modal title="Limiares e regras de rede" onClose={() => setCfg(false)}><Settings cfg={o.settings} onCancel={() => setCfg(false)} onDone={() => { setCfg(false); reload(); }} /></Modal>}
    </Page>
  );
}

/** Diagnóstico do contrato: conclusão + evidências datadas. Não executa nada na rede. */
export function Diagnosis({ contractId, onClose }: { contractId: string; onClose: () => void }) {
  const { data: d, loading, error, reload } = useLoad<any>(`/contracts/${contractId}/diagnosis`);
  return (
    <Modal title="Diagnóstico do acesso" onClose={onClose} wide>
      <State loading={loading && !d} error={error}>
        {d && (<>
          <div className={`state ${d.severity === 'ok' ? '' : 'err'}`} style={{ textAlign: 'left', fontSize: 15 }}><SevBadge s={d.severity} /> <b>{d.verdict}</b></div>
          {d.findings.map((f: any) => (
            <div key={f.code} className="card" style={{ marginBottom: 8 }}>
              <div><SevBadge s={f.severity} /> <b>{f.title}</b></div>
              {f.evidence.length > 0 && <ul className="steps">{f.evidence.map((e: any, i: number) => (
                <li key={i} className="small"><span className="muted" style={{ minWidth: 150 }}>{e.label}</span><span>{e.value}{e.at && <span className="muted"> · lido em {dt(e.at)}</span>}</span></li>
              ))}</ul>}
              {f.suggestion && <div className="small" style={{ marginTop: 4 }}>→ {f.suggestion}</div>}
            </div>
          ))}
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="small muted">{d.limits}</span><button className="sm" onClick={reload}>Atualizar</button>
          </div>
        </>)}
      </State>
    </Modal>
  );
}

/** Endereço IP fixo e porta da rede óptica do contrato (somente leitura; a edição fica nas telas de IPAM e FTTH). */
export function InfraPanel({ contractId }: { contractId: string }) {
  const { me } = useMe();
  const ips = useLoad<any[]>(can(me, 'network:read') ? `/contracts/${contractId}/ips` : null);
  const ftth = useLoad<any>(can(me, 'network:read') ? `/contracts/${contractId}/ftth` : null);
  const v6 = useLoad<any>(can(me, 'network:read') ? `/contracts/${contractId}/ipv6` : null);
  const [diag, setDiag] = useState(false);
  if (!can(me, 'network:read')) return null;
  const drop = ftth.data?.drop;
  return (
    <Card title="Infraestrutura" actions={<button className="primary" onClick={() => setDiag(true)}>Diagnosticar acesso</button>}>
      <div className="grid2">
        <div><div className="small muted" style={{ fontWeight: 600 }}>Endereço IP fixo</div>
          {ips.data?.length ? ips.data.map((a) => <div key={a.id}><span className="mono">{a.address}</span> <span className="small muted">{a.pool_name}</span></div>) : <span className="muted">nenhum (endereço dinâmico) — <Link to="/ipam">gerenciar</Link></span>}
          {v6.data?.delegation && <div><span className="mono">{v6.data.delegation.prefix}</span> <span className="small muted">prefixo IPv6 reservado</span></div>}</div>
        <div><div className="small muted" style={{ fontWeight: 600 }}>Rede óptica</div>
          {drop ? <span>{drop.box_name} · porta {drop.port}{drop.device_name && <span className="small muted"> · {drop.device_name} PON {drop.pon_port ?? '—'}</span>}</span> : <span className="muted">sem porta registrada — <Link to="/ftth">gerenciar</Link></span>}</div>
      </div>
      {diag && <Diagnosis contractId={contractId} onClose={() => setDiag(false)} />}
    </Card>
  );
}
