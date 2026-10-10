import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, download, dt, useLoad } from '../api';
import { can, useMe } from '../App';
import { ActionButton, Badge, Card, Field, Form, KV, Modal, Page, State } from '../ui';

const KIND: Record<string, string> = { public: 'Público', cgnat: 'CGNAT (assinantes)', private: 'Privado', management: 'Gerência' };

function PoolForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const devices = useLoad<any[]>('/devices');
  const [f, setF] = useState({ name: '', cidr: '', kind: 'cgnat', device_id: '', notes: '' });
  return (
    <Form onCancel={onCancel} onSubmit={async () => { await api('/ipam/pools', { body: { ...f, device_id: f.device_id || null } }); onDone(); }}>
      <div className="cols">
        <Field label="Nome"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required autoFocus /></Field>
        <Field label="Bloco (CIDR)" hint="Endereço de rede, ex.: 100.64.0.0/22"><input className="mono" value={f.cidr} onChange={(e) => setF({ ...f, cidr: e.target.value })} required /></Field>
      </div>
      <div className="cols">
        <Field label="Tipo"><select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Equipamento que usa o bloco (opcional)">
          <select value={f.device_id} onChange={(e) => setF({ ...f, device_id: e.target.value })}><option value="">—</option>{devices.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
        </Field>
      </div>
      <Field label="Observações"><input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
    </Form>
  );
}

/** Endereços de um bloco: reservas e IPs fixos de contratos. */
function Allocations({ pool, onClose, write }: { pool: any; onClose: () => void; write: boolean }) {
  const list = useLoad<any[]>(`/ipam/pools/${pool.id}/allocations`);
  const [q, setQ] = useState('');
  const contracts = useLoad<any[]>(q.length >= 2 ? `/contracts?status=active&limit=20&q=${encodeURIComponent(q)}` : null);
  const [f, setF] = useState({ address: '', contract_id: '', description: '' });
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <Modal title={`Endereços — ${pool.name} (${pool.cidr})`} onClose={onClose} wide>
      {write && (
        <Form submit="Alocar endereço" onSubmit={async () => {
          const r = await api(`/ipam/pools/${pool.id}/allocations`, { body: { address: f.address || null, contract_id: f.contract_id || null, description: f.description || null } });
          setMsg(r.network ? `${r.address}: ${r.network.note}.` : null);
          setF({ address: '', contract_id: '', description: '' }); list.reload();
        }}>
          <div className="cols3">
            <Field label="Contrato (busque pelo assinante)"><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="nome do assinante…" /></Field>
            <Field label="Selecione">
              <select value={f.contract_id} onChange={(e) => setF({ ...f, contract_id: e.target.value })}>
                <option value="">— reserva sem contrato —</option>
                {contracts.data?.map((k) => <option key={k.id} value={k.id}>{k.subscriber_name} — {k.plan_name}</option>)}
              </select>
            </Field>
            <Field label="Endereço" hint="Em branco: primeiro livre."><input className="mono" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
          </div>
          <Field label="Descrição" hint="Obrigatória para reserva sem contrato."><input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        </Form>
      )}
      {msg && <div className="state" style={{ textAlign: 'left' }}>{msg}</div>}
      <p className="small muted">O IP fixo de um contrato é entregue pelo RADIUS do provedor na conexão PPPoE. Use um endereço <b>fora da faixa dinâmica</b> configurada no concentrador,
        para não coincidir com o de outro assinante.</p>
      <State loading={list.loading} error={list.error} empty={list.data?.length === 0}>
        <table>
          <thead><tr><th>Endereço</th><th>Contrato</th><th>Descrição</th><th>Alocado em</th><th>Por</th><th></th></tr></thead>
          <tbody>{list.data?.map((a) => (
            <tr key={a.id}><td className="mono">{a.address}</td>
              <td>{a.contract_id ? <Link to={`/contratos/${a.contract_id}`}>{a.subscriber_name}</Link> : <span className="muted">reserva</span>}</td>
              <td className="small">{a.description ?? '—'}</td><td className="small">{dt(a.created_at)}</td><td className="small">{a.created_by_name ?? '—'}</td>
              <td>{write && <ActionButton className="sm danger" confirm={`Liberar ${a.address}?`} onClick={async () => { const r = await api(`/ipam/allocations/${a.id}`, { method: 'DELETE' }); setMsg(r.network ? `${a.address} liberado: ${r.network.note}.` : null); list.reload(); }}>Liberar</ActionButton>}</td></tr>
          ))}</tbody>
        </table>
      </State>
    </Modal>
  );
}

function CgnatForm({ pools, onDone, onCancel }: { pools: any[]; onDone: () => void; onCancel: () => void }) {
  const [f, setF] = useState({ name: '', public_pool_id: '', private_pool_id: '', ports_per_subscriber: '2000', port_start: '1024' });
  const [cap, setCap] = useState<any>(null);
  const body = () => ({ ...f, ports_per_subscriber: Number(f.ports_per_subscriber), port_start: Number(f.port_start) });
  return (
    <Form submit="Criar plano" onCancel={onCancel} onSubmit={async () => { await api('/cgnat/plans', { body: body() }); onDone(); }}>
      <p className="small muted" style={{ marginTop: 0 }}>Cada endereço do bloco de assinantes recebe um bloco fixo de portas em um IP público. O plano não é alterado depois de criado:
        para mudar, encerre-o e crie outro (as consultas de datas passadas continuam respondendo pelo plano da época).</p>
      <Field label="Nome"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required autoFocus /></Field>
      <div className="cols">
        <Field label="Bloco dos assinantes (tipo CGNAT)">
          <select value={f.private_pool_id} onChange={(e) => setF({ ...f, private_pool_id: e.target.value })} required><option value="">Selecione…</option>
            {pools.filter((p) => p.kind === 'cgnat' && p.family === 4).map((p) => <option key={p.id} value={p.id}>{p.name} · {p.cidr}</option>)}</select>
        </Field>
        <Field label="Bloco de saída (tipo público)">
          <select value={f.public_pool_id} onChange={(e) => setF({ ...f, public_pool_id: e.target.value })} required><option value="">Selecione…</option>
            {pools.filter((p) => p.kind === 'public' && p.family === 4).map((p) => <option key={p.id} value={p.id}>{p.name} · {p.cidr}</option>)}</select>
        </Field>
      </div>
      <div className="cols">
        <Field label="Portas por assinante"><input type="number" min="64" max="32768" value={f.ports_per_subscriber} onChange={(e) => setF({ ...f, ports_per_subscriber: e.target.value })} required /></Field>
        <Field label="Primeira porta"><input type="number" min="1024" max="65000" value={f.port_start} onChange={(e) => setF({ ...f, port_start: e.target.value })} required /></Field>
      </div>
      <div className="row">
        <ActionButton onClick={async () => { setCap(null); setCap(await api('/cgnat/plans/check', { body: body() })); }}>Conferir capacidade</ActionButton>
        {cap && <span className="small">{cap.private_ips} endereços privados em {cap.public_ips} público(s) · até {cap.ratio} assinante(s) por IP público · capacidade {cap.max_private_ips}</span>}
      </div>
    </Form>
  );
}

function CgnatMap({ plan, onClose }: { plan: any; onClose: () => void }) {
  const { data, loading, error } = useLoad<any>(`/cgnat/plans/${plan.id}/map?limit=512`);
  return (
    <Modal title={`Mapa — ${plan.name}`} onClose={onClose} wide>
      <State loading={loading} error={error}>
        {data && (<>
          <p className="small muted" style={{ marginTop: 0 }}>{data.rows.length < data.total ? `Primeiros ${data.rows.length} de ${data.total} endereços.` : `${data.total} endereços.`} O script completo traz todos.</p>
          <table>
            <thead><tr><th>IP privado</th><th>IP público</th><th>Portas</th></tr></thead>
            <tbody>{data.rows.map((b: any) => <tr key={b.private_ip}><td className="mono">{b.private_ip}</td><td className="mono">{b.public_ip}</td><td className="mono">{b.port_start}–{b.port_end}</td></tr>)}</tbody>
          </table>
        </>)}
      </State>
    </Modal>
  );
}

/** Rastreabilidade: quem estava atrás de um IP público e porta em uma data. A consulta fica registrada na auditoria. */
function Trace() {
  const [f, setF] = useState({ ip: '', port: '', at: '' });
  const [r, setR] = useState<any>(null);
  return (
    <Card title="Rastrear conexão (IP público + porta)">
      <Form submit="Consultar" onSubmit={async () => {
        setR(null);
        const at = f.at ? `&at=${encodeURIComponent(new Date(f.at).toISOString())}` : '';
        setR(await api(`/cgnat/trace?ip=${encodeURIComponent(f.ip)}&port=${encodeURIComponent(f.port)}${at}`));
      }}>
        <div className="cols3">
          <Field label="IP público"><input className="mono" value={f.ip} onChange={(e) => setF({ ...f, ip: e.target.value })} required /></Field>
          <Field label="Porta de origem"><input type="number" min="1" max="65535" value={f.port} onChange={(e) => setF({ ...f, port: e.target.value })} required /></Field>
          <Field label="Data e hora" hint="Em branco: agora."><input type="datetime-local" value={f.at} onChange={(e) => setF({ ...f, at: e.target.value })} /></Field>
        </div>
      </Form>
      {r && !r.found && <div className="state">{r.note}</div>}
      {r?.found && (<>
        <KV items={[
          ['Plano de CGNAT', <>{r.plan.name} {r.plan.retired_at && <Badge>encerrado</Badge>}</>], ['IP privado', <span className="mono">{r.private_ip}</span>],
          ['Bloco de portas', <span className="mono">{r.public_ip}:{r.port_start}–{r.port_end}</span>], ['Data consultada', dt(r.at)],
          ['Endereço fixo de', r.fixed_allocation?.contract_id ? <Link to={`/contratos/${r.fixed_allocation.contract_id}`}>{r.fixed_allocation.subscriber_name}</Link> : r.fixed_allocation ? `reserva: ${r.fixed_allocation.description}` : '—'],
          ['Sessão com esse IP agora', r.current_session ? <><Link to={`/contratos/${r.current_session.contract_id}`}>{r.current_session.subscriber_name}</Link> <span className="small muted">(lida em {dt(r.current_session.observed_at)})</span></> : '—'],
        ]} />
        <p className="small muted">{r.note}</p>
      </>)}
    </Card>
  );
}

export function Ipam() {
  const { me } = useMe();
  const w = can(me, 'network:write');
  const pools = useLoad<any[]>('/ipam/pools');
  const plans = useLoad<any[]>('/cgnat/plans');
  const [modal, setModal] = useState<{ kind: 'pool' | 'alloc' | 'cgnat' | 'map'; item?: any } | null>(null);
  const reload = () => { pools.reload(); plans.reload(); };
  return (
    <Page title="Endereços IP e CGNAT" actions={w && <button className="primary" onClick={() => setModal({ kind: 'pool' })}>Novo bloco</button>}>
      <Card title="Blocos de endereços">
        <State loading={pools.loading} error={pools.error} empty={pools.data?.length === 0}>
          <table>
            <thead><tr><th>Bloco</th><th>Nome</th><th>Tipo</th><th>Equipamento</th><th className="num">Alocados</th><th className="num">Tamanho</th><th></th></tr></thead>
            <tbody>{pools.data?.map((p) => (
              <tr key={p.id}>
                <td className="mono">{p.cidr}</td><td>{p.name}{p.notes && <div className="small muted">{p.notes}</div>}</td>
                <td>{KIND[p.kind]} {p.cgnat_plan_id && <Badge tone="blue">em plano de CGNAT</Badge>}</td><td className="small">{p.device_name ?? '—'}</td>
                <td className="num">{p.allocated}</td><td className="num">{p.size ?? '—'}</td>
                <td><div className="row" style={{ justifyContent: 'flex-end' }}>
                  <button className="sm" onClick={() => setModal({ kind: 'alloc', item: p })}>Endereços</button>
                  {w && <ActionButton className="sm danger" confirm={`Excluir o bloco ${p.cidr}?`} onClick={async () => { await api(`/ipam/pools/${p.id}`, { method: 'DELETE' }); reload(); }}>Excluir</ActionButton>}
                </div></td>
              </tr>
            ))}</tbody>
          </table>
        </State>
      </Card>
      <Card title="Planos de CGNAT" actions={w && <button onClick={() => setModal({ kind: 'cgnat' })}>Novo plano de CGNAT</button>}>
        <p className="small muted" style={{ marginTop: 0 }}>O NexoISP calcula o plano e gera o script do roteador para revisão. <b>Nada é aplicado ao equipamento pelo sistema</b>: a importação é feita pela equipe de rede, em janela de manutenção.</p>
        <State loading={plans.loading} error={plans.error} empty={plans.data?.length === 0}>
          <table>
            <thead><tr><th>Plano</th><th>Assinantes → saída</th><th className="num">Portas/assinante</th><th className="num">Assinantes/IP</th><th>Criado</th><th>Situação</th><th></th></tr></thead>
            <tbody>{plans.data?.map((g) => (
              <tr key={g.id}>
                <td>{g.name}</td><td className="mono">{g.private_cidr} → {g.public_cidr}</td><td className="num">{g.ports_per_subscriber}</td><td className="num">{g.capacity.ratio}</td>
                <td className="small">{dt(g.created_at)}<div className="muted">{g.created_by_name}</div></td>
                <td>{g.retired_at ? <Badge>Encerrado em {dt(g.retired_at)}</Badge> : <Badge tone="green">Vigente</Badge>}</td>
                <td><div className="row" style={{ justifyContent: 'flex-end' }}>
                  <button className="sm" onClick={() => setModal({ kind: 'map', item: g })}>Mapa</button>
                  {w && <ActionButton className="sm" onClick={() => download(`/cgnat/plans/${g.id}/script`, `cgnat-${g.name}.rsc`)}>Script RouterOS</ActionButton>}
                  {w && !g.retired_at && <ActionButton className="sm danger" confirm="Encerrar este plano? As consultas de datas anteriores continuam funcionando. Remova as regras do roteador separadamente."
                    onClick={async () => { await api(`/cgnat/plans/${g.id}/retire`, { method: 'POST', body: {} }); reload(); }}>Encerrar</ActionButton>}
                </div></td>
              </tr>
            ))}</tbody>
          </table>
        </State>
      </Card>
      <Trace />
      {modal?.kind === 'pool' && <Modal title="Novo bloco de endereços" onClose={() => setModal(null)}><PoolForm onCancel={() => setModal(null)} onDone={() => { setModal(null); reload(); }} /></Modal>}
      {modal?.kind === 'alloc' && <Allocations pool={modal.item} write={w} onClose={() => { setModal(null); reload(); }} />}
      {modal?.kind === 'cgnat' && <Modal title="Novo plano de CGNAT" onClose={() => setModal(null)}><CgnatForm pools={pools.data ?? []} onCancel={() => setModal(null)} onDone={() => { setModal(null); reload(); }} /></Modal>}
      {modal?.kind === 'map' && <CgnatMap plan={modal.item} onClose={() => setModal(null)} />}
    </Page>
  );
}
