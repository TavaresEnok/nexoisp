import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, d, doc, download, money, speed, useLoad, usePaged } from '../api';
import { can, has, useMe } from '../App';
import { ActionButton, Badge, Card, Field, Form, KV, Modal, Page, Pager, State } from '../ui';
import { Contacts, SubscriberNotes, Timeline } from './Atendimento';
import { ContractForm } from './Contracts';
import { TicketList } from './Crm';
import { WorkOrderList } from './Field';

const EMPTY = { name: '', document: '', email: '', phone: '', address_street: '', address_number: '', address_district: '',
  address_city: '', address_state: '', address_zip: '', notes: '', status: 'active',
  birth_date: '', rg: '', rg_issuer: '', mother_name: '', trade_name: '' };

export function SubscriberForm({ initial, onDone, onCancel }: { initial?: any; onDone: (s: any) => void; onCancel: () => void }) {
  const [f, setF] = useState<any>({ ...EMPTY, ...Object.fromEntries(Object.entries(initial ?? {}).map(([k, v]) => [k, v ?? ''])) });
  const inp = (k: string, props: any = {}) => <input value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} {...props} />;
  return (
    <Form onCancel={onCancel} onSubmit={async () => {
      const body = Object.fromEntries(Object.keys(EMPTY).map((k) => [k, f[k]]));
      onDone(await api(initial ? `/subscribers/${initial.id}` : '/subscribers', { method: initial ? 'PATCH' : 'POST', body }));
    }}>
      <Field label="Nome / Razão social">{inp('name', { required: true, autoFocus: true })}</Field>
      <div className="cols">
        <Field label="CPF/CNPJ">{inp('document', { placeholder: 'somente números ou formatado' })}</Field>
        <Field label="Telefone">{inp('phone')}</Field>
      </div>
      <Field label="E-mail">{inp('email', { type: 'email' })}</Field>
      <div className="cols3">
        <Field label="Nascimento / abertura">{inp('birth_date', { type: 'date' })}</Field>
        <Field label="RG">{inp('rg')}</Field>
        <Field label="Órgão emissor">{inp('rg_issuer', { maxLength: 20 })}</Field>
      </div>
      <div className="cols3">
        <Field label="Nome da mãe">{inp('mother_name')}</Field>
        <Field label="Nome fantasia (pessoa jurídica)">{inp('trade_name')}</Field>
      </div>
      <div className="cols3">
        <Field label="Logradouro">{inp('address_street')}</Field>
        <Field label="Número">{inp('address_number')}</Field>
        <Field label="CEP">{inp('address_zip')}</Field>
      </div>
      <div className="cols3">
        <Field label="Bairro">{inp('address_district')}</Field>
        <Field label="Cidade">{inp('address_city')}</Field>
        <Field label="UF">{inp('address_state', { maxLength: 2 })}</Field>
      </div>
      <Field label="Observações"><textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      {initial && (
        <Field label="Situação do cadastro">
          <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
            <option value="active">Ativo</option><option value="inactive">Inativo</option>
          </select>
        </Field>
      )}
    </Form>
  );
}

export function Subscribers() {
  const { me } = useMe();
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const list = usePaged<any>(`/subscribers?q=${encodeURIComponent(q)}`);
  const { data, loading, error, reload } = list;
  return (
    <Page title="Assinantes" actions={<>
      <input className="search" placeholder="Buscar por nome, documento, e-mail…" value={q} onChange={(e) => setQ(e.target.value)} />
      <ActionButton onClick={() => download(`/subscribers?q=${encodeURIComponent(q)}&format=csv&limit=5000`, 'assinantes.csv')}>Exportar CSV</ActionButton>
      {can(me, 'subscribers:write') && <button className="primary" onClick={() => setCreating(true)}>Novo assinante</button>}
    </>}>
      <State loading={loading && !data} error={error} empty={data?.length === 0}>
        <table>
          <thead><tr><th>Nome</th><th>CPF/CNPJ</th><th>Contato</th><th>Cidade</th><th className="num">Contratos ativos</th><th>Cadastro</th></tr></thead>
          <tbody>
            {data?.map((s) => (
              <tr key={s.id}>
                <td><Link to={`/assinantes/${s.id}`}>{s.name}</Link></td>
                <td className="mono">{doc(s.document)}</td>
                <td>{s.phone ?? s.email ?? '—'}</td>
                <td>{s.address_city ?? '—'}</td>
                <td className="num">{s.active_contracts}</td>
                <td>{s.status === 'active' ? <Badge tone="green">Ativo</Badge> : <Badge>Inativo</Badge>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      <Pager p={list} />
      </State>
      {creating && (
        <Modal title="Novo assinante" onClose={() => setCreating(false)}>
          <SubscriberForm onCancel={() => setCreating(false)} onDone={() => { setCreating(false); reload(); }} />
        </Modal>
      )}
    </Page>
  );
}

export function SubscriberDetail() {
  const { id } = useParams();
  const { me } = useMe();
  const { data: s, loading, error, reload } = useLoad<any>(`/subscribers/${id}`);
  const [modal, setModal] = useState<'edit' | 'contract' | 'portal' | null>(null);
  const portal = useLoad<any>(`/subscribers/${id}/portal-access`);
  const [pf, setPf] = useState({ email: '', password: '' });
  return (
    <Page title={s?.name ?? 'Assinante'} actions={s && <>
      {can(me, 'subscribers:write') && <button onClick={() => setModal('edit')}>Editar</button>}
      {can(me, 'subscribers:write') && <button onClick={() => { setPf({ email: portal.data?.email ?? s.email ?? '', password: '' }); setModal('portal'); }}>{portal.data ? 'Redefinir acesso ao portal' : 'Criar acesso ao portal'}</button>}
      {can(me, 'contracts:write') && <button className="primary" onClick={() => setModal('contract')}>Novo contrato</button>}
    </>}>
      <State loading={loading} error={error}>
        {s && (<>
          <Card title="Cadastro">
            <KV items={[
              ['CPF/CNPJ', <span className="mono">{doc(s.document)}</span>], ['E-mail', s.email], ['Telefone', s.phone],
              ['Endereço', [s.address_street, s.address_number, s.address_district].filter(Boolean).join(', ') || '—'],
              ['Cidade/UF', [s.address_city, s.address_state].filter(Boolean).join('/') || '—'], ['CEP', s.address_zip],
              ['Situação', s.status === 'active' ? <Badge tone="green">Ativo</Badge> : <Badge>Inativo</Badge>], ['Cadastrado em', d(s.created_at)],
              ['Portal do assinante', portal.data ? <>{portal.data.email} <Badge tone="green">ativo</Badge></> : 'sem acesso'],
              ['Nascimento', s.birth_date ? d(s.birth_date) : '—'], ['RG', [s.rg, s.rg_issuer].filter(Boolean).join(' · ') || '—'],
              ['Nome da mãe', s.mother_name || '—'], ['Nome fantasia', s.trade_name || '—'],
              ['Observações', s.notes],
            ]} />
          </Card>
          <Card title="Contratos">
            <State empty={s.contracts.length === 0}>
              <table>
                <thead><tr><th>Plano</th><th>Velocidade</th><th className="num">Mensalidade</th><th>Vencimento</th><th>Início</th><th>Situação comercial</th></tr></thead>
                <tbody>
                  {s.contracts.map((c: any) => (
                    <tr key={c.id}>
                      <td><Link to={`/contratos/${c.id}`}>{c.plan_name} <span className="muted small">v{c.plan_version}</span></Link></td>
                      <td>{speed(c.down_kbps)} / {speed(c.up_kbps)}</td>
                      <td className="num">{money(c.price_cents)}</td>
                      <td>dia {c.due_day}</td>
                      <td>{d(c.start_date)}</td>
                      <td>{c.status === 'active' ? <Badge tone="green">Vigente</Badge> : <Badge>Encerrado</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </State>
          </Card>
          <SubscriberNotes subscriberId={s.id} />
          <Contacts subscriberId={s.id} />
          <Timeline subscriberId={s.id} />
          {can(me, 'crm:read') && has(me, 'crm') && <TicketList subscriberId={s.id} />}
          {can(me, 'os:read') && has(me, 'field') && <WorkOrderList subscriberId={s.id} />}
          {modal === 'edit' && (
            <Modal title="Editar assinante" onClose={() => setModal(null)}>
              <SubscriberForm initial={s} onCancel={() => setModal(null)} onDone={() => { setModal(null); reload(); }} />
            </Modal>
          )}
          {modal === 'portal' && (
            <Modal title="Acesso ao portal do assinante" onClose={() => setModal(null)}>
              <Form submit="Salvar acesso" onCancel={() => setModal(null)} onSubmit={async () => { await api(`/subscribers/${s.id}/portal-access`, { body: pf }); setModal(null); portal.reload(); }}>
                <p className="small muted">O assinante entra pela mesma tela de login e vê apenas os próprios contratos e faturas.</p>
                <Field label="E-mail de acesso"><input type="email" value={pf.email} onChange={(e) => setPf({ ...pf, email: e.target.value })} required /></Field>
                <Field label="Senha" hint="Mínimo de 8 caracteres. Informe ao assinante por um canal seguro."><input type="password" value={pf.password} onChange={(e) => setPf({ ...pf, password: e.target.value })} required minLength={8} /></Field>
              </Form>
            </Modal>
          )}
          {modal === 'contract' && (
            <Modal title="Novo contrato" onClose={() => setModal(null)}>
              <ContractForm subscriberId={s.id} onCancel={() => setModal(null)} onDone={() => { setModal(null); reload(); }} />
            </Modal>
          )}
        </>)}
      </State>
    </Page>
  );
}
