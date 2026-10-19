import { useState } from 'react';
import { api, dt, useLoad } from '../api';
import { ActionButton, Badge, Card, Field, Form, Page, State } from '../ui';

const STATUS: Record<string, [string, 'green' | 'red' | 'amber' | undefined]> = {
  sent: ['Enviado', 'green'], failed: ['Falhou', 'red'], skipped_no_consent: ['Sem consentimento', 'amber'], queued: ['Na fila', undefined], sending: ['Enviando', undefined], uncertain: ['Resultado desconhecido', 'amber'], test: ['Teste', undefined],
};
const REL = (n: number) => (n < 0 ? `${-n} dia(s) antes do vencimento` : n === 0 ? 'no dia do vencimento' : `${n} dia(s) depois do vencimento`);

/** Avisos ao assinante: só de saída (cobrança, manutenção, OS). Não há caixa de entrada nem conversa. */
export function AvisosAssinante() {
  const [tab, setTab] = useState<'regras' | 'modelos' | 'canais' | 'log'>('regras');
  const channels = useLoad<any[]>('/notice-channels');
  const templates = useLoad<any>('/notice-templates');
  const rules = useLoad<any[]>('/notice-rules');
  const log = useLoad<any[]>(tab === 'log' ? '/notice-log' : null, 15000);
  const plans = useLoad<any[]>('/plans');
  const [f, setF] = useState<any>(null);
  const [run, setRun] = useState<any>(null);
  const [testing, setTesting] = useState<any>(null);
  const tabs: [typeof tab, string][] = [['regras', 'Régua'], ['modelos', 'Modelos'], ['canais', 'Canais de envio'], ['log', 'Histórico']];
  return (
    <Page title="Avisos ao assinante" actions={tab === 'regras' && <ActionButton confirm="Rodar a régua agora? Respeita janela, consentimento e uma vez por título." onClick={async () => { setRun(await api('/notice-rules/run', { method: 'POST' })); rules.reload(); }}>Rodar agora</ActionButton>}>
      <p className="muted small">Mensagens de <b>saída</b> (cobrança, manutenção, OS). Só vão para contatos com <b>consentimento</b> registrado na ficha do assinante. O NexoISP não recebe respostas.</p>
      {run && <div className="state">Rodada: {run.sent} enviado(s), {run.failed} falha(s), {run.skipped} sem consentimento.</div>}
      <div className="row" role="tablist" style={{ marginBottom: 10 }}>
        {tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'primary' : ''} onClick={() => { setTab(k); setF(null); }}>{l}</button>)}
      </div>

      {tab === 'canais' && (<>
        <div className="row" style={{ marginBottom: 8 }}><button className="primary" onClick={() => setF({ name: '', url: '', phone_field: 'to', message_field: 'message', auth: '' })}>Novo canal</button></div>
        {f && (
          <Card title="Novo canal de envio">
            <Form submit="Salvar canal" onCancel={() => setF(null)} onSubmit={async () => {
              await api('/notice-channels', { body: { name: f.name, url: f.url, phone_field: f.phone_field, message_field: f.message_field, headers: f.auth ? { Authorization: f.auth } : {} } });
              setF(null); channels.reload();
            }}>
              <Field label="Nome"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></Field>
              <Field label="Endereço do provedor de envio (HTTPS)" hint="O NexoISP faz um POST JSON com o telefone e a mensagem nos campos abaixo."><input value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} required type="url" /></Field>
              <div className="cols3">
                <Field label="Campo do telefone"><input value={f.phone_field} onChange={(e) => setF({ ...f, phone_field: e.target.value })} required /></Field>
                <Field label="Campo da mensagem"><input value={f.message_field} onChange={(e) => setF({ ...f, message_field: e.target.value })} required /></Field>
              </div>
              <Field label="Cabeçalho Authorization (opcional)" hint="Guardado cifrado; nunca aparece de novo."><input type="password" autoComplete="off" value={f.auth} onChange={(e) => setF({ ...f, auth: e.target.value })} /></Field>
            </Form>
          </Card>
        )}
        <State loading={channels.loading && !channels.data} error={channels.error} empty={channels.data?.length === 0}>
          <table><thead><tr><th>Canal</th><th>Endereço</th><th>Situação</th><th></th></tr></thead>
            <tbody>{channels.data?.map((c) => (
              <tr key={c.id}><td>{c.name}</td><td className="mono small">{c.url}</td><td>{c.active ? <Badge tone="green">ativo</Badge> : <Badge>inativo</Badge>}{c.has_headers && <> <Badge>com autenticação</Badge></>}</td>
                <td><div className="row" style={{ justifyContent: 'flex-end' }}>
                  <button className="sm" onClick={() => setTesting({ id: c.id, phone: '', message: 'Teste de aviso do NexoISP.' })}>Enviar teste</button>
                  <ActionButton className="sm" onClick={async () => { await api(`/notice-channels/${c.id}`, { method: 'PATCH', body: { active: !c.active } }); channels.reload(); }}>{c.active ? 'Desativar' : 'Ativar'}</ActionButton>
                  <ActionButton className="sm danger" confirm="Excluir este canal?" onClick={async () => { await api(`/notice-channels/${c.id}`, { method: 'DELETE' }); channels.reload(); }}>Excluir</ActionButton>
                </div></td></tr>
            ))}</tbody></table>
        </State>
        {testing && (
          <Card title="Enviar teste">
            <Form submit="Enviar" onCancel={() => setTesting(null)} onSubmit={async () => { await api(`/notice-channels/${testing.id}/test`, { body: { phone: testing.phone, message: testing.message } }); setTesting(null); }}>
              <Field label="Telefone de destino"><input value={testing.phone} onChange={(e) => setTesting({ ...testing, phone: e.target.value })} required minLength={8} /></Field>
              <Field label="Mensagem"><input value={testing.message} onChange={(e) => setTesting({ ...testing, message: e.target.value })} required /></Field>
            </Form>
          </Card>
        )}
      </>)}

      {tab === 'modelos' && (<>
        <div className="row" style={{ marginBottom: 8 }}><button className="primary" onClick={() => setF({ name: '', body: 'Olá {nome}, sua fatura de {valor} vence em {vencimento}.' })}>Novo modelo</button></div>
        {f && (
          <Card title="Novo modelo">
            <Form submit="Salvar modelo" onCancel={() => setF(null)} onSubmit={async () => { await api('/notice-templates', { body: f }); setF(null); templates.reload(); }}>
              <Field label="Nome"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></Field>
              <Field label="Mensagem" hint={`Variáveis: ${(templates.data?.variables ?? []).map((v: string) => `{${v}}`).join(' ')}`}>
                <textarea rows={3} value={f.body} maxLength={480} onChange={(e) => setF({ ...f, body: e.target.value })} required /></Field>
            </Form>
          </Card>
        )}
        <State loading={templates.loading && !templates.data} error={templates.error} empty={templates.data?.rows.length === 0}>
          <table><tbody>{templates.data?.rows.map((t: any) => (
            <tr key={t.id}><td><b>{t.name}</b><div className="small muted">{t.body}</div><div className="small">Prévia: {t.preview}</div></td>
              <td><ActionButton className="sm danger" confirm="Excluir este modelo?" onClick={async () => { await api(`/notice-templates/${t.id}`, { method: 'DELETE' }); templates.reload(); }}>Excluir</ActionButton></td></tr>
          ))}</tbody></table>
        </State>
      </>)}

      {tab === 'regras' && (<>
        <div className="row" style={{ marginBottom: 8 }}>
          <button className="primary" disabled={!channels.data?.length || !templates.data?.rows.length}
            onClick={() => setF({ name: '', template_id: templates.data.rows[0].id, channel_id: channels.data![0].id, days_relative: -3, plan_id: '', hour_from: 8, hour_to: 20 })}>Nova regra</button>
          {(!channels.data?.length || !templates.data?.rows.length) && <span className="small muted">Cadastre ao menos um canal e um modelo.</span>}
        </div>
        {f && (
          <Card title="Nova regra">
            <Form submit="Salvar regra" onCancel={() => setF(null)} onSubmit={async () => {
              await api('/notice-rules', { body: { name: f.name, template_id: f.template_id, channel_id: f.channel_id, days_relative: Number(f.days_relative),
                plan_id: f.plan_id || null, hour_from: Number(f.hour_from), hour_to: Number(f.hour_to) } });
              setF(null); rules.reload();
            }}>
              <Field label="Nome"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></Field>
              <div className="cols3">
                <Field label="Modelo"><select value={f.template_id} onChange={(e) => setF({ ...f, template_id: e.target.value })}>{templates.data?.rows.map((t: any) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
                <Field label="Canal"><select value={f.channel_id} onChange={(e) => setF({ ...f, channel_id: e.target.value })}>{channels.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
                <Field label="Plano (opcional)"><select value={f.plan_id} onChange={(e) => setF({ ...f, plan_id: e.target.value })}><option value="">Todos</option>{plans.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
              </div>
              <div className="cols3">
                <Field label="Dias em relação ao vencimento" hint="Negativo = antes; 0 = no dia; positivo = depois."><input type="number" min="-30" max="365" value={f.days_relative} onChange={(e) => setF({ ...f, days_relative: e.target.value })} required /></Field>
                <Field label="Enviar a partir das (h)"><input type="number" min="0" max="23" value={f.hour_from} onChange={(e) => setF({ ...f, hour_from: e.target.value })} /></Field>
                <Field label="Até as (h)"><input type="number" min="1" max="24" value={f.hour_to} onChange={(e) => setF({ ...f, hour_to: e.target.value })} /></Field>
              </div>
            </Form>
          </Card>
        )}
        <State loading={rules.loading && !rules.data} error={rules.error} empty={rules.data?.length === 0}>
          <table><thead><tr><th>Regra</th><th>Quando</th><th>Modelo / canal</th><th className="num">Enviados</th><th>Situação</th><th></th></tr></thead>
            <tbody>{rules.data?.map((r) => (
              <tr key={r.id}><td>{r.name}</td><td className="small">{REL(r.days_relative)}<div className="muted">{r.hour_from}h–{r.hour_to}h</div></td><td className="small">{r.template_name} · {r.channel_name}</td>
                <td className="num">{r.sent}</td><td>{r.active ? <Badge tone="green">ativa</Badge> : <Badge>pausada</Badge>}</td>
                <td><div className="row" style={{ justifyContent: 'flex-end' }}>
                  <ActionButton className="sm" onClick={async () => { await api(`/notice-rules/${r.id}`, { method: 'PATCH', body: { active: !r.active } }); rules.reload(); }}>{r.active ? 'Pausar' : 'Ativar'}</ActionButton>
                  <ActionButton className="sm danger" confirm="Excluir esta regra?" onClick={async () => { await api(`/notice-rules/${r.id}`, { method: 'DELETE' }); rules.reload(); }}>Excluir</ActionButton>
                </div></td></tr>
            ))}</tbody></table>
        </State>
      </>)}

      {tab === 'log' && (
        <State loading={log.loading && !log.data} error={log.error} empty={log.data?.length === 0}>
          <table><thead><tr><th>Quando</th><th>Assinante</th><th>Regra</th><th>Resultado</th></tr></thead>
            <tbody>{log.data?.map((l) => {
              const [label, tone] = STATUS[l.status] ?? [l.status, undefined];
              return <tr key={l.id}><td className="small">{dt(l.created_at)}</td><td>{l.subscriber_name ?? '—'}<div className="small muted mono">{l.contact_value ?? ''}</div></td>
                <td className="small">{l.rule_name ?? 'teste'}</td><td><Badge tone={tone}>{label}</Badge>{l.attempts > 1 && <span className="small muted"> · {l.attempts} tentativas</span>}{l.error && <div className="small muted">{l.error}</div>}</td></tr>;
            })}</tbody></table>
        </State>
      )}
    </Page>
  );
}
