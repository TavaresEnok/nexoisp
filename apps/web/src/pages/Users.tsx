import { useState } from 'react';
import { api, useLoad } from '../api';
import { useMe } from '../App';
import { ActionButton, Badge, Field, Form, Modal, Page, State, toastError } from '../ui';

const ROLES: [string, string][] = [['admin', 'Administrador'], ['attendant', 'Atendimento'], ['finance', 'Financeiro'], ['noc', 'Técnico/NOC']];

export function Users() {
  const { me } = useMe();
  const { data, loading, error, reload } = useLoad<any[]>('/users');
  const [creating, setCreating] = useState(false);
  const [f, setF] = useState({ name: '', email: '', role: 'attendant', password: '' });
  return (
    <Page title="Usuários" actions={<button className="primary" onClick={() => setCreating(true)}>Novo usuário</button>}>
      <State loading={loading} error={error} empty={data?.length === 0}>
        <table>
          <thead><tr><th>Nome</th><th>E-mail</th><th>Papel</th><th>Situação</th><th>2 etapas</th><th></th></tr></thead>
          <tbody>{data?.map((u) => (
            <tr key={u.id}>
              <td>{u.name}</td><td>{u.email}</td>
              <td>
                <select aria-label={`Papel de ${u.name}`} style={{ width: 170 }} value={u.role} disabled={u.id === me.id}
                  onChange={async (e) => { try { await api(`/users/${u.id}`, { method: 'PATCH', body: { role: e.target.value } }); } catch (err: any) { toastError(err); } reload(); }}>
                  {ROLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </td>
              <td>{u.active ? <Badge tone="green">Ativo</Badge> : <Badge>Bloqueado</Badge>}</td>
              <td>{u.mfa_enabled ? <><Badge tone="green">ativa</Badge> {u.id !== me.id && <ActionButton className="sm" confirm="Remover a verificação em duas etapas deste usuário? Ele precisará configurar novamente."
                onClick={async () => { await api(`/users/${u.id}`, { method: 'PATCH', body: { reset_mfa: true } }); reload(); }}>redefinir</ActionButton>}</> : <span className="muted small">não configurada</span>}</td>
              <td>{u.id !== me.id && <ActionButton className="sm" onClick={async () => { await api(`/users/${u.id}`, { method: 'PATCH', body: { active: !u.active } }); reload(); }}>{u.active ? 'Bloquear' : 'Desbloquear'}</ActionButton>}</td>
            </tr>
          ))}</tbody>
        </table>
      </State>
      {creating && (
        <Modal title="Novo usuário" onClose={() => setCreating(false)}>
          <Form onCancel={() => setCreating(false)} onSubmit={async () => { await api('/users', { body: f }); setCreating(false); setF({ name: '', email: '', role: 'attendant', password: '' }); reload(); }}>
            <Field label="Nome"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required autoFocus /></Field>
            <Field label="E-mail"><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required /></Field>
            <Field label="Papel"><select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{ROLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
            <Field label="Senha inicial" hint="Mínimo de 8 caracteres."><input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required minLength={8} /></Field>
          </Form>
        </Modal>
      )}
    </Page>
  );
}
