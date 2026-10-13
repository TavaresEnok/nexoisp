import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withScope } from '../src/db.js';
import { deliverWebhooks } from '../src/webhooks.js';
import { call, getApp, login } from './helpers.js';

// P1: API pública com token (escopo, limite, repetição segura, revogação) e webhooks de saída assinados.
let admin: string, op: string, beta: string, tenantId: string, subscriber: any, url: string;
const tag = String(Date.now()).slice(-6);
const got: any[] = [];
let failNext = 0;
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    if (failNext > 0) { failNext--; res.writeHead(503).end(); return; }
    got.push({ headers: req.headers, raw: body });
    res.writeHead(200).end('ok');
  });
});

/** Chamada à API pública (sem a sessão do painel). */
async function pub(token: string | null, method: string, path: string, payload?: unknown, headers: Record<string, string> = {}) {
  const r = await (await getApp()).inject({ method: method as any, url: path, payload: payload as any,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
  let body: any; try { body = r.json(); } catch { body = r.body; }
  return { status: r.statusCode, body, headers: r.headers };
}
async function newToken(scopes: string[], extra: object = {}) {
  const r = await call(admin, 'POST', '/api/api-tokens', { name: `tok-${tag}-${Math.random().toString(36).slice(2, 6)}`, scopes, ...extra });
  expect(r.status).toBe(200);
  return r.body as { id: string; token: string };
}

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  admin = await login('admin@alfa.demo');
  beta = await login('admin@beta.demo');
  op = await login('operador@nexoisp.demo');
  tenantId = (await call(admin, 'GET', '/api/me')).body.tenant.id;
  const cur = (await call(admin, 'GET', '/api/me')).body.modules as string[];
  await call(op, 'PATCH', `/api/tenants/${tenantId}`, { modules: [...new Set([...cur, 'api'])] });
  // cliente próprio: outros arquivos usam o primeiro assinante e contam os atendimentos dele
  subscriber = (await call(admin, 'POST', '/api/subscribers', { name: `Cliente API ${tag}` })).body;
});
afterAll(async () => {
  for (const t of (await call(admin, 'GET', '/api/api-tokens')).body) if (!t.revoked_at) await call(admin, 'DELETE', `/api/api-tokens/${t.id}`);
  for (const e of (await call(admin, 'GET', '/api/webhook-endpoints')).body) await call(admin, 'DELETE', `/api/webhook-endpoints/${e.id}`);
  const cur = (await call(admin, 'GET', '/api/me')).body.modules as string[];
  await call(op, 'PATCH', `/api/tenants/${tenantId}`, { modules: cur.filter((m) => m !== 'api') });
  await new Promise((r) => server.close(r));
});

describe('token de aplicação', () => {
  it('administração exige módulo e permissão; o token aparece uma vez e a lista não o expõe', async () => {
    expect((await call(beta, 'GET', '/api/api-tokens')).status).toBe(403);               // provedor sem o módulo
    expect((await call(await login('noc@alfa.demo'), 'GET', '/api/api-tokens')).status).toBe(403);
    expect((await call(admin, 'POST', '/api/api-tokens', { name: `ruim ${tag}`, scopes: ['admin:all'] })).status).toBe(400);
    const t = await newToken(['subscribers:read']);
    expect(t.token).toMatch(/^nxk_/);
    const lista = (await call(admin, 'GET', '/api/api-tokens')).body;
    const meu = lista.find((x: any) => x.id === t.id);
    expect(meu).toMatchObject({ scopes: ['subscribers:read'], active: true });
    expect(JSON.stringify(lista)).not.toContain(t.token);
    expect(meu.prefix).toBe(t.token.slice(0, 12));
    expect((await call(admin, 'POST', '/api/api-tokens', { name: lista[0].name, scopes: ['subscribers:read'] })).status).toBe(409);
  });

  it('sem token, token inválido e escopo faltando são recusados; leitura limita ao provedor do token', async () => {
    const t = await newToken(['subscribers:read']);
    expect((await pub(null, 'GET', '/public/v1/subscribers')).status).toBe(401);
    expect((await pub('nxk_invalido', 'GET', '/public/v1/subscribers')).status).toBe(401);
    expect((await pub(t.token, 'GET', '/public/v1/contracts')).body.code ?? (await pub(t.token, 'GET', '/public/v1/contracts')).status).toBeTruthy();
    expect((await pub(t.token, 'GET', '/public/v1/contracts')).status).toBe(403);
    expect((await pub(t.token, 'POST', '/public/v1/tickets', { subscriber_id: subscriber.id, subject: 'x y z', category: 'other', body: 'x' })).status).toBe(403);
    const ok = await pub(t.token, 'GET', `/public/v1/subscribers?q=${encodeURIComponent(subscriber.name)}`);
    expect(ok.status).toBe(200);
    expect(ok.body.some((s: any) => s.id === subscriber.id)).toBe(true);
    // assinante de outro provedor não existe para este token
    const doBeta = (await call(beta, 'GET', '/api/subscribers?limit=1')).body[0];
    expect((await pub(t.token, 'GET', `/public/v1/subscribers/${doBeta.id}`)).status).toBe(404);
    // a chave também vale em X-API-Key
    const viaKey = await (await getApp()).inject({ method: 'GET', url: '/public/v1/subscribers?limit=1', headers: { 'x-api-key': t.token } });
    expect(viaKey.statusCode).toBe(200);
  });

  it('limite por minuto devolve 429; token revogado deixa de valer na hora', async () => {
    const t = await newToken(['subscribers:read'], { rate_limit_per_min: 10 });
    let ultimo = 200;
    for (let i = 0; i < 11; i++) ultimo = (await pub(t.token, 'GET', '/public/v1/subscribers?limit=1')).status;
    expect(ultimo).toBe(429);
    const t2 = await newToken(['subscribers:read']);
    expect((await pub(t2.token, 'GET', '/public/v1/subscribers?limit=1')).status).toBe(200);
    expect((await call(admin, 'DELETE', `/api/api-tokens/${t2.id}`)).status).toBe(200);
    expect((await pub(t2.token, 'GET', '/public/v1/subscribers?limit=1')).status).toBe(401);
  });
});

describe('escrita pela API pública', () => {
  it('atendimento e OS entram com o token como autor; Idempotency-Key não duplica', async () => {
    const t = await newToken(['tickets:write', 'work_orders:write', 'work_orders:read']);
    const dados = { subscriber_id: subscriber.id, subject: `Pelo site ${tag}`, category: 'other', body: 'Pedido de visita' };
    const a = await pub(t.token, 'POST', '/public/v1/tickets', dados, { 'idempotency-key': `k-${tag}` });
    expect(a.status).toBe(201);
    const b = await pub(t.token, 'POST', '/public/v1/tickets', dados, { 'idempotency-key': `k-${tag}` });
    expect(b.status).toBe(201);
    expect(b.headers['idempotent-replay']).toBe('true');
    expect(b.body.id).toBe(a.body.id);
    const tk = (await call(admin, 'GET', `/api/tickets/${a.body.id}`)).body;
    expect(tk).toMatchObject({ origin: 'api', subscriber_id: subscriber.id });
    expect((await pub(t.token, 'POST', '/public/v1/tickets', { ...dados, subscriber_id: 'não-é-uuid' })).status).toBe(400);

    const os = await pub(t.token, 'POST', '/public/v1/work-orders', { kind: 'repair', subscriber_id: subscriber.id, description: `Visita pelo site ${tag}` });
    expect(os.status).toBe(201);
    const det = (await pub(t.token, 'GET', `/public/v1/work-orders/${os.body.id}`)).body;
    expect(det).toMatchObject({ number: os.body.number, status: 'open', kind: 'repair' });
    // não se escolhe responsável pela API
    const x = await pub(t.token, 'POST', '/public/v1/work-orders', { kind: 'repair', subscriber_id: subscriber.id, description: 'x y z', assignee_id: subscriber.id });
    expect(x.status).toBe(201);
    expect((await call(admin, 'GET', `/api/work-orders/${x.body.id}`)).body.assignee_id).toBeNull();
    for (const id of [os.body.id, x.body.id]) await call(admin, 'POST', `/api/work-orders/${id}/status`, { status: 'canceled', resolution: 'limpeza do teste' });
    await call(admin, 'POST', `/api/tickets/${a.body.id}/status`, { status: 'closed' });
    // a auditoria registra o token como ator
    const aud = (await call(admin, 'GET', '/api/audit?limit=50')).body;
    const rows = Array.isArray(aud) ? aud : aud.rows ?? [];
    expect(rows.some((r: any) => r.action === 'ticket.create' && r.actor_type === 'api')).toBe(true);
  });
});

describe('webhooks de saída', () => {
  it('endpoint exige endereço seguro; evento assinado chega, filtra por assinatura e tenta de novo depois de falha', async () => {
    expect((await call(admin, 'POST', '/api/webhook-endpoints', { name: `ruim ${tag}`, url: 'ftp://x', events: ['invoice.paid'] })).status).toBe(400);
    expect((await call(admin, 'POST', '/api/webhook-endpoints', { name: `ruim2 ${tag}`, url, events: ['evento.inexistente'] })).status).toBe(400);
    const ep = (await call(admin, 'POST', '/api/webhook-endpoints', { name: `site-${tag}`, url, events: ['ticket.created', 'work_order.created'] })).body;
    expect(ep.secret).toMatch(/^whsec_/);
    const outro = (await call(admin, 'POST', '/api/webhook-endpoints', { name: `so-fatura-${tag}`, url, events: ['invoice.paid'] })).body;
    expect((await call(admin, 'GET', '/api/webhook-endpoints')).body.every((e: any) => !('secret' in e) && !('secret_enc' in e))).toBe(true);

    got.length = 0;
    const t = await newToken(['tickets:write']);
    const tk = await pub(t.token, 'POST', '/public/v1/tickets', { subscriber_id: subscriber.id, subject: `Evento ${tag}`, category: 'other', body: 'x' });
    expect(tk.status).toBe(201);

    // 1ª entrega falha (503): fica pendente com a causa registrada
    failNext = 1;
    await deliverWebhooks(() => {}, tenantId);
    const pend = (await call(admin, 'GET', `/api/webhook-deliveries?endpoint_id=${ep.id}`)).body;
    const d = pend.find((x: any) => x.event === 'ticket.created');
    expect(d).toMatchObject({ status: 'pending', attempts: 1, response_status: 503 });
    expect(got).toHaveLength(0);
    // próxima tentativa só depois da espera; adianto o relógio da fila
    await deliverWebhooks(() => {}, tenantId);
    expect(got).toHaveLength(0);
    await withScope({ tenantId, operator: false }, (c) => c.query(`update webhook_deliveries set next_attempt_at = now() where status = 'pending'`));
    await deliverWebhooks(() => {}, tenantId);

    expect(got).toHaveLength(1);
    const h = got[0].headers;
    expect(h['x-nexo-event']).toBe('ticket.created');
    expect(h['x-nexo-signature']).toBe(`sha256=${createHmac('sha256', ep.secret).update(`${h['x-nexo-timestamp']}.${got[0].raw}`).digest('hex')}`);
    const corpo = JSON.parse(got[0].raw);
    expect(corpo).toMatchObject({ event: 'ticket.created', data: { ticket_id: tk.body.id, origin: 'api', subscriber_id: subscriber.id } });
    // o endpoint que só assina fatura paga não recebeu nada
    expect((await call(admin, 'GET', `/api/webhook-deliveries?endpoint_id=${outro.id}`)).body).toHaveLength(0);
    // teste manual
    expect((await call(admin, 'POST', `/api/webhook-endpoints/${ep.id}/test`)).body).toMatchObject({ ok: true, status: 200 });
    await call(admin, 'POST', `/api/tickets/${tk.body.id}/status`, { status: 'closed' });
  });

  it('esgotadas as tentativas a entrega fica como falhou e pode ser reenviada', async () => {
    const ep = (await call(admin, 'POST', '/api/webhook-endpoints', { name: `falha-${tag}`, url, events: ['ticket.created'] })).body;
    const t = await newToken(['tickets:write']);
    const tk = (await pub(t.token, 'POST', '/public/v1/tickets', { subscriber_id: subscriber.id, subject: `Falha ${tag}`, category: 'other', body: 'x' })).body;
    failNext = 100;
    for (let i = 0; i < 6; i++) {
      await withScope({ tenantId, operator: false }, (c) => c.query(`update webhook_deliveries set next_attempt_at = now() where status = 'pending'`));
      await deliverWebhooks(() => {}, tenantId);
    }
    const d = (await call(admin, 'GET', `/api/webhook-deliveries?endpoint_id=${ep.id}&status=failed`)).body[0];
    expect(d).toMatchObject({ status: 'failed', attempts: 6 });
    failNext = 0;
    got.length = 0;
    expect((await call(admin, 'POST', `/api/webhook-deliveries/${d.id}/retry`)).status).toBe(200);
    expect(got).toHaveLength(1);
    expect((await call(admin, 'GET', `/api/webhook-deliveries?endpoint_id=${ep.id}&status=failed`)).body).toHaveLength(0);
    // reenviar o que já foi entregue não é permitido
    expect((await call(admin, 'POST', `/api/webhook-deliveries/${d.id}/retry`)).status).toBe(409);
    await call(admin, 'POST', `/api/tickets/${tk.id}/status`, { status: 'closed' });
  });
});
