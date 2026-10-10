import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, d, useLoad } from '../api';
import { useMe } from '../App';
import { ActionButton, Badge, Field, Form, Modal, Page, State } from '../ui';

const MODULES: [string, string, string][] = [
  ['crm', 'Atendimentos e prospectos', 'Protocolos, funil comercial, relatórios e chamados pelo portal do assinante.'],
  ['field', 'Ordens de serviço e estoque', 'OS com material, estoque por série e tela de campo.'],
  ['notices', 'Avisos por webhook', 'Avisa o canal da equipe sobre chamados e ordens de serviço.'],
  ['noc', 'NOC e diagnóstico', 'Painel de alertas e diagnóstico do contrato. Somente leitura.'],
  ['ftth', 'Rede óptica', 'Cadastro de caixas, portas e mapa esquemático.'],
  ['ipam', 'Endereços IP e CGNAT', 'IP fixo pelo RADIUS, plano de CGNAT e rastreio. CGNAT validado só em laboratório.'],
  ['olt', 'OLT e ONUs', 'Autorização de ONU pelo painel. O driver Huawei NÃO foi homologado em equipamento real.'],
];

function Modules({ tenant, onDone, onCancel }: { tenant: any; onDone: () => void; onCancel: () => void }) {
  const [on, setOn] = useState<string[]>(tenant.modules ?? []);
  return (
    <Form onCancel={onCancel} onSubmit={async () => { await api(`/tenants/${tenant.id}`, { method: 'PATCH', body: { modules: on } }); onDone(); }}>
      <p className="small muted" style={{ marginTop: 0 }}>Cadastro, contratos, acesso PPPoE, financeiro, portal, importação, auditoria e agentes estão sempre disponíveis.
        O que está abaixo só aparece para o provedor, e só é aceito pelo servidor, depois de liberado aqui.</p>
      {MODULES.map(([id, name, hint]) => (
        <label key={id} className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap', margin: '8px 0' }}>
          <input type="checkbox" style={{ width: 'auto', marginTop: 4 }} checked={on.includes(id)} onChange={(e) => setOn(e.target.checked ? [...on, id] : on.filter((x) => x !== id))} />
          <span><b>{name}</b><span className="small muted" style={{ display: 'block' }}>{hint}</span></span>
        </label>
      ))}
    </Form>
  );
}

export function Tenants() {
  const { reload: reloadMe } = useMe();
  const nav = useNavigate();
  const { data, loading, error, reload } = useLoad<any[]>('/tenants');
  const [creating, setCreating] = useState(false);
  const [support, setSupport] = useState<any>(null);
  const [mods, setMods] = useState<any>(null);
  const [reason, setReason] = useState('');
  const blank = { name: '', slug: '', admin_name: '', admin_email: '', admin_password: '' };
  const [f, setF] = useState(blank);
  const inp = (k: keyof typeof blank, props: any = {}) => <input value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} required {...props} />;
  return (
    <Page title="Provedores" actions={<button className="primary" onClick={() => setCreating(true)}>Novo provedor</button>}>
      <State loading={loading} error={error} empty={data?.length === 0}>
        <table>
          <thead><tr><th>Provedor</th><th>Identificador</th><th className="num">Usuários</th><th>Desde</th><th>Agentes</th><th>Operações</th><th>Módulos</th><th>Situação</th><th></th></tr></thead>
          <tbody>{data?.map((t) => (
            <tr key={t.id}>
              <td>{t.name}</td><td className="mono">{t.slug}</td><td className="num">{t.users}</td><td>{d(t.created_at)}</td>
              <td>{t.agents ? (t.agents_offline > 0 ? <Badge tone="red">{t.agents_offline} de {t.agents} offline</Badge> : <Badge tone="green">{t.agents} online</Badge>) : <span className="muted">—</span>}</td>
              <td>{t.uncertain > 0 && <Badge tone="amber">{t.uncertain} incerta(s)</Badge>} {t.failed_recent > 0 && <Badge tone="red">{t.failed_recent} falha(s) 7d</Badge>}{!t.uncertain && !t.failed_recent && <span className="muted">ok</span>}</td>
              <td className="small">{t.modules.length ? `${t.modules.length} de ${MODULES.length}` : 'só o núcleo'}</td>
              <td>{t.status === 'active' ? <Badge tone="green">Ativo</Badge> : <Badge tone="red">Suspenso</Badge>}</td>
              <td><div className="row" style={{ justifyContent: 'flex-end' }}>
                <button className="sm" onClick={() => setMods(t)}>Módulos</button>
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
      {mods && <Modal title={`Módulos liberados — ${mods.name}`} onClose={() => setMods(null)}><Modules tenant={mods} onCancel={() => setMods(null)} onDone={() => { setMods(null); reload(); }} /></Modal>}
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
