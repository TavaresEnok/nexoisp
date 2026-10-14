import { useState } from 'react';
import { api, ago, useLoad } from '../api';
import { ActionButton, Badge, Card, Field, Form, Modal, State, toast } from '../ui';

export const VENDOR: Record<string, string> = { mikrotik: 'MikroTik', huawei: 'Huawei (NE/ME)', cisco: 'Cisco', generic: 'Outro (RADIUS padrão)' };

/** Bloco com o segredo e os comandos para colar no concentrador. O segredo só existe nesta tela, logo após criar ou trocar. */
function Setup({ data, onClose }: { data: any; onClose: () => void }) {
  const s = data.setup;
  return (
    <Modal title="Configure o concentrador" onClose={onClose} wide>
      {data.secret && (<>
        <p><b>Segredo do concentrador</b> — copie agora: não será mostrado de novo.</p>
        <input readOnly className="mono" value={data.secret} aria-label="Segredo" onFocus={(e) => e.currentTarget.select()} />
      </>)}
      {!s.host_configured && <div className="state" style={{ textAlign: 'left' }}>O endereço público deste servidor ainda não foi informado na instalação; troque <span className="mono">{s.server_host}</span> pelo endereço pelo qual o concentrador alcança o NexoISP.</div>}
      {!s.validated && <div className="state" style={{ textAlign: 'left' }}><b>Atenção:</b> {VENDOR[s.vendor]} ainda não foi testado por nós em equipamento. Os comandos seguem a documentação do fabricante; confira antes de aplicar em produção.</div>}
      <p className="small muted">Servidor <span className="mono">{s.server_host}</span> · autenticação {s.auth_port}/UDP · accounting {s.acct_port}/UDP · desconexão {s.coa_port}/UDP (do servidor para o concentrador).</p>
      <Field label="Comandos"><textarea readOnly rows={Math.min(16, s.commands.split('\n').length + 1)} className="mono" value={s.commands} onFocus={(e) => e.currentTarget.select()} /></Field>
      <div className="row">
        <button onClick={() => { navigator.clipboard?.writeText(s.commands); toast('Comandos copiados.'); }}>Copiar comandos</button>
        <button className="primary" onClick={onClose}>{data.secret ? 'Já guardei o segredo' : 'Fechar'}</button>
      </div>
    </Modal>
  );
}

/** Concentradores que autenticam direto no NexoISP: nada a instalar no provedor. */
export function Concentradores({ devices, reload, canWrite }: { devices: any[]; reload: () => void; canWrite: boolean }) {
  const st = useLoad<any>('/radius/status');
  const [f, setF] = useState<any>(null);
  const [shown, setShown] = useState<any>(null);
  const [conv, setConv] = useState<any>(null);
  const [par, setPar] = useState<any>(null);
  const mine = devices.filter((d) => d.driver === 'radius');
  const legacy = devices.filter((d) => d.driver === 'mikrotik_radius' || d.driver === 'demo');
  const enabled = st.data?.enabled;
  return (
    <Card title="Concentradores" actions={canWrite && enabled && <button className="primary" onClick={() => setF({ name: '', vendor: 'mikrotik', nas_ip: '', coa_port: '3799' })}>Novo concentrador</button>}>
      <p className="small muted">A autenticação dos assinantes é feita pelo próprio NexoISP: cadastre o concentrador aqui e aponte o equipamento para o sistema. Não há nada para instalar na sua rede.</p>
      {st.data && !enabled && <div className="state" style={{ textAlign: 'left' }}>A autenticação integrada ainda não foi habilitada nesta instalação.</div>}
      <State empty={mine.length === 0} emptyText="Nenhum concentrador cadastrado.">
        <table>
          <thead><tr><th>Concentrador</th><th>Fabricante</th><th>Endereço de origem</th><th>Comunicação</th><th className="num">Contas</th><th></th></tr></thead>
          <tbody>{mine.map((d) => (
            <tr key={d.id}>
              <td>{d.name} {d.maintenance && <Badge tone="amber">manutenção</Badge>}</td>
              <td>{VENDOR[d.vendor]} {d.vendor !== 'mikrotik' && <Badge tone="amber">não homologado</Badge>}</td>
              <td className="mono">{d.nas_ip}</td>
              <td>{d.last_check ? <>{d.last_check.ok ? <Badge tone="green">ok</Badge> : <Badge tone="red">sem pacotes recentes</Badge>} <span className="small muted">{ago(d.last_check_at)}</span><div className="small muted">{d.last_check.detail}</div></> : <span className="muted">aguardando</span>}</td>
              <td className="num">{d.accounts}</td>
              <td>{canWrite && <div className="row" style={{ justifyContent: 'flex-end' }}>
                <button className="sm" onClick={async () => setShown(await api(`/radius/devices/${d.id}/setup`))}>Instruções</button>
                <button className="sm" onClick={() => setPar({ id: d.id, name: d.name, simultaneous_use: d.simultaneous_use ?? '', acct_interim_seconds: d.acct_interim_seconds ?? '' })}>Parâmetros</button>
                <ActionButton className="sm" confirm="Gerar um segredo novo? O atual deixa de valer em até 2 minutos e precisa ser trocado também no concentrador; enquanto diferirem, ninguém autentica."
                  onClick={async () => setShown(await api(`/radius/devices/${d.id}/secret`, { method: 'POST' }))}>Trocar segredo</ActionButton>
                {d.accounts > 0 && <ActionButton className="sm" confirm={`Reenviar a autorização de todas as contas (${d.accounts})?`}
                  onClick={async () => { const r = await api<any>(`/devices/${d.id}/reapply`, { method: 'POST' }); toast(`${r.requested} operação(ões) solicitada(s).`); }}>Reaplicar contas</ActionButton>}
              </div>}</td>
            </tr>
          ))}</tbody>
        </table>
      </State>
      {canWrite && enabled && legacy.length > 0 && (
        <p className="small" style={{ marginTop: 8 }}>
          {legacy.length} equipamento(s) ainda usam agente local.{' '}
          {legacy.map((d) => <button key={d.id} className="sm" style={{ marginRight: 6 }} onClick={() => setConv({ id: d.id, name: d.name, vendor: 'mikrotik', nas_ip: d.host ?? '', accounts: d.accounts })}>Passar “{d.name}” para cá</button>)}
        </p>
      )}
      {f && (
        <Modal title="Novo concentrador" onClose={() => setF(null)}>
          <Form submit="Cadastrar" onCancel={() => setF(null)} onSubmit={async () => {
            const r = await api<any>('/radius/devices', { body: { name: f.name, vendor: f.vendor, nas_ip: f.nas_ip, coa_port: Number(f.coa_port) || 3799 } });
            setF(null); setShown(r); reload();
          }}>
            <Field label="Nome"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required minLength={2} autoFocus /></Field>
            <Field label="Fabricante" hint="Define como o plano (perfil, velocidade, pool) é enviado ao equipamento.">
              <select value={f.vendor} onChange={(e) => setF({ ...f, vendor: e.target.value })}>{Object.entries(VENDOR).map(([k, v]) => <option key={k} value={k}>{v}{k === 'mikrotik' ? '' : ' — não homologado'}</option>)}</select></Field>
            <Field label="Endereço de origem do concentrador" hint="O IP com que os pacotes dele chegam ao NexoISP (o IP público ou o do túnel). É por ele que o sistema reconhece o equipamento.">
              <input className="mono" value={f.nas_ip} onChange={(e) => setF({ ...f, nas_ip: e.target.value })} required placeholder="203.0.113.10" /></Field>
            <Field label="Porta de desconexão no concentrador" hint="Padrão 3799."><input type="number" min="1" max="65535" value={f.coa_port} onChange={(e) => setF({ ...f, coa_port: e.target.value })} /></Field>
          </Form>
        </Modal>
      )}
      {conv && (
        <Modal title={`Passar “${conv.name}” para a autenticação integrada`} onClose={() => setConv(null)}>
          <Form submit="Converter" onCancel={() => setConv(null)} onSubmit={async () => {
            const r = await api<any>(`/devices/${conv.id}/convert-to-integrated`, { body: { vendor: conv.vendor, nas_ip: conv.nas_ip } });
            setConv(null); setShown(r); reload();
            toast(`${r.accounts_requested} conta(s) reenviada(s)${r.accounts_without_secret ? `; ${r.accounts_without_secret} sem senha cadastrada ficaram de fora` : ''}.`);
          }}>
            <p className="small">As {conv.accounts} conta(s) deste equipamento passam a ser respondidas pelo NexoISP. Quem está conectado continua conectado; a troca só vale quando o concentrador for apontado para o sistema (comandos na próxima tela). O agente local deixa de ser usado por este equipamento.</p>
            <Field label="Fabricante"><select value={conv.vendor} onChange={(e) => setConv({ ...conv, vendor: e.target.value })}>{Object.entries(VENDOR).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
            <Field label="Endereço de origem do concentrador"><input className="mono" value={conv.nas_ip} onChange={(e) => setConv({ ...conv, nas_ip: e.target.value })} required /></Field>
          </Form>
        </Modal>
      )}
      {par && (
        <Modal title={`Parâmetros — ${par.name}`} onClose={() => setPar(null)}>
          <Form submit="Salvar" onCancel={() => setPar(null)} onSubmit={async () => {
            await api(`/devices/${par.id}`, { method: 'PATCH', body: { simultaneous_use: par.simultaneous_use === '' ? null : Number(par.simultaneous_use),
              acct_interim_seconds: par.acct_interim_seconds === '' ? null : Number(par.acct_interim_seconds) } });
            setPar(null); reload();
          }}>
            <p className="small muted">Valem na próxima autorização de cada conta (use "Reaplicar contas"). Vazio = não enviar.</p>
            <Field label="Uso simultâneo por login" hint="1 impede duas sessões com o mesmo login. Se o concentrador cair sem avisar, a sessão antiga pode ficar registrada como aberta e impedir a reconexão até ser encerrada."><input type="number" min="1" max="10" value={par.simultaneous_use} onChange={(e) => setPar({ ...par, simultaneous_use: e.target.value })} /></Field>
            <Field label="Intervalo de atualização de consumo (segundos)" hint="De 60 a 3600."><input type="number" min="60" max="3600" value={par.acct_interim_seconds} onChange={(e) => setPar({ ...par, acct_interim_seconds: e.target.value })} /></Field>
          </Form>
        </Modal>
      )}
      {shown && <Setup data={shown} onClose={() => setShown(null)} />}
    </Card>
  );
}

/** Últimas tentativas de autenticação do contrato (aceitas e recusadas). Só existe para contas na autenticação integrada. */
export function AuthLog({ contractId }: { contractId: string }) {
  const { data } = useLoad<any>(`/contracts/${contractId}/radius-log`, 20000);
  if (!data?.integrated) return null;
  return (
    <Card title="Tentativas de autenticação">
      <State empty={data.rows.length === 0} emptyText="Nenhuma tentativa registrada ainda.">
        <table><thead><tr><th>Quando</th><th>Resultado</th><th>MAC apresentado</th><th>Concentrador</th></tr></thead>
          <tbody>{data.rows.map((r: any, i: number) => (
            <tr key={i}><td className="small">{new Date(r.at).toLocaleString('pt-BR')}</td>
              <td>{r.reply === 'Access-Accept' ? <Badge tone="green">aceita</Badge> : <Badge tone="red">recusada</Badge>}</td>
              <td className="mono small">{r.calling_station ?? '—'}</td><td className="mono small">{r.nas_ip}</td></tr>
          ))}</tbody></table>
      </State>
    </Card>
  );
}
