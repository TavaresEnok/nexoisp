import { useState } from 'react';
import { api, download, useLoad } from '../api';
import { can, useMe } from '../App';
import { ActionButton, Badge, Card, Field, Page, State } from '../ui';

const TECH: Record<string, string> = { FTTH: 'FTTH (fibra até a casa)', FTTB: 'FTTB (fibra até o prédio)', HFC: 'HFC (cabo coaxial)', XDSL: 'xDSL (par metálico)',
  ETHERNET: 'Ethernet (cabo de rede)', RADIO: 'Rádio', LTE: 'LTE/4G', SATELITE: 'Satélite', OUTRA: 'Outra' };
const prevMonth = () => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return d.toISOString().slice(0, 7); };

/** Coleta mensal de acessos (DICI/SCM). O sistema gera o arquivo; o envio à ANATEL é feito pelo provedor no sistema dela. */
export function Anatel() {
  const [comp, setComp] = useState(prevMonth());
  const d = useLoad<any>(`/anatel/dici?competence=${comp}`);
  const [mun, setMun] = useState<Record<string, string>>({});
  const p = d.data?.pending;
  const total = d.data?.rows.reduce((s: number, r: any) => s + r.acessos, 0) ?? 0;
  return (
    <Page title="Coleta de acessos ANATEL (DICI)" sub="Acessos em serviço no último dia do mês, por CNPJ, município, tipo de cliente, área, meio, tecnologia e velocidade. Confira o leiaute no Sistema de Coleta da ANATEL antes de enviar: o sistema não envia nada por você."
      actions={<>
        <input type="month" value={comp} onChange={(e) => setComp(e.target.value)} aria-label="Competência" />
        <ActionButton onClick={() => download(`/anatel/dici?competence=${comp}&format=csv`, `dici-acessos-${comp}.csv`)}>Baixar arquivo</ActionButton>
      </>}>
      <State loading={d.loading} error={d.error}>
        {p && (<>
          <div className="grid">
            <Card><div className="stat"><b>{total}</b><span>acessos no arquivo</span></div></Card>
            <Card><div className="stat"><b style={{ color: p.total - total > 0 ? 'var(--red)' : undefined }}>{p.total - total}</b><span>contratos fora do arquivo por falta de dado</span></div></Card>
          </div>
          {p.sem_cnpj > 0 && <div className="state err" style={{ textAlign: 'left' }}>{p.sem_cnpj} contrato(s) sem CNPJ: cadastre a empresa com CNPJ em Administração → Empresas (a primeira vira a padrão).</div>}
          {p.cities_without_code.length > 0 && (
            <Card title={`Municípios sem código IBGE (${p.sem_municipio} contratos)`}>
              <p className="small muted" style={{ marginTop: 0 }}>O município vem do endereço de instalação do contrato (ou do assinante). Informe o código IBGE de 7 dígitos; a grafia sem acento também casa.</p>
              <table><tbody>{p.cities_without_code.map((c: any) => { const k = `${c.state}|${c.city}`; return (
                <tr key={k}><td>{c.city || <i>sem cidade no endereço</i>} / {c.state || '—'}</td><td className="num">{c.contratos}</td>
                  <td>{c.city && c.state && <span className="row"><input className="mono" style={{ width: 110 }} placeholder="3106200" value={mun[k] ?? ''} onChange={(e) => setMun({ ...mun, [k]: e.target.value })} />
                    <ActionButton className="sm" disabled={!/^\d{7}$/.test(mun[k] ?? '')} onClick={async () => { await api('/anatel/municipalities', { method: 'PUT', body: { name: c.city, state: c.state, ibge_code: mun[k] } }); d.reload(); }}>Salvar</ActionButton></span>}</td></tr>); })}</tbody></table>
            </Card>)}
          {p.plans_without_technology.length > 0 && (
            <Card title="Planos sem tecnologia de acesso">
              <table><tbody>{p.plans_without_technology.map((pl: any) => (
                <tr key={pl.id}><td>{pl.name}</td><td><select defaultValue="" aria-label={`Tecnologia de ${pl.name}`} onChange={async (e) => { if (!e.target.value) return; await api(`/plans/${pl.id}/technology`, { method: 'PUT', body: { access_technology: e.target.value } }); d.reload(); }}>
                  <option value="">Escolha…</option>{Object.entries(TECH).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></td></tr>))}</tbody></table>
            </Card>)}
          <Card title="Prévia do arquivo">
            <State empty={d.data.rows.length === 0} emptyText="Nenhum acesso completo nesta competência.">
              <table>
                <thead><tr><th>CNPJ</th><th>IBGE</th><th>Cliente</th><th>Área</th><th>Meio</th><th>Tecnologia</th><th className="num">Velocidade (Mbps)</th><th className="num">Acessos</th></tr></thead>
                <tbody>{d.data.rows.map((r: any, i: number) => (
                  <tr key={i}><td className="mono">{r.cnpj}</td><td className="mono">{r.ibge_code}</td><td>{r.tipo_cliente}</td><td>{r.tipo_atendimento}</td><td>{r.meio}</td><td>{r.tecnologia}</td>
                    <td className="num">{r.velocidade_mbps}</td><td className="num">{r.acessos}</td></tr>))}</tbody>
              </table>
            </State>
          </Card>
        </>)}
      </State>
    </Page>
  );
}

/** Área do contrato para a coleta (urbana ou rural). */
export function ContractArea({ contract, onChange }: { contract: any; onChange: () => void }) {
  const { me } = useMe();
  const w = can(me, 'contracts:write') && contract.status === 'active';
  return (
    <Card title="Área (coleta ANATEL)">
      {w ? <select aria-label="Área do contrato" value={contract.service_area ?? 'urban'} onChange={async (e) => { await api(`/contracts/${contract.id}/service-area`, { method: 'PUT', body: { service_area: e.target.value } }); onChange(); }}>
        <option value="urban">Urbana</option><option value="rural">Rural</option></select>
        : <Badge>{contract.service_area === 'rural' ? 'Rural' : 'Urbana'}</Badge>}
    </Card>
  );
}
