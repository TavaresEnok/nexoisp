import { beforeAll, describe, expect, it } from 'vitest';
import { call, login } from './helpers.js';

// Itens do comparativo com o SGP que são cadastro e operação: dados da pessoa, etiquetas, aviso de manutenção,
// checklist da OS e equipamento em comodato.
let admin: string, beta: string, noc: string, contract: any;
const tag = String(Date.now()).slice(-6);
const iso = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString();

beforeAll(async () => {
  admin = await login('admin@alfa.demo');
  beta = await login('admin@beta.demo');
  noc = await login('noc@alfa.demo');
  contract = (await call(admin, 'GET', '/api/contracts?status=active')).body[0];
});

describe('dados da pessoa e etiquetas', () => {
  it('dados da pessoa gravam e validam', async () => {
    const s = await call(admin, 'POST', '/api/subscribers', { name: `Pessoa ${tag}`, birth_date: '1985-04-12', rg: '12.345.678-9', rg_issuer: 'SSP/SP', mother_name: 'Maria da Silva' });
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ rg: '12.345.678-9', rg_issuer: 'SSP/SP', mother_name: 'Maria da Silva' });
    expect(String(s.body.birth_date)).toMatch(/^1985-04-12/);
    expect((await call(admin, 'POST', '/api/subscribers', { name: `Ruim ${tag}`, rg: '<script>' })).status).toBe(400);
    expect((await call(admin, 'POST', '/api/subscribers', { name: `Ruim2 ${tag}`, birth_date: '12/04/1985' })).status).toBe(400);
  });

  it('etiquetas: nome único, aplicam ao contrato, filtram e não vazam para outro provedor', async () => {
    const t = (await call(admin, 'POST', '/api/tags', { name: `vip-${tag}` })).body;
    expect(t.id).toBeTruthy();
    expect((await call(admin, 'POST', '/api/tags', { name: `vip-${tag}` })).status).toBe(409);
    const put = await call(admin, 'PUT', `/api/contracts/${contract.id}/tags`, { tag_ids: [t.id] });
    expect(put.body).toEqual([{ id: t.id, name: `vip-${tag}` }]);
    const filtrado = (await call(admin, 'GET', `/api/contracts?tag=${t.id}`)).body;
    expect(filtrado.map((k: any) => k.id)).toEqual([contract.id]);
    expect(filtrado[0].tags).toEqual([{ id: t.id, name: `vip-${tag}` }]);
    // outro provedor não vê a etiqueta nem consegue aplicá-la
    expect((await call(beta, 'GET', '/api/tags')).body.some((x: any) => x.id === t.id)).toBe(false);
    const doBeta = (await call(beta, 'GET', '/api/contracts?status=active')).body[0];
    expect((await call(beta, 'PUT', `/api/contracts/${doBeta.id}/tags`, { tag_ids: [t.id] })).status).toBe(400);
    expect((await call(admin, 'DELETE', `/api/tags/${t.id}`)).status).toBe(200);
    expect((await call(admin, 'GET', `/api/contracts/${contract.id}`)).body.tags).toEqual([]);
  });
});

describe('aviso de manutenção', () => {
  it('o assinante afetado vê no portal; aviso de outro equipamento, cancelado ou futuro distante não aparece', async () => {
    const k = (await call(admin, 'GET', '/api/contracts?status=active')).body.find((c: any) => c.id === contract.id);
    const email = `manut-${tag}@teste.local`;
    expect((await call(admin, 'POST', `/api/subscribers/${k.subscriber_id}/portal-access`, { email, password: 'demo1234' })).status).toBe(200);
    const sub = await login(email);
    const titles = async () => (await call(sub, 'GET', '/api/portal/overview')).body.notices.map((n: any) => n.title);

    const geral = (await call(admin, 'POST', '/api/maintenance-notices', { title: `Geral ${tag}`, message: 'Manutenção na rede', severity: 'degraded', starts_at: iso(-1), ends_at: iso(2) })).body;
    expect(geral).toMatchObject({ state: 'active', severity: 'degraded' });
    expect(geral.affected_subscribers).toBeGreaterThan(0);
    await call(admin, 'POST', '/api/maintenance-notices', { title: `Distante ${tag}`, message: 'Daqui a 30 dias', starts_at: iso(24 * 30), ends_at: iso(24 * 30 + 2) });
    const dev = (await call(admin, 'POST', '/api/devices', { name: `nas-manut-${tag}`, driver: 'demo' })).body;
    await call(admin, 'POST', '/api/maintenance-notices', { title: `Outro NAS ${tag}`, message: 'Só quem usa outro equipamento', device_id: dev.id, starts_at: iso(-1), ends_at: iso(2) });
    expect(await titles()).toEqual([`Geral ${tag}`]);

    expect((await call(noc, 'POST', `/api/maintenance-notices/${geral.id}/cancel`)).status).toBe(200);
    expect(await titles()).toEqual([]);
    expect((await call(admin, 'POST', `/api/maintenance-notices/${geral.id}/cancel`)).status).toBe(400);
    expect((await call(admin, 'POST', '/api/maintenance-notices', { title: 'x y z', message: 'fim antes do início', starts_at: iso(2), ends_at: iso(1) })).status).toBe(400);
    expect((await call(beta, 'GET', '/api/maintenance-notices')).body.some((n: any) => n.title.endsWith(tag))).toBe(false);
  });
});

describe('checklist da OS e comodato', () => {
  it('checklist: itens em ordem, marcação com autor, e OS encerrada não aceita alteração', async () => {
    const wo = (await call(noc, 'POST', '/api/work-orders', { kind: 'repair', subscriber_id: contract.subscriber_id, contract_id: contract.id, description: `checklist ${tag}` })).body;
    expect((await call(noc, 'POST', `/api/work-orders/${wo.id}/checklist`, { items: ['Medir sinal na ONU', 'Trocar conector', 'Testar navegação'] })).status).toBe(200);
    let d = (await call(noc, 'GET', `/api/work-orders/${wo.id}`)).body;
    expect(d.checklist.map((i: any) => [i.position, i.label, i.done])).toEqual([[1, 'Medir sinal na ONU', false], [2, 'Trocar conector', false], [3, 'Testar navegação', false]]);
    expect((await call(noc, 'POST', `/api/work-orders/${wo.id}/checklist/${d.checklist[0].id}`, { done: true })).status).toBe(200);
    d = (await call(noc, 'GET', `/api/work-orders/${wo.id}`)).body;
    expect(d.checklist[0]).toMatchObject({ done: true, done_by_name: expect.any(String) });
    expect((await call(noc, 'POST', `/api/work-orders/${wo.id}/checklist/${d.checklist[0].id}`, { done: false })).status).toBe(200);
    // outro provedor não alcança
    expect((await call(beta, 'POST', `/api/work-orders/${wo.id}/checklist`, { items: ['intruso'] })).status).toBe(404);
    expect((await call(noc, 'POST', `/api/work-orders/${wo.id}/status`, { status: 'canceled', resolution: 'cliente desistiu' })).status).toBe(200);
    expect((await call(noc, 'POST', `/api/work-orders/${wo.id}/checklist`, { items: ['tarde demais'] })).status).toBe(400);
  });

  it('comodato: instalado fica do provedor e contrato encerrado indica o que recolher; venda não', async () => {
    const sub = (await call(admin, 'POST', '/api/subscribers', { name: `Comodato ${tag}` })).body;
    const plan = (await call(admin, 'GET', '/api/plans')).body.find((p: any) => p.active);
    const k = (await call(admin, 'POST', '/api/contracts', { subscriber_id: sub.id, plan_id: plan.id, due_day: 8 })).body;
    const item = (await call(noc, 'POST', '/api/stock/items', { name: `Roteador ${tag}`, serialized: true })).body;
    await call(noc, 'POST', `/api/stock/items/${item.id}/units`, { serials: [`RC${tag}A`, `RC${tag}B`] });
    const [a, b] = (await call(noc, 'GET', `/api/stock/items/${item.id}/units`)).body;
    const wo = (await call(noc, 'POST', '/api/work-orders', { kind: 'install', subscriber_id: sub.id, contract_id: k.id, description: 'instalar roteadores' })).body;
    expect((await call(noc, 'POST', `/api/work-orders/${wo.id}/units`, { unit_id: a.id })).status).toBe(200);                       // padrão: comodato
    expect((await call(noc, 'POST', `/api/work-orders/${wo.id}/units`, { unit_id: b.id, mode: 'sale' })).status).toBe(200);
    let eq = (await call(noc, 'GET', `/api/contracts/${k.id}/equipment`)).body;
    expect(eq.units.map((u: any) => u.contract_mode).sort()).toEqual(['comodato', 'sale']);
    expect(eq.to_recover).toEqual([]);                                                                                            // contrato ainda vigente

    expect((await call(admin, 'PATCH', `/api/contracts/${k.id}`, { end: true })).status).toBe(200);
    eq = (await call(noc, 'GET', `/api/contracts/${k.id}/equipment`)).body;
    expect(eq.to_recover.map((u: any) => u.serial)).toEqual([a.serial]);

    // devolvido ao estoque: sai da lista e perde o vínculo
    expect((await call(noc, 'POST', `/api/stock/units/${a.id}/status`, { status: 'in_stock' })).status).toBe(200);
    expect((await call(noc, 'GET', `/api/contracts/${k.id}/equipment`)).body.to_recover).toEqual([]);
    expect((await call(beta, 'GET', `/api/contracts/${k.id}/equipment`)).status).toBe(404);
  });
});
