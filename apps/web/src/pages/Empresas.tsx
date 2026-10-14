import { useState } from 'react';
import { api, doc, useLoad } from '../api';
import { can, useMe } from '../App';
import { ActionButton, Badge, Card, Field, Form, Page, State } from '../ui';

/** Empresas (CNPJs) pelas quais o provedor fatura. Sem nenhuma cadastrada, nada muda no sistema. */
export function Empresas() {
  const { me } = useMe();
  const list = useLoad<any[]>('/companies');
  const [f, setF] = useState({ name: '', document: '' });
  const w = can(me, 'settings:manage');
  return (
    <Page title="Empresas" sub="Use quando o provedor emite por mais de um CNPJ (matriz e filiais). A fatura nasce com a empresa do contrato; sem empresa no contrato, vale a padrão.">
      {w && (
        <Card title="Nova empresa">
          <Form submit="Cadastrar" onSubmit={async () => { await api('/companies', { body: { name: f.name, document: f.document } }); setF({ name: '', document: '' }); list.reload(); }}>
            <div className="cols2">
              <Field label="Nome da empresa"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required minLength={2} maxLength={120} /></Field>
              <Field label="CNPJ" hint="Opcional; 14 dígitos."><input className="mono" value={f.document} onChange={(e) => setF({ ...f, document: e.target.value })} inputMode="numeric" /></Field>
            </div>
          </Form>
        </Card>
      )}
      <State loading={list.loading} error={list.error} empty={list.data?.length === 0} emptyText="Nenhuma empresa cadastrada: o provedor fatura por um único CNPJ.">
        <table>
          <thead><tr><th>Empresa</th><th>CNPJ</th><th className="num">Contratos</th><th>Situação</th><th /></tr></thead>
          <tbody>
            {list.data?.map((e) => (
              <tr key={e.id}>
                <td>{e.name} {e.is_default && <Badge tone="blue">Padrão</Badge>}</td>
                <td className="mono">{e.document ? doc(e.document) : '—'}</td>
                <td className="num">{e.contracts}</td>
                <td>{e.active ? <Badge tone="green">Ativa</Badge> : <Badge>Inativa</Badge>}</td>
                <td className="actions">{w && (<>
                  {!e.is_default && e.active && <ActionButton className="sm" onClick={async () => { await api(`/companies/${e.id}`, { method: 'PATCH', body: { is_default: true } }); list.reload(); }}>Tornar padrão</ActionButton>}
                  {!e.is_default && <ActionButton className="sm" onClick={async () => { await api(`/companies/${e.id}`, { method: 'PATCH', body: { active: !e.active } }); list.reload(); }}>{e.active ? 'Desativar' : 'Ativar'}</ActionButton>}
                </>)}</td>
              </tr>))}
          </tbody>
        </table>
      </State>
    </Page>
  );
}

/** Empresa que fatura o contrato (só aparece se o provedor tem empresas cadastradas). */
export function ContractCompany({ contract, onChange }: { contract: any; onChange: () => void }) {
  const { me } = useMe();
  const list = useLoad<any[]>('/companies');
  if (!list.data?.length) return null;
  const w = can(me, 'contracts:write') && contract.status === 'active';
  const def = list.data.find((e) => e.is_default);
  return (
    <Card title="Empresa que fatura">
      {w ? (
        <select aria-label="Empresa do contrato" value={contract.company_id ?? ''} onChange={async (e) => { await api(`/contracts/${contract.id}/company`, { method: 'PUT', body: { company_id: e.target.value || null } }); onChange(); }}>
          <option value="">Padrão{def ? ` (${def.name})` : ''}</option>
          {list.data.filter((e) => e.active || e.id === contract.company_id).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
      ) : <span>{list.data.find((e) => e.id === contract.company_id)?.name ?? def?.name ?? '—'}</span>}
      <div className="small muted" style={{ marginTop: 6 }}>Vale para as faturas geradas daqui em diante; as já emitidas não mudam.</div>
    </Card>
  );
}
