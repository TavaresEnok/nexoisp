import { useState } from 'react';
import { api, d, money, speed, useLoad } from '../api';
import { can, useMe } from '../App';
import { ActionButton, Badge, Field, Form, Modal, Page, State } from '../ui';
import { DunningBadge, DunningForm } from './Cobranca';

function PlanForm({ plan, onDone, onCancel }: { plan?: any; onDone: () => void; onCancel: () => void }) {
  const [name, setName] = useState(plan?.name ?? '');
  const [price, setPrice] = useState(plan ? (plan.price_cents / 100).toFixed(2).replace('.', ',') : '');
  const [down, setDown] = useState(plan ? String(plan.down_kbps / 1000) : '');
  const [up, setUp] = useState(plan ? String(plan.up_kbps / 1000) : '');
  const [profile, setProfile] = useState(plan?.profile_name ?? '');
  return (
    <Form onCancel={onCancel} submit={plan ? 'Criar nova versão' : 'Salvar'} onSubmit={async () => {
      const cents = Math.round(Number(price.replace(/\./g, '').replace(',', '.')) * 100);
      if (!Number.isFinite(cents)) throw new Error('Preço inválido');
      const body = { name, price_cents: cents, down_kbps: Math.round(Number(down) * 1000), up_kbps: Math.round(Number(up) * 1000), profile_name: profile };
      await api(plan ? `/plans/${plan.id}/versions` : '/plans', { body });
      onDone();
    }}>
      {plan
        ? <p className="muted small">Contratos existentes continuam na versão v{plan.version} ({money(plan.price_cents)}). A nova versão vale para novos contratos e trocas de plano.</p>
        : <Field label="Nome do plano"><input value={name} onChange={(e) => setName(e.target.value)} required autoFocus /></Field>}
      <div className="cols3">
        <Field label="Mensalidade (R$)"><input value={price} onChange={(e) => setPrice(e.target.value)} required inputMode="decimal" placeholder="99,90" /></Field>
        <Field label="Download (Mbps)"><input value={down} onChange={(e) => setDown(e.target.value)} required type="number" min="1" /></Field>
        <Field label="Upload (Mbps)"><input value={up} onChange={(e) => setUp(e.target.value)} required type="number" min="1" /></Field>
      </div>
      <Field label="Perfil de velocidade no NAS" hint="Nome do perfil PPP configurado no equipamento."><input value={profile} onChange={(e) => setProfile(e.target.value)} required /></Field>
    </Form>
  );
}

function Versions({ plan, onClose }: { plan: any; onClose: () => void }) {
  const { data, loading, error } = useLoad<any[]>(`/plans/${plan.id}/versions`);
  return (
    <Modal title={`Histórico de versões — ${plan.name}`} onClose={onClose} wide>
      <State loading={loading} error={error}>
        <table>
          <thead><tr><th>Versão</th><th className="num">Mensalidade</th><th>Velocidade</th><th>Perfil</th><th>Desde</th><th className="num">Contratos</th></tr></thead>
          <tbody>{data?.map((v) => (
            <tr key={v.id}><td>v{v.version}</td><td className="num">{money(v.price_cents)}</td><td>{speed(v.down_kbps)} / {speed(v.up_kbps)}</td>
              <td className="mono">{v.profile_name}</td><td>{d(v.valid_from)}</td><td className="num">{v.contracts}</td></tr>
          ))}</tbody>
        </table>
      </State>
    </Modal>
  );
}

export function Plans() {
  const { me } = useMe();
  const { data, loading, error, reload } = useLoad<any[]>('/plans');
  const [modal, setModal] = useState<{ kind: 'new' | 'version' | 'history' | 'dunning'; plan?: any } | null>(null);
  const w = can(me, 'plans:write');
  return (
    <Page title="Planos" actions={w && <button className="primary" onClick={() => setModal({ kind: 'new' })}>Novo plano</button>}>
      <State loading={loading} error={error} empty={data?.length === 0}>
        <table>
          <thead><tr><th>Plano</th><th className="num">Mensalidade</th><th>Velocidade</th><th>Perfil</th><th>Inadimplência</th><th className="num">Contratos ativos</th><th>Situação</th><th></th></tr></thead>
          <tbody>
            {data?.map((p) => (
              <tr key={p.id}>
                <td>{p.name} <span className="muted small">v{p.version}</span></td>
                <td className="num">{money(p.price_cents)}</td>
                <td>{speed(p.down_kbps)} / {speed(p.up_kbps)}</td>
                <td className="mono">{p.profile_name}</td>
                <td><DunningBadge plan={p} /></td>
                <td className="num">{p.active_contracts}</td>
                <td>{p.active ? <Badge tone="green">Ativo</Badge> : <Badge>Inativo</Badge>}</td>
                <td><div className="row" style={{ justifyContent: 'flex-end' }}>
                  <button className="sm" onClick={() => setModal({ kind: 'history', plan: p })}>Histórico</button>
                  {w && <button className="sm" onClick={() => setModal({ kind: 'version', plan: p })}>Alterar preço/velocidade</button>}
                  {w && <button className="sm" onClick={() => setModal({ kind: 'dunning', plan: p })}>Degraus de cobrança</button>}
                  {w && <ActionButton className="sm" onClick={async () => { await api(`/plans/${p.id}`, { method: 'PATCH', body: { active: !p.active } }); reload(); }}>{p.active ? 'Desativar' : 'Ativar'}</ActionButton>}
                </div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </State>
      {modal?.kind === 'new' && <Modal title="Novo plano" onClose={() => setModal(null)}><PlanForm onCancel={() => setModal(null)} onDone={() => { setModal(null); reload(); }} /></Modal>}
      {modal?.kind === 'version' && <Modal title={`Nova versão — ${modal.plan.name}`} onClose={() => setModal(null)}><PlanForm plan={modal.plan} onCancel={() => setModal(null)} onDone={() => { setModal(null); reload(); }} /></Modal>}
      {modal?.kind === 'dunning' && <Modal title={`Degraus de cobrança — ${modal.plan.name}`} onClose={() => setModal(null)}><DunningForm plan={modal.plan} onCancel={() => setModal(null)} onDone={() => { setModal(null); reload(); }} /></Modal>}
      {modal?.kind === 'history' && <Versions plan={modal.plan} onClose={() => setModal(null)} />}
    </Page>
  );
}
