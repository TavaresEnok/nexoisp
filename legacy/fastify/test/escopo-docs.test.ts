import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, getApp, login } from './helpers.js';

// D11 permissão por POP (aplicada no banco), C5 página de aviso pública e P4 documentos do assinante.
let admin: string, beta: string, noc: string, restrito: string, userId: string, planId: string;
const tag = String(Date.now()).slice(-6);
const P: Record<string, any> = {}, S: Record<string, any> = {}, K: Record<string, string> = {};
const raw = async (token: string | null, url: string) =>
  (await getApp()).inject({ method: 'GET', url, headers: token ? { authorization: `Bearer ${token}` } : {} });

beforeAll(async () => {
  admin = await login('admin@alfa.demo');
  beta = await login('admin@beta.demo');
  noc = await login('noc@alfa.demo');
  planId = (await call(admin, 'POST', '/api/plans', { name: `Plano escopo ${tag}`, price_cents: 5000, down_kbps: 1000, up_kbps: 1000, profile_name: `es${tag}` })).body.id;
  for (const n of ['A', 'B']) P[n] = (await call(admin, 'POST', '/api/pops', { name: `POP ${n} ${tag}` })).body;
  for (const n of ['A', 'B', 'N']) {
    S[n] = (await call(admin, 'POST', '/api/subscribers', { name: `Escopo ${n} ${tag}` })).body;
    K[n] = (await call(admin, 'POST', '/api/contracts', { subscriber_id: S[n].id, plan_id: planId, due_day: 10 })).body.id;
    if (n !== 'N') expect((await call(admin, 'PUT', `/api/contracts/${K[n]}/pop`, { pop_id: P[n].id })).status).toBe(200);
  }
  const email = `restrito-${tag}@alfa.demo`;
  const u = await call(admin, 'POST', '/api/users', { name: `Restrito ${tag}`, email, role: 'attendant', password: 'demo1234' });
  expect(u.status).toBe(200);
  userId = u.body.id;
  restrito = await login(email);
});
afterAll(async () => {
  await call(admin, 'PATCH', `/api/users/${userId}`, { active: false });
  await call(admin, 'PUT', '/api/notice-page', { page: null });
});

describe('permissão por POP', () => {
  it('sem POPs o usuário vê tudo; com POPs só os contratos deles e os sem POP, em toda rota', async () => {
    const ids = async (t: string, path: string) => (await call(t, 'GET', path)).body.map((x: any) => x.id);
    expect(await ids(restrito, `/api/contracts?q=${encodeURIComponent(`Escopo`)}&limit=500`)).toEqual(expect.arrayContaining([K.A, K.B, K.N]));
    // administrador não pode ser restrito; POP de outro provedor não entra
    const me = (await call(admin, 'GET', '/api/users')).body.find((x: any) => x.email === 'admin@alfa.demo');
    expect((await call(admin, 'PUT', `/api/users/${me.id}/pops`, { pop_ids: [P.A.id] })).status).toBe(400);
    expect((await call(noc, 'PUT', `/api/users/${userId}/pops`, { pop_ids: [P.A.id] })).status).toBe(403);
    expect((await call(admin, 'PUT', `/api/users/${userId}/pops`, { pop_ids: [P.A.id] })).status).toBe(200);
    expect((await call(restrito, 'GET', '/api/me')).body.pop_restricted).toBe(true);

    const contratos = await ids(restrito, '/api/contracts?limit=500');
    expect(contratos).toEqual(expect.arrayContaining([K.A, K.N]));
    expect(contratos).not.toContain(K.B);
    expect((await call(restrito, 'GET', `/api/contracts/${K.B}`)).status).toBe(404);
    expect((await call(restrito, 'GET', `/api/contracts/${K.B}/states`)).status).toBe(404);
    const subs = await ids(restrito, `/api/subscribers?q=${encodeURIComponent(`Escopo`)}&limit=500`);
    expect(subs).toEqual(expect.arrayContaining([S.A.id, S.N.id]));
    expect(subs).not.toContain(S.B.id);
    expect((await call(restrito, 'GET', `/api/subscribers/${S.B.id}`)).status).toBe(404);
    expect((await call(restrito, 'GET', `/api/subscribers/${S.B.id}/timeline`)).status).toBe(404);

    // o que depende do contrato ou do assinante some junto: fatura, OS, atendimento, busca, exportação
    const fat = (await call(admin, 'POST', '/api/invoices', { contract_id: K.B, description: 'Escopo', amount_cents: 1234, due_date: '2031-01-10' })).body;
    expect((await call(restrito, 'GET', `/api/invoices/${fat.id}`)).status).toBe(404);
    expect(await ids(restrito, `/api/invoices?contract_id=${K.B}`)).toEqual([]);
    const os = (await call(admin, 'POST', '/api/work-orders', { kind: 'repair', subscriber_id: S.B.id, contract_id: K.B, description: `OS escopo ${tag}` })).body;
    expect((await call(restrito, 'GET', `/api/work-orders/${os.id}`)).status).toBe(404);
    const tk = (await call(admin, 'POST', '/api/tickets', { subscriber_id: S.B.id, subject: `Escopo ${tag}`, category: 'other', body: 'x' })).body;
    expect((await call(restrito, 'GET', `/api/tickets/${tk.id}`)).status).toBe(404);
    expect(JSON.stringify((await call(restrito, 'GET', `/api/search?q=${encodeURIComponent(`Escopo B ${tag}`)}`)).body)).not.toContain(S.B.id);
    const csv = await raw(restrito, `/api/subscribers?format=csv&q=${encodeURIComponent(`Escopo`)}`);
    expect(csv.body).toContain(`Escopo A ${tag}`);
    expect(csv.body).not.toContain(`Escopo B ${tag}`);

    // escrita também é barrada: não abre OS para quem não vê, nem move um contrato para um POP que não é seu
    expect((await call(restrito, 'POST', '/api/work-orders', { kind: 'repair', subscriber_id: S.B.id, description: 'tentativa' })).status).toBe(400);
    expect([403, 404]).toContain((await call(restrito, 'PUT', `/api/contracts/${K.A}/pop`, { pop_id: P.B.id })).status);
    expect((await call(admin, 'GET', `/api/contracts/${K.A}`)).body.pop_id).toBe(P.A.id);
    // assinante novo (ainda sem contrato) fica visível para quem cadastrou
    const novo = await call(restrito, 'POST', '/api/subscribers', { name: `Escopo novo ${tag}` });
    expect(novo.status).toBe(200);
    expect((await call(restrito, 'GET', `/api/subscribers/${novo.body.id}`)).status).toBe(200);

    // o administrador continua vendo tudo; tirar a restrição devolve a visão
    expect(await ids(admin, '/api/contracts?limit=500')).toEqual(expect.arrayContaining([K.A, K.B, K.N]));
    await call(admin, 'POST', `/api/work-orders/${os.id}/status`, { status: 'canceled', resolution: 'teste' });
    await call(admin, 'POST', `/api/tickets/${tk.id}/status`, { status: 'closed' });
    await call(admin, 'POST', `/api/invoices/${fat.id}/cancel`, { reason: 'limpeza do teste' });
    expect((await call(admin, 'PUT', `/api/users/${userId}/pops`, { pop_ids: [] })).status).toBe(200);
    expect((await call(restrito, 'GET', `/api/contracts/${K.B}`)).status).toBe(200);
  });
});

describe('página de aviso do provedor', () => {
  it('é pública, não identifica ninguém, escapa o texto e só existe se o provedor configurou', async () => {
    await call(admin, 'PUT', '/api/notice-page', { page: null });
    expect((await raw(null, '/aviso/alfa')).statusCode).toBe(404);
    expect((await call(noc, 'PUT', '/api/notice-page', { page: { title: 'Aviso', blocked_text: 'Seu acesso está suspenso.' } })).status).toBe(403);
    expect((await call(admin, 'PUT', '/api/notice-page', { page: { title: 'A', blocked_text: 'curto' } })).status).toBe(400);
    const ok = await call(admin, 'PUT', '/api/notice-page', { page: { title: 'Acesso suspenso <script>alert(1)</script>', blocked_text: 'Há uma pendência no seu cadastro.\nEntre no portal para regularizar.',
      reduced_text: 'Sua velocidade foi reduzida por pendência.', phone: '(81) 3000-0000', whatsapp: '5581999990000' } });
    expect(ok.status).toBe(200);
    expect((await call(admin, 'GET', '/api/notice-page')).body.path).toBe('/aviso/alfa');
    const r = await raw(null, '/aviso/alfa');
    expect(r.statusCode).toBe(200);
    expect(String(r.headers['content-type'])).toMatch(/text\/html/);
    expect(String(r.headers['content-security-policy'])).toMatch(/default-src 'none'/);
    expect(r.body).toContain('Há uma pendência no seu cadastro.');
    expect(r.body).toContain('&lt;script&gt;');
    expect(r.body).not.toContain('<script>');
    expect(r.body).toContain('wa.me/5581999990000');
    expect((await raw(null, '/aviso/alfa?m=reduzida')).body).toContain('Sua velocidade foi reduzida');
    expect((await raw(null, '/aviso/nao-existe')).statusCode).toBe(404);
    expect((await raw(null, '/aviso/..%2F..%2Fetc')).statusCode).toBe(404);
  });
});

describe('documentos do assinante', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]);
  it('aceita só PDF e imagem conferidos pelo conteúdo, limita o tamanho, baixa com auditoria e apaga o conteúdo ao excluir', async () => {
    const up = (t: string, b: object) => call(t, 'POST', `/api/subscribers/${S.N.id}/documents`, b);
    expect((await up(admin, { kind: 'identity', name: 'rg.png', content_base64: Buffer.from('isto é texto, não imagem').toString('base64') })).status).toBe(400);
    expect((await up(admin, { kind: 'identity', name: 'grande.png', content_base64: Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024)]).toString('base64') })).status).toBe(400);
    expect((await up(noc, { kind: 'identity', name: 'rg.png', content_base64: png.toString('base64') })).status).toBe(403);
    expect((await up(admin, { kind: 'identity', name: 'rg.png', contract_id: K.A, content_base64: png.toString('base64') })).status).toBe(400);   // contrato de outro assinante
    const d = await up(admin, { kind: 'identity', name: '../../rg "frente".png', contract_id: K.N, content_base64: png.toString('base64') });
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({ mime: 'image/png', size_bytes: png.length, name: '.._.._rg _frente_.png' });

    const lista = (await call(noc, 'GET', `/api/subscribers/${S.N.id}/documents`)).body;       // ver a lista: leitura do cadastro
    expect(lista.map((x: any) => x.id)).toEqual([d.body.id]);
    expect(JSON.stringify(lista)).not.toContain('content');
    expect((await raw(noc, `/api/documents/${d.body.id}/download`)).statusCode).toBe(403);      // baixar: só quem edita o cadastro
    expect((await raw(beta, `/api/documents/${d.body.id}/download`)).statusCode).toBe(404);
    const dl = await raw(admin, `/api/documents/${d.body.id}/download`);
    expect(dl.statusCode).toBe(200);
    expect(dl.rawPayload.equals(png)).toBe(true);
    expect(String(dl.headers['content-disposition'])).toMatch(/^attachment/);
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect((await call(admin, 'GET', '/api/audit?limit=20')).body.some((e: any) => e.action === 'document.download')).toBe(true);

    expect((await call(admin, 'DELETE', `/api/documents/${d.body.id}`)).status).toBe(200);
    expect((await call(admin, 'GET', `/api/subscribers/${S.N.id}/documents`)).body).toEqual([]);
    expect((await raw(admin, `/api/documents/${d.body.id}/download`)).statusCode).toBe(404);
    expect((await call(admin, 'DELETE', `/api/documents/${d.body.id}`)).status).toBe(404);
  });
});
