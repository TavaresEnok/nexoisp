import { beforeAll, describe, expect, it } from 'vitest';
import { call, login } from './helpers.js';

// P3 campos personalizados, F5 kit de instalação e auxiliares, F7 comissão.
let admin: string, beta: string, noc: string, subId: string, contractId: string, techId: string, otherId: string;
const tag = String(Date.now()).slice(-6);
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());   // hoje no fuso do provedor

beforeAll(async () => {
  admin = await login('admin@alfa.demo');
  beta = await login('admin@beta.demo');
  noc = await login('noc@alfa.demo');
  const plan = (await call(admin, 'POST', '/api/plans', { name: `Plano prod ${tag}`, price_cents: 5000, down_kbps: 1000, up_kbps: 1000, profile_name: `pr${tag}` })).body.id;
  subId = (await call(admin, 'POST', '/api/subscribers', { name: `Prod ${tag}` })).body.id;
  contractId = (await call(admin, 'POST', '/api/contracts', { subscriber_id: subId, plan_id: plan, due_day: 10 })).body.id;
  const staff = (await call(admin, 'GET', '/api/staff')).body;
  techId = staff.find((s: any) => s.role === 'noc').id;
  otherId = staff.find((s: any) => s.id !== techId && s.role !== 'subscriber').id;
});

describe('campos personalizados', () => {
  it('definição valida; valores respeitam o tipo; vazio remove; obrigatório não limpa; inativo recusa; não vaza', async () => {
    const f = (b: object) => call(admin, 'POST', '/api/custom-fields', b);
    expect((await f({ entity: 'subscriber', key: 'Ruim Key', label: 'x y', type: 'text' })).status).toBe(400);
    expect((await f({ entity: 'subscriber', key: `sel${tag}`, label: 'Sem opções', type: 'select' })).status).toBe(400);
    expect((await f({ entity: 'subscriber', key: `txt${tag}`, label: 'Opções em texto', type: 'text', options: ['a'] })).status).toBe(400);
    const cod = (await f({ entity: 'subscriber', key: `cod${tag}`, label: 'Código na origem', type: 'text', required: true })).body;
    await f({ entity: 'subscriber', key: `n${tag}`, label: 'Nº de pontos', type: 'number' });
    await f({ entity: 'subscriber', key: `s${tag}`, label: 'Canal', type: 'select', options: ['site', 'loja'] });
    await f({ entity: 'subscriber', key: `b${tag}`, label: 'VIP', type: 'boolean' });
    await f({ entity: 'subscriber', key: `d${tag}`, label: 'Desde', type: 'date' });
    expect((await f({ entity: 'subscriber', key: `cod${tag}`, label: 'Repetido', type: 'text' })).status).toBe(409);

    const put = (values: object) => call(admin, 'PUT', `/api/subscribers/${subId}/custom`, { values });
    expect((await put({ [`n${tag}`]: 'doze' })).status).toBe(400);
    expect((await put({ [`s${tag}`]: 'telefone' })).status).toBe(400);
    expect((await put({ [`d${tag}`]: '12/03/2026' })).status).toBe(400);
    expect((await put({ desconhecido: 'x' })).status).toBe(400);
    const ok = await put({ [`cod${tag}`]: 'A-77', [`n${tag}`]: 3, [`s${tag}`]: 'site', [`b${tag}`]: true, [`d${tag}`]: '2026-03-12' });
    expect(ok.status).toBe(200);
    expect(ok.body.custom).toMatchObject({ [`cod${tag}`]: 'A-77', [`n${tag}`]: 3, [`s${tag}`]: 'site', [`b${tag}`]: true });
    expect((await call(admin, 'GET', `/api/subscribers/${subId}`)).body.custom[`n${tag}`]).toBe(3);
    // esvaziar remove a chave; obrigatório não esvazia
    const limpo = await put({ [`n${tag}`]: null });
    expect(limpo.body.custom).not.toHaveProperty(`n${tag}`);
    expect((await put({ [`cod${tag}`]: null })).status).toBe(400);
    // campo inativo some das listas e recusa valor novo
    expect((await call(admin, 'PATCH', `/api/custom-fields/${cod.id}`, { required: false, active: false })).status).toBe(200);
    expect((await put({ [`cod${tag}`]: 'B' })).status).toBe(400);
    expect((await call(admin, 'GET', '/api/custom-fields?entity=subscriber')).body.some((x: any) => x.id === cod.id)).toBe(false);
    expect((await call(admin, 'GET', '/api/custom-fields?entity=subscriber&all=1')).body.some((x: any) => x.id === cod.id)).toBe(true);
    // contrato tem a própria lista; outro provedor não vê; só quem administra define
    await f({ entity: 'contract', key: `c${tag}`, label: 'Número do contrato físico', type: 'text' });
    expect((await call(admin, 'PUT', `/api/contracts/${contractId}/custom`, { values: { [`c${tag}`]: 'CF-9' } })).body.custom).toMatchObject({ [`c${tag}`]: 'CF-9' });
    expect((await call(admin, 'PUT', `/api/contracts/${contractId}/custom`, { values: { [`n${tag}`]: 1 } })).status).toBe(400);   // campo de assinante
    expect((await call(beta, 'GET', '/api/custom-fields?all=1')).body.some((x: any) => x.key.endsWith(tag))).toBe(false);
    expect((await call(noc, 'POST', '/api/custom-fields', { entity: 'contract', key: `z${tag}`, label: 'Zzz', type: 'text' })).status).toBe(403);
  });
});

describe('kit de instalação e auxiliares', () => {
  it('kit baixa tudo ou nada; item com série não entra; auxiliar aparece na OS', async () => {
    const mk = async (name: string, extra: object = {}) => (await call(admin, 'POST', '/api/stock/items', { name: `${name} ${tag}`, unit: 'un', ...extra })).body;
    const cabo = await mk('Cabo drop', { unit: 'm' });
    const conector = await mk('Conector APC');
    const onu = await mk('ONU série', { serialized: true });
    await call(admin, 'POST', `/api/stock/items/${cabo.id}/movements`, { kind: 'in', qty: 200 });
    await call(admin, 'POST', `/api/stock/items/${conector.id}/movements`, { kind: 'in', qty: 3 });
    expect((await call(admin, 'POST', '/api/install-kits', { name: `Kit série ${tag}`, items: [{ item_id: onu.id, qty: 1 }] })).status).toBe(400);
    expect((await call(admin, 'POST', '/api/install-kits', { name: `Kit rep ${tag}`, items: [{ item_id: cabo.id, qty: 1 }, { item_id: cabo.id, qty: 2 }] })).status).toBe(400);
    const kit = (await call(admin, 'POST', '/api/install-kits', { name: `Kit padrão ${tag}`, items: [{ item_id: cabo.id, qty: 80 }, { item_id: conector.id, qty: 2 }] })).body;
    const lista = (await call(admin, 'GET', '/api/install-kits')).body.find((k: any) => k.id === kit.id);
    expect(lista.items).toHaveLength(2);

    const os = (await call(admin, 'POST', '/api/work-orders', { kind: 'install', subscriber_id: subId, contract_id: contractId, description: `Instalação kit ${tag}` })).body;
    const r = await call(admin, 'POST', `/api/work-orders/${os.id}/kit`, { kit_id: kit.id });
    expect(r.status).toBe(200);
    expect(r.body.launched).toHaveLength(2);
    const det = (await call(admin, 'GET', `/api/work-orders/${os.id}`)).body;
    expect(det.materials.map((m: any) => [m.item_name, m.qty]).sort()).toEqual([[`Cabo drop ${tag}`, 80], [`Conector APC ${tag}`, 2]].sort());
    // segundo kit: o conector acaba (saldo 1 < 2); nada pode ter sido baixado do cabo
    const r2 = await call(admin, 'POST', `/api/work-orders/${os.id}/kit`, { kit_id: kit.id });
    expect(r2.status).toBe(409);
    const saldo = (await call(admin, 'GET', '/api/stock/items')).body.find((i: any) => i.id === cabo.id).balance;
    expect(saldo).toBe(120);

    // auxiliares
    expect((await call(admin, 'POST', `/api/work-orders/${os.id}/helpers`, { user_id: otherId })).status).toBe(200);
    expect((await call(admin, 'GET', `/api/work-orders/${os.id}`)).body.helpers.map((h: any) => h.user_id)).toEqual([otherId]);
    await call(admin, 'PATCH', `/api/work-orders/${os.id}`, { assignee_id: techId });
    expect((await call(admin, 'POST', `/api/work-orders/${os.id}/helpers`, { user_id: techId })).status).toBe(400);   // o responsável não é auxiliar
    expect((await call(admin, 'DELETE', `/api/work-orders/${os.id}/helpers/${otherId}`)).status).toBe(200);
    expect((await call(admin, 'DELETE', `/api/work-orders/${os.id}/helpers/${otherId}`)).status).toBe(404);
    // OS encerrada não recebe kit
    await call(admin, 'POST', `/api/work-orders/${os.id}/status`, { status: 'canceled', resolution: 'teste' });
    expect((await call(admin, 'POST', `/api/work-orders/${os.id}/kit`, { kit_id: kit.id })).status).toBe(400);
  });
});

describe('comissão', () => {
  it('apura OS concluídas (responsável e auxiliar) e prospectos ganhos pelas regras vigentes', async () => {
    const rule = (b: object) => call(admin, 'POST', '/api/commission-rules', b);
    expect((await call(noc, 'POST', '/api/commission-rules', { subject: 'sale', assignee_cents: 1000 })).status).toBe(403);
    expect((await rule({ subject: 'sale', os_kind: 'install', assignee_cents: 1000 })).status).toBe(400);
    expect((await rule({ subject: 'work_order', os_kind: 'install', assignee_cents: 5000, helper_cents: 2000 })).status).toBe(200);
    expect((await rule({ subject: 'work_order', os_kind: 'install', assignee_cents: 6000, helper_cents: 2500 })).status).toBe(200);   // substitui a anterior
    expect((await call(admin, 'GET', '/api/commission-rules')).body.filter((r: any) => r.subject === 'work_order' && r.os_kind === 'install')).toHaveLength(1);
    expect((await rule({ subject: 'sale', assignee_cents: 3000 })).status).toBe(200);

    const antes = (await call(admin, 'GET', `/api/reports/commissions?from=${today}&to=${today}`)).body;
    const base = (id: string) => antes.rows.find((r: any) => r.user_id === id) ?? { os_assignee: 0, os_helper: 0, sales: 0, total_cents: 0 };
    const t0 = base(techId), h0 = base(otherId);

    const os = (await call(admin, 'POST', '/api/work-orders', { kind: 'install', subscriber_id: subId, contract_id: contractId, description: `Comissão ${tag}`, assignee_id: techId })).body;
    await call(admin, 'POST', `/api/work-orders/${os.id}/helpers`, { user_id: otherId });
    await call(admin, 'POST', `/api/work-orders/${os.id}/status`, { status: 'in_progress' });
    await call(admin, 'POST', `/api/work-orders/${os.id}/status`, { status: 'done', resolution: 'Instalado' });

    const lead = (await call(admin, 'POST', '/api/leads', { name: `Lead com ${tag}`, phone: '81999990000', owner_id: otherId })).body;
    expect((await call(admin, 'POST', `/api/leads/${lead.id}/convert`, {})).status).toBe(200);

    const dep = (await call(admin, 'GET', `/api/reports/commissions?from=${today}&to=${today}`)).body;
    const tech = dep.rows.find((r: any) => r.user_id === techId), help = dep.rows.find((r: any) => r.user_id === otherId);
    expect(tech.os_assignee - t0.os_assignee).toBe(1);
    expect(tech.total_cents - t0.total_cents).toBe(6000);
    expect(help.os_helper - h0.os_helper).toBe(1);
    expect(help.sales - h0.sales).toBe(1);
    expect(help.total_cents - h0.total_cents).toBe(2500 + 3000);
    expect((await call(admin, 'GET', `/api/reports/commissions?from=${today}&to=2020-01-01`)).status).toBe(400);
    expect((await call(beta, 'GET', `/api/reports/commissions?from=${today}&to=${today}`)).body.rows.some((r: any) => r.user_id === techId)).toBe(false);
  });
});
