import { useState } from 'react';
import { api, dt, useLoad } from '../api';
import { ActionButton, Badge, Card, Field, Form, Page, State } from '../ui';

const EVENT: Record<string, string> = { 'ticket.opened': 'Chamado pelo portal', 'ticket.subscriber_reply': 'Resposta do assinante', 'work_order.created': 'OS aberta', 'work_order.assigned': 'OS atribuída' };
const STATUS: Record<string, [string, 'gray' | 'green' | 'red' | 'amber']> = { pending: ['Pendente', 'amber'], sent: ['Entregue', 'green'], failed: ['Falhou', 'red'] };

/** Avisos ao provedor: um endereço de webhook (chat da equipe) recebe os fatos que pedem ação. */
export function Notices() {
  const { data, loading, error, reload } = useLoad<any>('/notifications', 10000);
  const [url, setUrl] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const value = url ?? data?.webhook_url ?? '';
  return (
    <Page title="Avisos">
      <State loading={loading && !data} error={error}>
        {data && (<>
          <Card title="Para onde avisar">
            <p className="small muted" style={{ marginTop: 0 }}>Cole o endereço de webhook do canal da equipe (os de chat que aceitam um JSON com o campo <code>text</code> funcionam direto).
              O NexoISP avisa quando um assinante abre ou responde um chamado pelo portal e quando uma ordem de serviço é aberta ou atribuída.
              As mensagens levam o nome do assinante: use um canal restrito à equipe. Não há envio de e-mail, SMS ou WhatsApp ao assinante.</p>
            <Form submit="Salvar" onSubmit={async () => { await api('/notifications/settings', { method: 'PUT', body: { webhook_url: value || null } }); setUrl(null); setMsg('Salvo.'); reload(); }}>
              <Field label="Endereço do webhook" hint="Em branco: avisos desligados."><input className="mono" value={value} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" /></Field>
            </Form>
            <div className="row">
              <ActionButton disabled={!data.webhook_url} onClick={async () => { setMsg(null); await api('/notifications/test', { body: {} }); setMsg('Aviso de teste entregue.'); }}>Enviar aviso de teste</ActionButton>
              <ActionButton onClick={async () => { const r = await api('/notifications/deliver', { body: {} }); setMsg(`${r.sent} entregue(s), ${r.failed} com falha.`); reload(); }}>Entregar pendentes agora</ActionButton>
              {msg && <span className="small">{msg}</span>}
            </div>
          </Card>
          <Card title="Últimos avisos">
            <State empty={data.recent.length === 0}>
              <table>
                <thead><tr><th>Quando</th><th>Assunto</th><th>Mensagem</th><th>Situação</th></tr></thead>
                <tbody>{data.recent.map((n: any) => (
                  <tr key={n.id}><td className="small">{dt(n.created_at)}</td><td className="small">{EVENT[n.event] ?? n.event}</td><td className="small">{n.text}</td>
                    <td><Badge tone={STATUS[n.status][1]}>{STATUS[n.status][0]}</Badge>{n.last_error && n.status !== 'sent' && <div className="small muted">tentativa {n.attempts}: {n.last_error}</div>}</td></tr>
                ))}</tbody>
              </table>
            </State>
            <p className="small muted">A entrega é feita a cada minuto. Depois de 5 tentativas sem sucesso o aviso fica como “Falhou”.</p>
          </Card>
        </>)}
      </State>
    </Page>
  );
}
