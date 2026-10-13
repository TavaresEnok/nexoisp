import { MacBinding } from './Extras';
import { useState, type ReactNode } from 'react';
import { ago, api, dt, useLoad } from '../api';
import { can, useMe } from '../App';
import { ActionButton, Badge, Card, Field, Form, Modal, State } from '../ui';

export const OP_STATUS: Record<string, [string, 'gray' | 'green' | 'red' | 'amber' | 'blue']> = {
  PENDING: ['Aguardando agente', 'blue'], RESERVED: ['Reservada pelo agente', 'blue'], EXECUTING: ['Executando', 'blue'], VERIFYING: ['Verificando', 'blue'],
  UNCERTAIN: ['Incerta — verificar antes de repetir', 'amber'], SUCCEEDED: ['Concluída', 'green'], SUPERSEDED: ['Substituída', 'gray'],
  CANCELED: ['Cancelada', 'gray'], EXPIRED: ['Expirada', 'red'], FAILED: ['Falhou', 'red'],
};
export const ACTION: Record<string, string> = { 'subscriber.provision': 'Provisionar', 'subscriber.suspend': 'Suspender', 'subscriber.resume': 'Reativar',
  'onu.authorize': 'Autorizar ONU', 'onu.deauthorize': 'Desautorizar ONU' };
const POLICY: Record<string, [string, 'green' | 'red' | 'gray']> = { active: ['Liberado', 'green'], suspended: ['Suspenso', 'red'], absent: ['Sem autorização local', 'gray'] };
const STALE_S = 600; // o agente reenvia tudo a cada 5 min (e mudanças na hora)

export const OpBadge = ({ status }: { status: string }) => <Badge tone={OP_STATUS[status]?.[1]}>{OP_STATUS[status]?.[0] ?? status}</Badge>;
export const SimBadge = () => <Badge tone="amber">SIMULADO</Badge>;

export function OperationModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { data: o, loading, error } = useLoad<any>(`/operations/${id}`, 3000);
  return (
    <Modal title="Operação de rede" onClose={onClose} wide>
      <State loading={loading} error={error}>
        {o && (<>
          <div className="row" style={{ marginBottom: 8 }}>
            <b>{ACTION[o.action]}</b> <OpBadge status={o.status} /> <span className="muted small">intenção v{o.desired_version} · {o.attempts} tentativa(s) · criada {dt(o.created_at)}</span>
          </div>
          {o.reason && <div className="small">Motivo: {o.reason}</div>}
          {o.note && <div className="small muted">Nota: {o.note}</div>}
          <div className="small muted mono">id {o.id} · chave {o.idempotency_key} · válida até {dt(o.valid_until)}</div>
          {o.attempt_list.map((a: any, i: number) => (
            <Card key={a.id} title={<>Tentativa {i + 1} {a.recover && <Badge tone="amber">recuperação</Badge>} <Badge>{a.status}</Badge></>}>
              <div className="small muted">início {dt(a.started_at)} · fim {dt(a.finished_at)}</div>
              <ul className="steps">
                {a.steps.map((s: any, j: number) => (
                  <li key={j}>
                    <Badge tone={s.status === 'ok' ? 'green' : s.status === 'falha' ? 'red' : s.status === 'incerto' ? 'amber' : 'gray'}>{s.status}</Badge>
                    <span><b>{s.name}</b>{s.detail && <span className="muted small mono"> — {typeof s.detail === 'string' ? s.detail : JSON.stringify(s.detail)}</span>}</span>
                  </li>
                ))}
                {a.steps.length === 0 && <li className="muted small">sem etapas registradas</li>}
              </ul>
            </Card>
          ))}
          {o.result?.observed && <><div className="small muted">Estado lido ao final:</div><pre className="ev">{JSON.stringify(o.result.observed, null, 2)}</pre></>}
        </>)}
      </State>
    </Modal>
  );
}

function ProvisionForm({ contractId, onDone }: { contractId: string; onDone: (pw: string | null) => void }) {
  const devices = useLoad<any[]>('/devices');
  const [f, setF] = useState({ device_id: '', pppoe_username: '', password: '' });
  return (
    <Form submit="Provisionar acesso" onSubmit={async () => {
      const r = await api(`/contracts/${contractId}/service`, { body: { device_id: f.device_id, pppoe_username: f.pppoe_username, ...(f.password ? { password: f.password } : {}) } });
      onDone(r.generated_password);
    }}>
      <State loading={devices.loading} error={devices.error}>
        {devices.data?.length === 0 && <div className="state">Cadastre um equipamento em Rede antes de provisionar.</div>}
        <div className="cols3">
          <Field label="Equipamento (NAS)">
            <select required value={f.device_id} onChange={(e) => setF({ ...f, device_id: e.target.value })}>
              <option value="">Selecione…</option>
              {devices.data?.filter((d) => !d.driver.startsWith('olt')).map((d) => <option key={d.id} value={d.id}>{d.name}{d.driver === 'demo' ? ' — simulado' : ''}</option>)}
            </select>
          </Field>
          <Field label="Usuário PPPoE"><input required value={f.pppoe_username} onChange={(e) => setF({ ...f, pppoe_username: e.target.value })} /></Field>
          <Field label="Senha PPPoE" hint="Em branco: gerada automaticamente."><input value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="off" /></Field>
        </div>
      </State>
    </Form>
  );
}

/** As cinco informações separadas do serviço: comercial, financeira, desejada, observada e operação. */
/** Uma frase dizendo o que fazer agora com este acesso, a partir do que já está na tela. A ordem é a da urgência. */
function nextStep(contract: any, r: any, ops: any[], fin: { overdue: number } | undefined, stale: boolean): { tone: 'green' | 'red' | 'amber' | 'blue' | 'gray'; text: string } {
  const last = ops[0];
  if (!r) return contract.status === 'active' ? { tone: 'blue', text: 'Provisione o acesso PPPoE para o assinante poder navegar.' } : { tone: 'gray', text: 'Contrato encerrado, sem acesso provisionado. Nada a fazer.' };
  if (ops.some((o) => o.status === 'UNCERTAIN')) return { tone: 'red', text: 'Aguarde: o agente precisa verificar o que foi aplicado na última operação. Não repita manualmente.' };
  if (!r.agent_online) return { tone: 'red', text: 'Verifique o agente do provedor: sem ele nenhuma alteração chega ao equipamento. Quem já está autorizado continua autenticando.' };
  if (ops.some((o) => ['PENDING', 'RESERVED', 'EXECUTING', 'VERIFYING'].includes(o.status))) return { tone: 'blue', text: 'Alteração em andamento. Aguarde a confirmação do equipamento.' };
  if (last && ['FAILED', 'EXPIRED'].includes(last.status)) return { tone: 'amber', text: 'A última operação não foi concluída. Veja as evidências e use “Reaplicar”.' };
  if (r.desired_version === 0) return { tone: 'blue', text: 'Conta importada: use “Provisionar” para enviá-la ao equipamento.' };
  if (r.drift) return { tone: 'amber', text: 'O que está no equipamento difere do que foi pedido. Use “Reaplicar” ou ajuste a intenção.' };
  if (r.desired_policy === 'suspended') {
    if (contract.status !== 'active') return { tone: 'gray', text: 'Contrato encerrado e acesso suspenso. Nada a fazer.' };
    return fin?.overdue ? { tone: 'amber', text: `Acesso suspenso. Há ${fin.overdue} fatura(s) vencida(s): reative depois do pagamento.` }
      : { tone: 'amber', text: 'Acesso suspenso e sem fatura vencida visível. Reative se a suspensão não for mais necessária.' };
  }
  const ses = r.observed_session;
  if (!r.observed_at) return { tone: 'blue', text: 'Aguardando a primeira leitura do equipamento.' };
  if (ses?.unknown) return { tone: 'amber', text: 'A autorização está correta, mas o concentrador não respondeu: não dá para saber se há sessão.' };
  if (stale) return { tone: 'amber', text: 'A leitura abaixo está desatualizada. Confira se o agente está relatando antes de concluir algo.' };
  if (ses?.online) return { tone: 'green', text: 'Nada a fazer: acesso liberado e sessão online.' };
  return { tone: 'blue', text: 'Acesso liberado, mas sem sessão. Verifique o equipamento do assinante: energia, cabo, usuário e senha PPPoE.' };
}

export function ServicePanel({ contract, financial, fin }: { contract: any; financial?: ReactNode; fin?: { overdue: number } }) {
  const { me } = useMe();
  const { data, loading, error, reload } = useLoad<any>(can(me, 'network:read') ? `/contracts/${contract.id}/service` : null, 3000);
  const [opId, setOpId] = useState<string | null>(null);
  const [generated, setGenerated] = useState<string | null>(null);
  const [newPw, setNewPw] = useState<string | null>(null);
  const operate = can(me, 'network:operate');
  if (!can(me, 'network:read')) return null;
  const r = data?.resource;
  const last = data?.operations?.[0];
  const act = (action: string, reason?: string) => async () => { await api(`/resources/${r.id}/${action}`, { body: { reason } }); await reload(); };
  const stale = r?.observed_at && (Date.now() - new Date(r.observed_at).getTime()) / 1000 > STALE_S;
  const sim = r?.driver === 'demo';

  return (
    <Card tone={sim ? 'demo' : ''} title={<>Acesso PPPoE {sim && <SimBadge />}</>} actions={r && operate && <>
      {r.desired_policy === 'active'
        ? <ActionButton className="danger" confirm="Suspender o acesso deste contrato?" onClick={act('suspend', 'suspensão manual')}>Suspender</ActionButton>
        : <ActionButton className="primary" disabled={contract.status !== 'active'} onClick={act('resume', 'reativação manual')}>Reativar</ActionButton>}
      <ActionButton className={r.desired_version === 0 ? 'primary' : ''} title="Cria nova operação com a intenção atual" disabled={contract.status !== 'active' || r.desired_policy !== 'active' || !r.has_secret}
        onClick={act('provision', r.desired_version === 0 ? 'provisionamento de conta importada' : 'reaplicar intenção')}>{r.desired_version === 0 ? 'Provisionar' : 'Reaplicar'}</ActionButton>
      <button onClick={() => setNewPw('')}>Trocar senha</button>
    </>}>
      <State loading={loading && !data} error={error}>
        {data && !r && <div className="next"><Badge tone={nextStep(contract, null, [], fin, false).tone}>Próxima ação</Badge> <span>{nextStep(contract, null, [], fin, false).text}</span></div>}
        {data && !r && (contract.status !== 'active'
          ? <div className="state">Contrato encerrado sem acesso provisionado.</div>
          : operate ? <ProvisionForm contractId={contract.id} onDone={(pw) => { setGenerated(pw); reload(); }} />
            : <div className="state">Acesso ainda não provisionado.</div>)}
        {r && (<>
          {sim && <p className="small muted" style={{ marginTop: 0 }}>Equipamento com driver de demonstração: nenhuma rede real é alterada e a sessão exibida é fictícia.</p>}
          {generated && (
            <div className="state" style={{ background: 'var(--green-bg)', color: 'var(--green)', borderRadius: 8, textAlign: 'left' }}>
              Senha PPPoE gerada (exibida somente agora): <b className="mono">{generated}</b> <button className="sm" onClick={() => setGenerated(null)}>ok, anotei</button>
            </div>
          )}
          {r.desired_version === 0 && <div className="state" style={{ background: 'var(--blue-bg)', color: 'var(--blue)', borderRadius: 8, textAlign: 'left', marginBottom: 8 }}>Conta importada, ainda não enviada ao equipamento.{!r.has_secret && ' Sem senha PPPoE: use “Trocar senha” para informar a credencial antes de provisionar.'}</div>}
          {r.drift && <div className="state err">Divergência: o estado lido no equipamento difere da intenção e não há operação em andamento (possível alteração manual externa). Nada foi corrigido automaticamente — use “Reaplicar” ou ajuste a intenção.</div>}
          {!r.agent_online && <div className="state err">Agente {r.agent_name ? `“${r.agent_name}” ` : ''}offline (último contato {ago(r.agent_last_seen)}). Novas operações aguardam; a autenticação local segue com a última política conhecida.</div>}
          {r.maintenance && <div className="state err">Equipamento em modo manutenção: o ERP não envia escritas.</div>}
          {(() => { const n = nextStep(contract, r, data.operations, fin, !!stale); return <div className="next"><Badge tone={n.tone}>Próxima ação</Badge> <span>{n.text}</span></div>; })()}
          <div className="five">
            <Card title="Comercial">
              {contract.status === 'active' ? <Badge tone="green">Contrato vigente</Badge> : <Badge>Contrato encerrado</Badge>}
              <div className="small muted">{contract.plan_name} v{contract.plan_version}</div>
            </Card>
            <Card title="Financeira">{financial ?? <span className="muted small">sem cobranças</span>}</Card>
            <Card title="Desejada">
              <Badge tone={POLICY[r.desired_policy][1]}>{POLICY[r.desired_policy][0]}</Badge>
              <div className="small">perfil <span className="mono">{r.desired_profile}</span></div>
              <div className="small muted">versão {r.desired_version} · {dt(r.desired_at)}</div>
              {r.desired_reason && <div className="small muted">{r.desired_reason}</div>}
            </Card>
            <Card title="Observada">
              {r.observed_at ? (<>
                <Badge tone={POLICY[r.observed_policy][1]}>{POLICY[r.observed_policy][0]}</Badge> {stale && <Badge tone="amber">desatualizada</Badge>}
                <div className="small">perfil <span className="mono">{r.observed_profile ?? '—'}</span></div>
                <div className="small">{r.observed_session?.online ? <>sessão online · <span className="mono">{r.observed_session.ip}</span></> : r.observed_session?.unknown ? <b>sessão desconhecida: o concentrador não respondeu</b> : 'sem sessão'}</div>
                <div className="small muted">lida {ago(r.observed_at)} ({dt(r.observed_at)})</div>
              </>) : <span className="muted small">ainda não observada</span>}
            </Card>
            <Card title="Operação">
              {last ? (<>
                <OpBadge status={last.status} />
                <div className="small">{ACTION[last.action]} · v{last.desired_version}</div>
                <div className="small muted">{ago(last.updated_at)}</div>
                {r.desired_version !== r.observed_version && ['SUCCEEDED', 'SUPERSEDED'].includes(last.status) === false && <div className="small muted">mudança pendente de confirmação técnica</div>}
              </>) : <span className="muted small">nenhuma</span>}
            </Card>
          </div>
          <div className="small muted" style={{ margin: '10px 0 6px' }}>
            Usuário PPPoE <b className="mono">{r.pppoe_username}</b> · equipamento {r.device_name} · agente {r.agent_name ?? '—'} {r.agent_online ? <Badge tone="green">online</Badge> : <Badge tone="red">offline</Badge>}
          </div>
          <MacBinding resource={r} onChange={reload} />
          <table>
            <thead><tr><th>Solicitada</th><th>Ação</th><th>Versão</th><th>Situação</th><th>Motivo / nota</th><th>Por</th><th></th></tr></thead>
            <tbody>{data.operations.map((o: any) => (
              <tr key={o.id}>
                <td>{dt(o.created_at)}</td><td>{ACTION[o.action]}</td><td>v{o.desired_version}</td><td><OpBadge status={o.status} /></td>
                <td className="small">{o.reason}{o.note && <span className="muted"> — {o.note}</span>}</td>
                <td className="small">{o.requested_by ?? (o.authorization_ref?.type === 'system' ? 'rotina automática' : '—')}</td>
                <td><button className="sm" onClick={() => setOpId(o.id)}>evidências</button></td>
              </tr>
            ))}</tbody>
          </table>
        </>)}
      </State>
      {opId && <OperationModal id={opId} onClose={() => setOpId(null)} />}
      {newPw !== null && r && (
        <Modal title="Trocar senha PPPoE" onClose={() => setNewPw(null)}>
          <Form submit="Trocar e reaplicar" onCancel={() => setNewPw(null)} onSubmit={async () => { await api(`/resources/${r.id}/secret`, { method: 'PATCH', body: { password: newPw } }); setNewPw(null); reload(); }}>
            <Field label="Nova senha PPPoE" hint="Mínimo de 6 caracteres. A alteração gera uma operação de provisionamento."><input value={newPw} onChange={(e) => setNewPw(e.target.value)} minLength={6} required autoComplete="off" /></Field>
          </Form>
        </Modal>
      )}
    </Card>
  );
}
