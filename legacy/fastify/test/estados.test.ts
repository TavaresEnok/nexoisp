import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentCall, call, getApp, login } from './helpers.js';

// D6/D7/D8 e P5: situação do contrato em eixos separados com motivo/modo, restrição de crédito, anotações com alerta e exportação CSV.
let admin: string, beta: string, planId: string, subId: string, contractId: string, resourceId: string, bareContractId: string;
const tag = String(Date.now()).slice(-6);
const states = async (id = contractId) => (await call(admin, 'GET', `/api/contracts/${id}/states`)).body;

beforeAll(async () => {
  admin = await login('admin@alfa.demo');
  beta = await login('admin@beta.demo');
  const a = (await call(admin, 'POST', '/api/agents', { name: `agente-est-${tag}` })).body;
  const dev = (await call(admin, 'POST', '/api/devices', { name: `nas-est-${tag}`, driver: 'demo', agent_id: a.id })).body.id;
  await agentCall(a.token, 'hello', { session_id: `sess-est-${tag}`, version: '0.4.0' });
  planId = (await call(admin, 'POST', '/api/plans', { name: `Plano estados ${tag}`, price_cents: 5000, down_kbps: 100000, up_kbps: 50000, profile_name: `est${tag}` })).body.id;
  subId = (await call(admin, 'POST', '/api/subscribers', { name: `Estados ${tag}` })).body.id;
  contractId = (await call(admin, 'POST', '/api/contracts', { subscriber_id: subId, plan_id: planId, due_day: 10 })).body.id;
  bareContractId = (await call(admin, 'POST', '/api/contracts', { subscriber_id: subId, plan_id: planId, due_day: 12 })).body.id;
  resourceId = (await call(admin, 'POST', `/api/contracts/${contractId}/service`, { device_id: dev, pppoe_username: `est${tag}` })).body.resource_id;
});
afterAll(async () => {
  await call(admin, 'PATCH', `/api/contracts/${bareContractId}`, { end: true });
});

describe('estados do contrato', () => {
  it('três eixos separados: sem conta, ativo, bloqueado manual com motivo e confirmação do equipamento', async () => {
    expect(await states(bareContractId)).toMatchObject({ commercial: { state: 'active' }, access: { state: 'no_account' }, speed: { state: 'normal' } });
    expect(await states()).toMatchObject({ access: { state: 'active' }, speed: { state: 'normal' } });
    expect((await call(admin, 'POST', `/api/resources/${resourceId}/suspend`, { reason: `corte a pedido ${tag}` })).status).toBe(200);
    const s = await states();
    expect(s.access).toMatchObject({ state: 'blocked', mode: 'manual', reason: `corte a pedido ${tag}`, cause: 'other', applied: false });
    expect(s.commercial.state).toBe('active');             // bloquear o acesso não muda a situação comercial
    expect((await call(admin, 'POST', `/api/resources/${resourceId}/resume`, { reason: 'voltou' })).status).toBe(200);
    expect((await states()).access).toMatchObject({ state: 'active', cause: null });
    expect((await call(beta, 'GET', `/api/contracts/${contractId}/states`)).status).toBe(404);
  });

  it('restrição de crédito é eixo comercial, exige motivo e permissão financeira', async () => {
    const noc = await login('noc@alfa.demo');
    expect((await call(noc, 'PUT', `/api/contracts/${contractId}/credit-restriction`, { restricted: true, note: 'negativado' })).status).toBe(403);
    expect((await call(admin, 'PUT', `/api/contracts/${contractId}/credit-restriction`, { restricted: true, note: 'x' })).status).toBe(400);
    expect((await call(admin, 'PUT', `/api/contracts/${contractId}/credit-restriction`, { restricted: true, note: 'dívida de 3 meses' })).status).toBe(200);
    const s = await states();
    expect(s.commercial.state).toBe('credit_restricted');
    expect(s.access.state).toBe('active');                  // não bloqueia o acesso por si
    expect((await call(admin, 'PUT', `/api/contracts/${contractId}/credit-restriction`, { restricted: false, note: 'quitou' })).status).toBe(200);
    expect((await states()).commercial.state).toBe('active');
    const tl = (await call(admin, 'GET', `/api/subscribers/${subId}/timeline`)).body;
    expect(tl.some((e: any) => e.title === 'Restrição de crédito')).toBe(true);
  });

  it('encerramento com motivo do catálogo; tipo errado e motivo sem encerrar são recusados', async () => {
    const motivo = (await call(admin, 'POST', '/api/catalogs', { kind: 'end_reason', name: `Mudou de cidade ${tag}` })).body;
    const outro = (await call(admin, 'POST', '/api/catalogs', { kind: 'os_reason', name: `Motivo OS ${tag}` })).body;
    expect((await call(admin, 'PATCH', `/api/contracts/${contractId}`, { end_reason_id: motivo.id })).status).toBe(400);
    expect((await call(admin, 'PATCH', `/api/contracts/${contractId}`, { end: true, end_reason_id: outro.id })).status).toBe(400);
    expect((await call(admin, 'PATCH', `/api/contracts/${contractId}`, { end: true, end_reason_id: motivo.id, end_note: 'mudança para outro estado' })).status).toBe(200);
    expect((await states()).commercial).toMatchObject({ state: 'ended', end_reason: `Mudou de cidade ${tag}`, end_note: 'mudança para outro estado' });
    expect((await states()).access).toMatchObject({ state: 'blocked', cause: 'contract_ended' });
  });
});

describe('anotações estruturadas', () => {
  it('alerta aparece primeiro, arquivar tira da lista, entra na linha do tempo e não vaza', async () => {
    const tipo = (await call(admin, 'POST', '/api/catalogs', { kind: 'note_type', name: `Cobrança ${tag}` })).body;
    const sem = (await call(admin, 'POST', `/api/subscribers/${subId}/notes`, { body: 'Prefere contato à tarde' })).body;
    const com = (await call(admin, 'POST', `/api/subscribers/${subId}/notes`, { body: 'Não visitar sem agendar', alert: true, type_id: tipo.id, contract_id: bareContractId })).body;
    expect((await call(admin, 'POST', `/api/subscribers/${subId}/notes`, { body: 'x', type_id: com.id })).status).toBe(400);   // tipo inválido
    const lista = (await call(admin, 'GET', `/api/subscribers/${subId}/notes`)).body;
    expect(lista.map((n: any) => n.id)).toEqual([com.id, sem.id]);                    // alerta primeiro
    expect(lista[0]).toMatchObject({ alert: true, type_name: `Cobrança ${tag}` });
    expect((await call(admin, 'GET', `/api/subscribers/${subId}/timeline`)).body.some((e: any) => e.title === 'Anotação com alerta')).toBe(true);
    expect((await call(beta, 'PATCH', `/api/notes/${com.id}`, { archived: true })).status).toBe(404);
    expect((await call(admin, 'PATCH', `/api/notes/${com.id}`, { archived: true })).status).toBe(200);
    expect((await call(admin, 'GET', `/api/subscribers/${subId}/notes`)).body.map((n: any) => n.id)).toEqual([sem.id]);
    expect((await call(admin, 'GET', `/api/subscribers/${subId}/notes?archived=1`)).body).toHaveLength(2);
    // assinante do portal não alcança as anotações da equipe
    const email = `nota-${tag}@teste.local`;
    expect((await call(admin, 'POST', `/api/subscribers/${subId}/portal-access`, { email, password: 'demo1234' })).status).toBe(200);
    expect((await call(await login(email), 'GET', `/api/subscribers/${subId}/notes`)).status).toBe(403);
  });
});

describe('exportação CSV', () => {
  it('lista do painel vira CSV com BOM, escapa fórmula e fica na auditoria; portal e módulo sem permissão não exportam', async () => {
    await call(admin, 'POST', '/api/subscribers', { name: `=SOMA(1;1) ${tag}` });
    const r = await (await getApp()).inject({ method: 'GET', url: `/api/subscribers?format=csv&q=${encodeURIComponent(`SOMA(1;1) ${tag}`)}`, headers: { authorization: `Bearer ${admin}` } });
    expect(r.statusCode).toBe(200);
    expect(String(r.headers['content-type'])).toMatch(/text\/csv/);
    expect(String(r.headers['content-disposition'])).toMatch(/subscribers\.csv/);
    expect([...r.rawPayload.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);   // BOM: o Excel abre em UTF-8
    expect(r.body.split('\r\n')[0]).toContain('name');
    expect(r.body).toContain(`"'=SOMA(1;1) ${tag}"`);               // aspas simples impedem a fórmula
    // rotas fora da lista de exportação continuam em JSON
    const j = await call(admin, 'GET', '/api/plans?format=csv');
    expect(Array.isArray(j.body)).toBe(true);
    const aud = (await call(admin, 'GET', '/api/audit?limit=20')).body;
    expect((Array.isArray(aud) ? aud : aud.rows ?? []).some((a: any) => a.action === 'export.csv')).toBe(true);
    const noc = await login('noc@alfa.demo');
    const semPerm = await (await getApp()).inject({ method: 'GET', url: '/api/invoices?format=csv', headers: { authorization: `Bearer ${noc}` } });
    expect(semPerm.statusCode).toBe(403);
  });
});
