import { beforeAll, describe, expect, it } from 'vitest';
import { withScope } from '../src/db.js';
import { call, login } from './helpers.js';

// Aceite eletrônico simples: pedido pela equipe, aceite pelo assinante no portal, prova conferível e imutável.
let admin: string, beta: string, outroAssinante: string, portal: string, tenantId: string;
let contractId: string, subscriberId: string, amendmentId: string;
const r = 100 + (Date.now() % 800);
const email = `aceite${r}@cliente.demo`;

beforeAll(async () => {
  admin = await login('admin@alfa.demo'); beta = await login('admin@beta.demo');
  tenantId = (await call(admin, 'GET', '/api/me')).body.tenant.id;
  const plan = (await call(admin, 'POST', '/api/plans', { name: `Plano aceite ${r}`, price_cents: 5000, down_kbps: 1000, up_kbps: 1000, profile_name: `ac${r}` })).body.id;
  const mk = async (n: string) => {
    const sub = (await call(admin, 'POST', '/api/subscribers', { name: `${n} ${r}` })).body;
    const k = (await call(admin, 'POST', '/api/contracts', { subscriber_id: sub.id, plan_id: plan, due_day: 10 })).body.id;
    return { sub, k };
  };
  const a = await mk('Aceite A'); subscriberId = a.sub.id; contractId = a.k;
  const b = await mk('Aceite B');
  amendmentId = (await call(admin, 'POST', `/api/contracts/${contractId}/amendments`, { kind: 'condition', title: 'Aditivo de permanência', body: 'Permanência de 12 meses com desconto de 20%.' })).body.id;
  // sem acesso ao portal não há como aceitar
  expect((await call(admin, 'POST', `/api/contracts/${contractId}/acceptances`, { amendment_id: amendmentId })).status).toBe(409);
  await call(admin, 'POST', `/api/subscribers/${subscriberId}/portal-access`, { email, password: 'demo1234' });
  const emailB = `aceiteb${r}@cliente.demo`;
  await call(admin, 'POST', `/api/subscribers/${b.sub.id}/portal-access`, { email: emailB, password: 'demo1234' });
  portal = await login(email, 'demo1234'); outroAssinante = await login(emailB, 'demo1234');
});

describe('aceite eletrônico simples', () => {
  let id: string;
  it('a equipe pede o aceite do aditivo; o assinante vê só o dele; pedido igual pendente é recusado', async () => {
    const p = await call(admin, 'POST', `/api/contracts/${contractId}/acceptances`, { amendment_id: amendmentId });
    expect(p.status).toBe(200);
    id = p.body.id;
    expect((await call(admin, 'POST', `/api/contracts/${contractId}/acceptances`, { amendment_id: amendmentId })).status).toBe(409);
    const meu = (await call(portal, 'GET', '/api/portal/acceptances')).body;
    expect(meu).toHaveLength(1);
    expect(meu[0]).toMatchObject({ id, title: 'Aditivo de permanência', status: 'pending' });
    expect(meu[0].body).toContain('12 meses');
    expect((await call(outroAssinante, 'GET', '/api/portal/acceptances')).body).toHaveLength(0);
    expect((await call(outroAssinante, 'POST', `/api/portal/acceptances/${id}/accept`, { agree: true })).status).toBe(404);
  });

  it('aceitar exige a confirmação; registra data, endereço e resumo; não se aceita duas vezes', async () => {
    expect((await call(portal, 'POST', `/api/portal/acceptances/${id}/accept`, {})).status).toBe(400);
    const ok = await call(portal, 'POST', `/api/portal/acceptances/${id}/accept`, { agree: true });
    expect(ok.status).toBe(200);
    expect(ok.body.evidence_hash).toMatch(/^[0-9a-f]{64}$/);
    expect((await call(portal, 'POST', `/api/portal/acceptances/${id}/accept`, { agree: true })).status).toBe(409);
    const ev = (await call(admin, 'GET', `/api/acceptances/${id}/evidence`)).body;
    expect(ev).toMatchObject({ status: 'accepted', title: 'Aditivo de permanência', accepted_email: email });
    expect(ev.accepted_ip).toBeTruthy();
    expect(ev.verification).toEqual({ text_matches_hash: true, evidence_matches: true });
    expect((await call(admin, 'POST', `/api/acceptances/${id}/cancel`, {})).status).toBe(409);   // aceito não se cancela
  });

  it('o texto aceito é cópia: mudar o aditivo depois não muda a prova, e o banco recusa alterar o aceite', async () => {
    await withScope({ tenantId, operator: false }, (c) => c.query(`update contract_amendments set body = 'Texto alterado depois' where id = $1`, [amendmentId]));
    const ev = (await call(admin, 'GET', `/api/acceptances/${id}/evidence`)).body;
    expect(ev.body).toContain('12 meses');
    expect(ev.verification.text_matches_hash).toBe(true);
    await expect(withScope({ tenantId, operator: false }, (c) => c.query(`update acceptances set body = 'x', body_hash = repeat('0', 64) where id = $1`, [id]))).rejects.toThrow(/não pode ser alterado/);
    await expect(withScope({ tenantId, operator: false }, (c) => c.query(`update acceptances set accepted_ip = '1.1.1.1' where id = $1`, [id]))).rejects.toThrow();
  });

  it('documento livre; cancelar pedido pendente; outro provedor não enxerga', async () => {
    const p = (await call(admin, 'POST', `/api/contracts/${contractId}/acceptances`, { title: 'Termo de comodato', body: 'O equipamento é do provedor e deve ser devolvido.' })).body;
    expect((await call(admin, 'POST', `/api/contracts/${contractId}/acceptances`, { title: 'Sem texto' })).status).toBe(400);
    expect((await call(beta, 'GET', `/api/acceptances/${p.id}/evidence`)).status).toBe(404);
    expect((await call(admin, 'POST', `/api/acceptances/${p.id}/cancel`, {})).status).toBe(200);
    expect((await call(portal, 'POST', `/api/portal/acceptances/${p.id}/accept`, { agree: true })).status).toBe(409);   // cancelado: o assinante é dono do pedido, mas ele não vale mais
    const lista = (await call(admin, 'GET', `/api/contracts/${contractId}/acceptances`)).body;
    expect(lista.map((x: any) => x.status).sort()).toEqual(['accepted', 'canceled']);
  });
});
