import { useState } from 'react';
import { api, money, useLoad } from '../api';
import { can, useMe } from '../App';
import { ActionButton, Badge, Card, Field, Form, Page, State } from '../ui';

const toCents = (v: string) => Math.round(Number(v.replace(/\./g, '').replace(',', '.')) * 100);
const fmtComp = (c: string) => c.split('-').reverse().join('/');

/** Catálogo de produtos adicionais recorrentes (TV, telefonia, IP fixo…). Com o plano do contrato formam o combo. */
export function Adicionais() {
  const { me } = useMe();
  const list = useLoad<any[]>('/addons');
  const [f, setF] = useState({ name: '', price: '' });
  const [price, setPrice] = useState<Record<string, string>>({});
  const w = can(me, 'plans:write');
  return (
    <Page title="Produtos adicionais" sub="Cobrados todo mês junto com a mensalidade, em linhas próprias. Combo = plano + adicionais do contrato. Mudar o preço aqui vale só para novas contratações.">
      {w && (
        <Card title="Novo produto">
          <Form submit="Cadastrar" onSubmit={async () => { await api('/addons', { body: { name: f.name, price_cents: toCents(f.price) } }); setF({ name: '', price: '' }); list.reload(); }}>
            <div className="cols2">
              <Field label="Nome"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required minLength={2} maxLength={80} /></Field>
              <Field label="Preço mensal (R$)"><input value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} required inputMode="decimal" placeholder="49,90" /></Field>
            </div>
          </Form>
        </Card>
      )}
      <State loading={list.loading} error={list.error} empty={list.data?.length === 0} emptyText="Nenhum produto adicional cadastrado.">
        <table>
          <thead><tr><th>Produto</th><th className="num">Preço</th><th className="num">Contratos</th><th>Situação</th><th /></tr></thead>
          <tbody>{list.data?.map((p) => (
            <tr key={p.id}>
              <td>{p.name}</td>
              <td className="num">{price[p.id] === undefined ? money(p.price_cents) : <input style={{ width: 100 }} value={price[p.id]} onChange={(e) => setPrice({ ...price, [p.id]: e.target.value })} />}</td>
              <td className="num">{p.in_use}</td>
              <td>{p.active ? <Badge tone="green">Ativo</Badge> : <Badge>Inativo</Badge>}</td>
              <td className="actions">{w && (<>
                {price[p.id] === undefined
                  ? <button className="sm" onClick={() => setPrice({ ...price, [p.id]: (p.price_cents / 100).toFixed(2).replace('.', ',') })}>Alterar preço</button>
                  : <ActionButton className="sm primary" onClick={async () => { await api(`/addons/${p.id}`, { method: 'PATCH', body: { price_cents: toCents(price[p.id]) } }); const n = { ...price }; delete n[p.id]; setPrice(n); list.reload(); }}>Salvar</ActionButton>}
                <ActionButton className="sm" onClick={async () => { await api(`/addons/${p.id}`, { method: 'PATCH', body: { active: !p.active } }); list.reload(); }}>{p.active ? 'Desativar' : 'Ativar'}</ActionButton>
              </>)}</td>
            </tr>))}</tbody>
        </table>
      </State>
    </Page>
  );
}

/** Adicionais do contrato (combo): contratar, ver o que está vigente e encerrar. */
export function ContractAddons({ contract }: { contract: any }) {
  const { me } = useMe();
  const list = useLoad<any[]>(`/contracts/${contract.id}/addons`);
  const catalog = useLoad<any[]>('/addons');
  const [f, setF] = useState<{ product_id: string; quantity: string } | null>(null);
  const w = can(me, 'contracts:write') && contract.status === 'active';
  const total = list.data?.filter((a) => a.current && !a.ended_competence).reduce((s, a) => s + a.unit_price_cents * a.quantity, 0) ?? 0;
  if (!w && !list.data?.length) return null;
  return (
    <Card title="Produtos adicionais (combo)" actions={w && <button className="sm" onClick={() => setF({ product_id: '', quantity: '1' })}>Adicionar produto</button>}>
      {f && (
        <Form submit="Adicionar" onCancel={() => setF(null)} onSubmit={async () => { await api(`/contracts/${contract.id}/addons`, { body: { product_id: f.product_id, quantity: Number(f.quantity) } }); setF(null); list.reload(); }}>
          <div className="cols2">
            <Field label="Produto"><select value={f.product_id} required onChange={(e) => setF({ ...f, product_id: e.target.value })}>
              <option value="">Escolha…</option>{catalog.data?.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.name} — {money(p.price_cents)}</option>)}</select></Field>
            <Field label="Quantidade"><input type="number" min={1} max={99} value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} /></Field>
          </div>
          <p className="small muted">Passa a ser cobrado a partir do mês seguinte (a fatura do mês corrente já foi gerada). O preço fica congelado no contrato.</p>
        </Form>
      )}
      <State empty={list.data?.length === 0} emptyText="Nenhum produto adicional neste contrato.">
        <table><tbody>{list.data?.map((a) => (
          <tr key={a.id}>
            <td>{a.description}{a.quantity > 1 ? ` (x${a.quantity})` : ''}<div className="small muted">desde {fmtComp(a.from_competence)}{a.ended_competence ? ` · até antes de ${fmtComp(a.ended_competence)}` : ''}</div></td>
            <td className="num">{money(a.unit_price_cents * a.quantity)}/mês</td>
            <td className="actions">{w && !a.ended_competence && <ActionButton className="sm danger" confirm="Parar de cobrar este produto a partir do mês seguinte?" onClick={async () => { await api(`/contracts/${contract.id}/addons/${a.id}`, { method: 'DELETE' }); list.reload(); }}>Encerrar</ActionButton>}</td>
          </tr>))}</tbody></table>
        {total > 0 && <div className="small muted">Adicionais vigentes: {money(total)} por mês, além do plano.</div>}
      </State>
    </Card>
  );
}
