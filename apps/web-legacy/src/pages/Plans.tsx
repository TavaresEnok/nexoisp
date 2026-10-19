import { useState } from 'react';
import { api, d, money, speed, useLoad } from '../api';
import { can, useMe } from '../App';
import { ActionButton, Badge, Field, Form, Modal, Page, State } from '../ui';
import { DunningBadge, DunningForm } from './Cobranca';

/** Fidelidade padrão do plano: vale para contratos novos; os existentes mantêm o que contrataram. */
function LoyaltyForm({ plan, onDone, onCancel }: { plan: any; onDone: () => void; onCancel: () => void }) {
  const [f, setF] = useState({ months: plan.loyalty_months ? String(plan.loyalty_months) : '', model: plan.penalty_model ?? 'fixed',
    value: plan.penalty_cents != null ? (plan.penalty_cents / 100).toFixed(2).replace('.', ',') : '' });
  return (
    <Form submit="Salvar" onCancel={onCancel} onSubmit={async () => {
      await api(`/plans/${plan.id}/loyalty`, { method: 'PUT', body: f.months === '' ? { months: null }
        : { months: Number(f.months), penalty_model: f.model, penalty_cents: Math.round(Number(f.value.replace(',', '.')) * 100) } });
      onDone();
    }}>
      <p className="small muted">Vale para contratos novos deste plano. Deixe os meses vazios para não ter fidelidade.</p>
      <div className="cols3">
        <Field label="Meses de carência"><input type="number" min="1" max="60" value={f.months} onChange={(e) => setF({ ...f, months: e.target.value })} /></Field>
        <Field label="Modelo da multa"><select value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })}><option value="fixed">Valor único</option><option value="monthly">Por mês restante</option></select></Field>
        <Field label="Valor (R$)"><input inputMode="decimal" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} required={f.months !== ''} /></Field>
      </div>
    </Form>
  );
}

/** Velocidade (com rajada) e pool entregues pelo RADIUS. Vazio = vale o perfil configurado no concentrador. */
function NetworkForm({ plan, onDone, onCancel }: { plan: any; onDone: () => void; onCancel: () => void }) {
  const [f, setF] = useState({ rate_limit: plan.rate_limit ?? '', address_pool: plan.address_pool ?? '' });
  const [saved, setSaved] = useState<any>(null);
  if (saved) return (
    <div>
      <p>Salvo. {saved.accounts_to_reapply} conta(s) já provisionada(s) só passam a usar os parâmetros novos ao reaplicar.</p>
      <div className="row">
        <ActionButton className="primary" confirm="Reaplicar a autorização das contas liberadas deste plano (até 500 por vez)?" onClick={async () => { const r = await api<any>(`/plans/${plan.id}/reapply`, { method: 'POST' }); setSaved({ ...saved, done: r }); }}>Reaplicar agora</ActionButton>
        <button onClick={onDone}>Fechar</button>
      </div>
      {saved.done && <p className="small">{saved.done.requested} operação(ões) solicitada(s){saved.done.refused ? `, ${saved.done.refused} recusada(s): ${saved.done.errors.join('; ')}` : ''}.</p>}
    </div>
  );
  return (
    <Form submit="Salvar" onCancel={onCancel} onSubmit={async () => { setSaved(await api(`/plans/${plan.id}/network`, { method: 'PUT', body: { rate_limit: f.rate_limit || null, address_pool: f.address_pool || null } })); }}>
      <p className="small muted">O perfil do concentrador ({plan.profile_name}) continua sendo enviado. Estes campos são opcionais e exigem agente 0.5.0 ou mais novo.</p>
      <Field label="Velocidade (formato MikroTik)" hint="subida/descida [rajada limiar tempo prioridade mínimo]. Ex.: 50M/100M 60M/120M 40M/80M 10/10"><input className="mono" value={f.rate_limit} onChange={(e) => setF({ ...f, rate_limit: e.target.value })} /></Field>
      <Field label="Pool de endereços" hint="Nome do pool que existe no concentrador."><input className="mono" value={f.address_pool} onChange={(e) => setF({ ...f, address_pool: e.target.value })} /></Field>
    </Form>
  );
}

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
  const [modal, setModal] = useState<{ kind: 'new' | 'version' | 'history' | 'dunning' | 'loyalty' | 'network'; plan?: any } | null>(null);
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
                  {can(me, 'network:write') && <button className="sm" onClick={() => setModal({ kind: 'network', plan: p })}>Rede{p.rate_limit || p.address_pool ? ' ✓' : ''}</button>}
                  {w && <button className="sm" onClick={() => setModal({ kind: 'loyalty', plan: p })}>Fidelidade{p.loyalty_months ? ` (${p.loyalty_months} m)` : ''}</button>}
                  {w && <ActionButton className="sm" onClick={async () => { await api(`/plans/${p.id}`, { method: 'PATCH', body: { active: !p.active } }); reload(); }}>{p.active ? 'Desativar' : 'Ativar'}</ActionButton>}
                </div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </State>
      {modal?.kind === 'new' && <Modal title="Novo plano" onClose={() => setModal(null)}><PlanForm onCancel={() => setModal(null)} onDone={() => { setModal(null); reload(); }} /></Modal>}
      {modal?.kind === 'version' && <Modal title={`Nova versão — ${modal.plan.name}`} onClose={() => setModal(null)}><PlanForm plan={modal.plan} onCancel={() => setModal(null)} onDone={() => { setModal(null); reload(); }} /></Modal>}
      {modal?.kind === 'network' && <Modal title={`Parâmetros de rede — ${modal.plan.name}`} onClose={() => { setModal(null); reload(); }}><NetworkForm plan={modal.plan} onCancel={() => setModal(null)} onDone={() => { setModal(null); reload(); }} /></Modal>}
      {modal?.kind === 'loyalty' && <Modal title={`Fidelidade — ${modal.plan.name}`} onClose={() => setModal(null)}><LoyaltyForm plan={modal.plan} onCancel={() => setModal(null)} onDone={() => { setModal(null); reload(); }} /></Modal>}
      {modal?.kind === 'dunning' && <Modal title={`Degraus de cobrança — ${modal.plan.name}`} onClose={() => setModal(null)}><DunningForm plan={modal.plan} onCancel={() => setModal(null)} onDone={() => { setModal(null); reload(); }} /></Modal>}
      {modal?.kind === 'history' && <Versions plan={modal.plan} onClose={() => setModal(null)} />}
    </Page>
  );
}
