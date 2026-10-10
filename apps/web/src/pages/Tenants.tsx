import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, d, useLoad } from '../api';
import { useMe } from '../App';
import { ActionButton, Badge, Field, Form, Modal, Page, State } from '../ui';

export function Tenants() {
  const { reload: reloadMe } = useMe();
  const nav = useNavigate();
  const { data, loading, error, reload } = useLoad<any[]>('/tenants');
  const [creating, setCreating] = useState(false);
  const [support, setSupport] = useState<any>(null);
  const [reason, setReason] = useState('');
  const blank = { name: '', slug: '', admin_name: '', admin_email: '', admin_password: '' };
  const [f, setF] = useState(blank);
  const inp = (k: keyof typeof blank, props: any = {}) => <input value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} required {...props} />;
  return (
    <Page title="Provedores" actions={<button className="primary" onClick={() => setCreating(true)}>Novo provedor</button>}>
      <State loading={loading} error={error} empty={data?.length === 0}>
        <table>
          <thead><tr><th>Provedor</th><th>Identificador</th><th className="num">Usuários</th><th>Desde</th><th>Agentes</th><th>Operações</th><th>Situação</th><th></th></tr></thead>
          <tbody>{data?.map((t) => (
            <tr key={t.id}>
              <td>{t.name}</td><td className="mono">{t.slug}</td><td className="num">{t.users}</td><td>{d(t.created_at)}</td>
              <td>{t.agents ? (t.agents_offline > 0 ? <Badge tone="red">{t.agents_offline} de {t.agents} offline</Badge> : <Badge tone="green">{t.agents} online</Badge>) : <span className="muted">—</span>}</td>
              <td>{t.uncertain > 0 && <Badge tone="amber">{t.uncertain} incerta(s)</Badge>} {t.failed_recent > 0 && <Badge tone="red">{t.failed_recent} falha(s) 7d</Badge>}{!t.uncertain && !t.failed_recent && <span className="muted">ok</span>}</td>
              <td>{t.status === 'active' ? <Badge tone="green">Ativo</Badge> : <Badge tone="red">Suspenso</Badge>}</td>
              <td><div className="row" style={{ justifyContent: 'flex-end' }}>
                <button className="sm" onClick={() => { setSupport(t); setReason(''); }}>Acesso de suporte</button>
                <ActionButton className="sm" confirm={t.status === 'active' ? 'Suspender o acesso deste provedor ao sistema?' : undefined}
                  onClick={async () => { await api(`/tenants/${t.id}`, { method: 'PATCH', body: { status: t.status === 'active' ? 'suspended' : 'active' } }); reload(); }}>
                  {t.status === 'active' ? 'Suspender' : 'Reativar'}</ActionButton>
              </div></td>
            </tr>
          ))}</tbody>
        </table>
      </State>
      {creating && (
        <Modal title="Novo provedor" onClose={() => setCreating(false)}>
          <Form onCancel={() => setCreating(false)} onSubmit={async () => { await api('/tenants', { body: f }); setCreating(false); setF(blank); reload(); }}>
            <div className="cols">
              <Field label="Nome do provedor">{inp('name', { autoFocus: true })}</Field>
              <Field label="Identificador" hint="minúsculas, números e hífen">{inp('slug', { pattern: '[a-z0-9-]{2,40}' })}</Field>
            </div>
            <Field label="Nome do administrador">{inp('admin_name')}</Field>
            <div className="cols">
              <Field label="E-mail do administrador">{inp('admin_email', { type: 'email' })}</Field>
              <Field label="Senha inicial">{inp('admin_password', { type: 'password', minLength: 8 })}</Field>
            </div>
          </Form>
        </Modal>
      )}
      {support && (
        <Modal title={`Acesso de suporte — ${support.name}`} onClose={() => setSupport(null)}>
          <Form submit="Entrar no provedor" onCancel={() => setSupport(null)} onSubmit={async () => {
            await api('/support/enter', { body: { tenant_id: support.id, reason } });
            await reloadMe();
            nav('/');
          }}>
            <p className="muted small">O acesso fica registrado na auditoria do provedor, com seu usuário e o motivo informado.</p>
            <Field label="Motivo do acesso"><input value={reason} onChange={(e) => setReason(e.target.value)} required minLength={5} autoFocus /></Field>
          </Form>
        </Modal>
      )}
    </Page>
  );
}
