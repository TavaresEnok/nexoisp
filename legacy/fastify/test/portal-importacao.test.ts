import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { withScope } from '../src/db.js';
import { call, getApp, login, testAgent } from './helpers.js';

// Reimportação não duplica; erros ficam por registro; credencial ausente não vira senha inventada; portal isolado.
let admin: string, tenantId: string;
const sample = (f: string) => readFileSync(new URL(`../../../samples/${f}`, import.meta.url), 'utf8');
const count = async (table: string) => withScope({ tenantId, operator: false }, async (c) => (await c.query(`select count(*)::int n from ${table}`)).rows[0].n);

beforeAll(async () => {
  admin = await login('admin@alfa.demo');
  tenantId = (await call(admin, 'GET', '/api/me')).body.tenant.id;
});

describe('importação', () => {
  it('prévia não grava; aplicar grava; reimportar não duplica; erros por linha', async () => {
    const ag = await testAgent(admin, `imp-${Date.now()}`);
    const body = { kind: 'subscribers', filename: 'assinantes.csv', csv: sample('assinantes.csv'), device_id: ag.deviceId };
    const before = [await count('subscribers'), await count('contracts'), await count('service_resources')];
    const pv = (await call(admin, 'POST', '/api/import/preview', body)).body;
    expect(pv.totals).toMatchObject({ rows: 12, created: 10, error: 2, contracts_created: 9, accounts_created: 9, accounts_without_secret: 1, plans_unmatched: ['Plano Antigo 50M'] });
    expect([await count('subscribers'), await count('contracts'), await count('service_resources')]).toEqual(before);

    const ap = (await call(admin, 'POST', '/api/import/apply', body)).body;
    expect(ap.applied).toBe(true);
    expect(ap.totals).toMatchObject({ created: 10, error: 2 });
    expect(ap.rows.filter((r: any) => r.status === 'error').map((r: any) => r.external_id).sort()).toEqual(['1010', '1011']);
    const after = [await count('subscribers'), await count('contracts'), await count('service_resources')];
    expect(after).toEqual([before[0] + 10, before[1] + 9, before[2] + 9]);

    const again = (await call(admin, 'POST', '/api/import/apply', body)).body;
    expect(again.totals).toMatchObject({ created: 0, updated: 0, unchanged: 10, error: 2, contracts_created: 0, accounts_created: 0 });
    expect([await count('subscribers'), await count('contracts'), await count('service_resources')]).toEqual(after);

    // títulos: valores exatos, erro por registro, reimportação estável
    const tb = { kind: 'invoices', csv: sample('titulos.csv') };
    const t1 = (await call(admin, 'POST', '/api/import/apply', tb)).body;
    expect(t1.totals).toMatchObject({ created: 3, error: 2, amount_cents_total: 7990 + 9990 + 114990 });
    const nInv = await count('invoices');
    expect((await call(admin, 'POST', '/api/import/apply', tb)).body.totals).toMatchObject({ created: 0, unchanged: 3, error: 2 });
    expect(await count('invoices')).toBe(nInv);
    // recorrência não cobra em dobro a competência importada, e título importado não vai ao gateway
    const imported = await withScope({ tenantId, operator: false }, async (c) => (await c.query(`select contract_id, to_char(competence,'YYYY-MM') as comp from invoices where external_id = 'T-5001'`)).rows[0]);
    await withScope({ tenantId, operator: false }, (c) => c.query(`update contracts set start_date = current_date - 400 where id = $1`, [imported.contract_id]));
    await call(admin, 'POST', '/api/finance/generate', { competence: imported.comp });
    const same = await withScope({ tenantId, operator: false }, async (c) => (await c.query(`select external_id, gateway_charge_id from invoices where contract_id = $1 and competence = $2`, [imported.contract_id, `${imported.comp}-01`])).rows);
    expect(same).toEqual([{ external_id: 'T-5001', gateway_charge_id: null }]);

    // conta importada sem senha não é provisionável; lote provisiona só as que têm credencial
    const semSenha = await withScope({ tenantId, operator: false }, async (c) => (await c.query(`select id from service_resources where external_id = '1007'`)).rows[0].id);
    expect((await call(admin, 'POST', `/api/resources/${semSenha}/provision`, {})).status).toBe(400);
    const batches = (await call(admin, 'GET', '/api/import/batches')).body;
    const lote = batches.find((b: any) => b.kind === 'subscribers' && b.totals.created === 10);
    expect((await call(admin, 'POST', `/api/import/batches/${lote.id}/provision`)).body.requested).toBe(8);
    expect((await call(admin, 'POST', `/api/import/batches/${lote.id}/provision`)).body.requested).toBe(0);
    expect((await call(await login('atendimento@alfa.demo'), 'POST', '/api/import/preview', body)).status).toBe(403);
  });
});

describe('portal do assinante', () => {
  it('assinante vê somente seus contratos e faturas — na API e no banco', async () => {
    const subs = (await call(admin, 'GET', '/api/subscribers?q=Marcos')).body;
    const outro = (await call(admin, 'GET', '/api/subscribers?q=Juliana')).body[0];
    const email = `marcos${Date.now()}@exemplo.demo`;
    expect((await call(admin, 'POST', `/api/subscribers/${subs[0].id}/portal-access`, { email, password: 'demo1234' })).status).toBe(200);
    const r = await (await getApp()).inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234' } });
    const tok = r.json().token;
    const me = (await call(tok, 'GET', '/api/me')).body;
    expect(me).toMatchObject({ role: 'subscriber', perms: ['portal:self'] });
    const ov = (await call(tok, 'GET', '/api/portal/overview')).body;
    expect(ov.subscriber.name).toBe('Marcos Teixeira');
    expect(ov.contracts).toHaveLength(1);
    expect(ov.invoices.length).toBeGreaterThan(0);
    const minhas = new Set(ov.invoices.map((i: any) => i.id));
    const todas = (await call(admin, 'GET', '/api/invoices')).body;
    expect(todas.filter((i: any) => minhas.has(i.id)).every((i: any) => i.subscriber_name === 'Marcos Teixeira')).toBe(true);
    // rotas da equipe negadas
    for (const url of ['/api/subscribers', '/api/invoices', `/api/subscribers/${outro.id}`, '/api/contracts', '/api/operations', '/api/audit', '/api/users'])
      expect((await call(tok, 'GET', url)).status).toBe(403);
    // banco: com o contexto do assinante, linhas de outros são invisíveis mesmo sem filtro na consulta
    const scope = { tenantId, operator: false, subscriberId: subs[0].id };
    const seen = await withScope(scope, async (c) => ({
      subs: (await c.query('select count(*)::int n from subscribers')).rows[0].n,
      contracts: (await c.query('select count(*)::int n from contracts')).rows[0].n,
      foreignInvoices: (await c.query('select count(*)::int n from invoices where subscriber_id <> $1', [subs[0].id])).rows[0].n,
      users: (await c.query('select count(*)::int n from users')).rows[0].n,
      ops: (await c.query('select count(*)::int n from operations')).rows[0].n,
      resources: (await c.query('select count(*)::int n from service_resources')).rows[0].n,
    }));
    expect(seen).toEqual({ subs: 1, contracts: 1, foreignInvoices: 0, users: 1, ops: 0, resources: 1 });
  });
});
