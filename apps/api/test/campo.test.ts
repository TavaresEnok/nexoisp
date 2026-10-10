import { beforeAll, describe, expect, it } from 'vitest';
import { call, login } from './helpers.js';

// Expansão 3: ordens de serviço, estoque (saldo nunca negativo, movimento histórico) e FTTH (porta única por contrato).
let admin: string, beta: string, noc: string, fin: string, sub: any, contract: any;
const tag = String(Date.now()).slice(-6);

beforeAll(async () => {
  admin = await login('admin@alfa.demo');
  beta = await login('admin@beta.demo');
  noc = await login('noc@alfa.demo');
  fin = await login('financeiro@alfa.demo');
  contract = (await call(admin, 'GET', '/api/contracts?status=active')).body[0];
  sub = { id: contract.subscriber_id };
});

describe('ordens de serviço e estoque', () => {
  let wo: any, item: any;

  it('numeração por provedor, fluxo de situação e permissões', async () => {
    const outro = (await call(beta, 'GET', '/api/contracts?status=active')).body[0];
    expect((await call(admin, 'POST', '/api/work-orders', { kind: 'repair', subscriber_id: outro.subscriber_id, description: 'x' })).status).toBe(400);
    expect((await call(admin, 'POST', '/api/work-orders', { kind: 'repair', subscriber_id: sub.id, contract_id: outro.id, description: 'x' })).status).toBe(400);
    expect((await call(fin, 'POST', '/api/work-orders', { kind: 'repair', subscriber_id: sub.id, description: 'x' })).status).toBe(403);

    wo = (await call(noc, 'POST', '/api/work-orders', { kind: 'repair', subscriber_id: sub.id, contract_id: contract.id, description: `sem sinal ${tag}` })).body;
    const segundo = (await call(admin, 'POST', '/api/work-orders', { kind: 'install', subscriber_id: sub.id, description: 'instalar', scheduled_for: '2030-01-10T12:00:00Z' })).body;
    expect(wo.status).toBe('open');
    expect(segundo).toMatchObject({ status: 'scheduled', number: wo.number + 1 });
    const b1 = (await call(beta, 'POST', '/api/work-orders', { kind: 'other', subscriber_id: outro.subscriber_id, description: 'do beta' })).body;
    expect(b1.number).toBeLessThanOrEqual(wo.number);              // contador é de cada provedor
    expect((await call(beta, 'GET', `/api/work-orders/${wo.id}`)).status).toBe(404);
    expect((await call(beta, 'POST', `/api/work-orders/${wo.id}/status`, { status: 'canceled', resolution: 'x' })).status).toBe(404);

    expect((await call(noc, 'POST', `/api/work-orders/${wo.id}/status`, { status: 'done', resolution: 'ok' })).status).toBe(400);      // aberta não conclui direto
    expect((await call(noc, 'POST', `/api/work-orders/${wo.id}/status`, { status: 'scheduled' })).status).toBe(400);                  // sem data
    const tecnicoBeta = (await call(beta, 'GET', '/api/staff')).body[0];
    expect((await call(noc, 'PATCH', `/api/work-orders/${wo.id}`, { assignee_id: tecnicoBeta.id })).status).toBe(400);                // responsável de outro provedor
    const eu = (await call(noc, 'GET', '/api/me')).body;
    expect((await call(noc, 'PATCH', `/api/work-orders/${wo.id}`, { assignee_id: eu.id, scheduled_for: '2030-02-01T13:00:00Z' })).body).toMatchObject({ status: 'scheduled', assignee_id: eu.id });
    expect((await call(noc, 'POST', `/api/work-orders/${wo.id}/status`, { status: 'in_progress' })).body.status).toBe('in_progress');
    expect((await call(noc, 'GET', '/api/work-orders?status=pending&mine=1')).body.some((w: any) => w.id === wo.id)).toBe(true);
    expect((await call(admin, 'GET', '/api/work-orders?status=pending&mine=1')).body.some((w: any) => w.id === wo.id)).toBe(false);
  });

  it('material da OS baixa o estoque; saldo não fica negativo; devolução limitada ao lançado', async () => {
    expect((await call(await login('atendimento@alfa.demo'), 'POST', '/api/stock/items', { name: 'x' })).status).toBe(403);
    item = (await call(noc, 'POST', '/api/stock/items', { name: `Conector SC/APC ${tag}`, unit: 'un', min_qty: 5 })).body;
    expect((await call(noc, 'POST', `/api/stock/items/${item.id}/movements`, { kind: 'in', qty: 10, note: 'compra' })).body.balance).toBe(10);
    expect((await call(noc, 'POST', `/api/stock/items/${item.id}/movements`, { kind: 'out', qty: 11 })).status).toBe(409);
    expect((await call(noc, 'POST', `/api/stock/items/${item.id}/movements`, { kind: 'adjust', qty: -1 })).status).toBe(400);          // ajuste sem justificativa
    expect((await call(noc, 'POST', `/api/stock/items/${item.id}/movements`, { kind: 'in', qty: -3 })).status).toBe(400);
    expect((await call(beta, 'POST', `/api/stock/items/${item.id}/movements`, { kind: 'in', qty: 1 })).status).toBe(404);

    expect((await call(noc, 'POST', `/api/work-orders/${wo.id}/materials`, { item_id: item.id, qty: 4 })).body.balance).toBe(6);
    expect((await call(noc, 'POST', `/api/work-orders/${wo.id}/materials`, { item_id: item.id, qty: 7 })).status).toBe(409);
    expect((await call(noc, 'POST', `/api/work-orders/${wo.id}/materials`, { item_id: item.id, qty: -5 })).status).toBe(400);         // devolve mais do que usou
    expect((await call(noc, 'POST', `/api/work-orders/${wo.id}/materials`, { item_id: item.id, qty: -1 })).body.balance).toBe(7);
    // duas saídas simultâneas de 4 com saldo 7: só uma passa
    const par = await Promise.all([1, 2].map(() => call(noc, 'POST', `/api/stock/items/${item.id}/movements`, { kind: 'out', qty: 4 })));
    expect(par.map((r) => r.status).sort()).toEqual([200, 409]);
    const lista = (await call(noc, 'GET', '/api/stock/items')).body.find((i: any) => i.id === item.id);
    expect(lista).toMatchObject({ balance: 3, low: true });
    expect((await call(beta, 'GET', '/api/stock/items')).body.some((i: any) => i.id === item.id)).toBe(false);
  });

  it('concluir exige descrição; OS encerrada não muda nem recebe material', async () => {
    expect((await call(noc, 'POST', `/api/work-orders/${wo.id}/status`, { status: 'done' })).status).toBe(400);
    expect((await call(noc, 'POST', `/api/work-orders/${wo.id}/status`, { status: 'done', resolution: 'conector refeito' })).body).toMatchObject({ status: 'done' });
    expect((await call(noc, 'POST', `/api/work-orders/${wo.id}/status`, { status: 'open' })).status).toBe(400);
    expect((await call(noc, 'PATCH', `/api/work-orders/${wo.id}`, { description: 'mudou' })).status).toBe(400);
    expect((await call(noc, 'POST', `/api/work-orders/${wo.id}/materials`, { item_id: item.id, qty: 1 })).status).toBe(400);
    const d = (await call(noc, 'GET', `/api/work-orders/${wo.id}`)).body;
    expect(d.materials.map((m: any) => m.qty)).toEqual([4, -1]);
    expect(d.events.map((e: any) => e.event)).toEqual(expect.arrayContaining(['created', 'assigned', 'scheduled', 'status', 'material']));
    expect(d.finished_at).toBeTruthy();
  });
});

describe('estoque por número de série', () => {
  it('unidade rastreada da entrada à instalação e à retirada; saldo sempre igual às unidades disponíveis', async () => {
    const item = (await call(noc, 'POST', '/api/stock/items', { name: `ONU série ${tag}`, serialized: true })).body;
    const saldo = async () => (await call(noc, 'GET', '/api/stock/items')).body.find((i: any) => i.id === item.id);
    expect((await call(noc, 'POST', `/api/stock/items/${item.id}/movements`, { kind: 'in', qty: 3 })).status).toBe(400);           // só por unidade
    expect((await call(noc, 'POST', `/api/stock/items/${item.id}/units`, { serials: [`sn${tag}a`, `SN${tag}A`, `SN${tag}B`, `SN${tag}C`] })).body).toMatchObject({ received: 3, balance: 3 });
    expect((await call(noc, 'POST', `/api/stock/items/${item.id}/units`, { serials: [`SN${tag}B`] })).status).toBe(409);            // série repetida
    expect((await saldo()).balance).toBe(3);
    expect((await call(noc, 'PATCH', `/api/stock/items/${item.id}`, { serialized: false })).status).toBe(409);
    const [a, b, c] = (await call(noc, 'GET', `/api/stock/items/${item.id}/units`)).body;
    expect((await call(beta, 'POST', `/api/stock/units/${a.id}/transfer`, { holder_id: null })).status).toBe(404);

    const eu = (await call(noc, 'GET', '/api/me')).body;
    const tecnicoBeta = (await call(beta, 'GET', '/api/staff')).body[0];
    expect((await call(noc, 'POST', `/api/stock/units/${a.id}/transfer`, { holder_id: tecnicoBeta.id })).status).toBe(400);
    await call(noc, 'POST', `/api/stock/units/${a.id}/transfer`, { holder_id: eu.id });
    expect(await saldo()).toMatchObject({ balance: 3, with_tech: 1 });                                                               // com o técnico ainda é do provedor
    expect((await call(noc, 'GET', `/api/stock/units?holder=${eu.id}`)).body.map((u: any) => u.serial)).toEqual([`SN${tag}A`]);

    const wo = (await call(noc, 'POST', '/api/work-orders', { kind: 'install', subscriber_id: sub.id, contract_id: contract.id, description: 'instalar ONU' })).body;
    const semContrato = (await call(noc, 'POST', '/api/work-orders', { kind: 'install', subscriber_id: sub.id, description: 'sem contrato' })).body;
    expect((await call(noc, 'POST', `/api/work-orders/${semContrato.id}/units`, { unit_id: a.id })).status).toBe(400);
    expect((await call(noc, 'POST', `/api/work-orders/${wo.id}/materials`, { item_id: item.id, qty: 1 })).status).toBe(400);        // item com série não entra por quantidade
    expect((await call(noc, 'POST', `/api/work-orders/${wo.id}/units`, { unit_id: a.id })).body.balance).toBe(2);
    expect((await call(noc, 'POST', `/api/work-orders/${wo.id}/units`, { unit_id: a.id })).status).toBe(409);                       // a mesma unidade não se instala duas vezes
    const onde = (await call(noc, 'GET', `/api/stock/units?serial=SN${tag}A`)).body[0];
    expect(onde).toMatchObject({ status: 'installed', contract_id: contract.id, work_order_number: wo.number, holder_id: null });
    expect((await call(noc, 'GET', `/api/work-orders/${wo.id}`)).body.materials).toHaveLength(1);

    expect((await call(noc, 'POST', `/api/stock/units/${b.id}/status`, { status: 'written_off' })).status).toBe(400);               // baixa exige motivo
    await call(noc, 'POST', `/api/stock/units/${b.id}/status`, { status: 'written_off', note: 'queimada por raio' });
    expect((await saldo()).balance).toBe(1);
    expect((await call(noc, 'POST', `/api/stock/units/${b.id}/status`, { status: 'in_stock' })).status).toBe(400);
    await call(noc, 'POST', `/api/stock/units/${a.id}/status`, { status: 'in_stock' });                                               // retirada do assinante
    expect((await saldo()).balance).toBe(2);
    const disponiveis = (await call(noc, 'GET', `/api/stock/items/${item.id}/units`)).body.filter((u: any) => u.status === 'in_stock' || u.status === 'with_tech');
    expect(disponiveis.map((u: any) => u.serial).sort()).toEqual([`SN${tag}A`, `SN${tag}C`]);
    expect((await call(noc, 'GET', `/api/stock/units/${a.id}/events`)).body.map((e: any) => e.event)).toEqual(['returned', 'installed', 'to_tech', 'received']);
    expect((await call(beta, 'GET', `/api/stock/units?serial=SN${tag}`)).body).toEqual([]);
    expect(c.status).toBe('in_stock');
  });
});

describe('FTTH', () => {
  it('porta única por contrato e por caixa; ciclo entre caixas recusado; outro provedor não vê', async () => {
    const olt = (await call(admin, 'POST', '/api/devices', { name: `olt-ftth-${tag}`, driver: 'olt_demo' })).body;
    const nas = (await call(admin, 'POST', '/api/devices', { name: `nas-ftth-${tag}`, driver: 'demo' })).body;
    expect((await call(admin, 'POST', '/api/ftth/boxes', { name: `x-${tag}`, kind: 'cto', ports: 8, device_id: nas.id })).status).toBe(400);   // NAS não é OLT
    const ceo = (await call(admin, 'POST', '/api/ftth/boxes', { name: `CEO-${tag}`, kind: 'ceo', ports: 4, device_id: olt.id, pon_port: '0/1/3' })).body;
    const cto = (await call(admin, 'POST', '/api/ftth/boxes', { name: `CTO-${tag}`, kind: 'cto', ports: 8, parent_id: ceo.id, latitude: -23.5, longitude: -46.6 })).body;
    expect((await call(admin, 'PATCH', `/api/ftth/boxes/${ceo.id}`, { parent_id: cto.id })).status).toBe(400);                                // ciclo
    expect((await call(admin, 'PATCH', `/api/ftth/boxes/${ceo.id}`, { parent_id: ceo.id })).status).toBe(400);

    expect((await call(admin, 'POST', `/api/ftth/boxes/${cto.id}/drops`, { port: 9, contract_id: contract.id })).status).toBe(400);           // caixa tem 8
    expect((await call(admin, 'POST', `/api/ftth/boxes/${cto.id}/drops`, { port: 3 })).status).toBe(400);                                      // sem contrato nem anotação
    expect((await call(admin, 'POST', `/api/ftth/boxes/${cto.id}/drops`, { port: 3, contract_id: contract.id })).status).toBe(200);
    expect((await call(admin, 'POST', `/api/ftth/boxes/${cto.id}/drops`, { port: 3, note: 'reserva' })).status).toBe(409);                    // porta ocupada
    expect((await call(admin, 'POST', `/api/ftth/boxes/${cto.id}/drops`, { port: 4, contract_id: contract.id })).status).toBe(409);           // contrato já tem porta
    expect((await call(admin, 'PATCH', `/api/ftth/boxes/${cto.id}`, { ports: 2 })).status).toBe(409);
    expect((await call(admin, 'DELETE', `/api/ftth/boxes/${cto.id}`)).status).toBe(409);
    expect((await call(admin, 'DELETE', `/api/ftth/boxes/${ceo.id}`)).status).toBe(409);                                                       // tem caixa derivada

    expect((await call(admin, 'GET', `/api/contracts/${contract.id}/ftth`)).body.drop).toMatchObject({ box_name: `CTO-${tag}`, port: 3 });
    expect((await call(beta, 'GET', '/api/ftth/boxes')).body.some((b: any) => b.id === cto.id)).toBe(false);
    expect((await call(beta, 'POST', `/api/ftth/boxes/${cto.id}/drops`, { port: 5, note: 'x' })).status).toBe(404);
    expect((await call(noc, 'GET', `/api/ftth/boxes/${cto.id}`)).body.drops).toHaveLength(1);

    const drop = (await call(admin, 'GET', `/api/ftth/boxes/${cto.id}`)).body.drops[0];
    expect((await call(admin, 'DELETE', `/api/ftth/drops/${drop.id}`)).status).toBe(200);
    expect((await call(admin, 'DELETE', `/api/ftth/boxes/${cto.id}`)).status).toBe(200);
  });
});
