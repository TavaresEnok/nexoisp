import { beforeAll, describe, expect, it } from 'vitest';
import { call, login } from './helpers.js';

// Mapa geográfico: coordenadas por contrato e POP, consulta por retângulo visível, isolamento entre provedores.
let admin: string, beta: string, fin: string;
const r = 10 + (Date.now() % 80);                 // desloca o ponto para não colidir com outras execuções
const LAT = -(20 + r / 100), LNG = -(40 + r / 100);
const area = (d = 0.05) => `south=${LAT - d}&north=${LAT + d}&west=${LNG - d}&east=${LNG + d}`;
let contractId: string, popId: string;

beforeAll(async () => {
  admin = await login('admin@alfa.demo'); beta = await login('admin@beta.demo'); fin = await login('financeiro@alfa.demo');
  const plan = (await call(admin, 'POST', '/api/plans', { name: `Plano mapa ${r}`, price_cents: 5000, down_kbps: 1000, up_kbps: 1000, profile_name: `mapa${r}` })).body.id;
  const sub = (await call(admin, 'POST', '/api/subscribers', { name: `Mapa Assinante ${r}` })).body;
  contractId = (await call(admin, 'POST', '/api/contracts', { subscriber_id: sub.id, plan_id: plan, due_day: 10 })).body.id;
  await call(admin, 'PUT', `/api/contracts/${contractId}/install-address`, { street: 'Rua do Mapa', number: '10', district: 'Centro', city: 'Vila', state: 'MG' });
  popId = (await call(admin, 'POST', '/api/pops', { name: `POP mapa ${r}`, city: 'Vila', state: 'MG' })).body.id;
});

describe('mapa geográfico', () => {
  it('contrato sem coordenada não aparece; com coordenada aparece só dentro do retângulo', async () => {
    expect((await call(admin, 'GET', `/api/map/points?${area()}`)).body.contracts.find((p: any) => p.id === contractId)).toBeUndefined();
    const put = await call(admin, 'PUT', `/api/contracts/${contractId}/location`, { latitude: LAT, longitude: LNG });
    expect(put.status).toBe(200);
    const dentro = (await call(admin, 'GET', `/api/map/points?${area()}&layers=contracts`)).body;
    const p = dentro.contracts.find((x: any) => x.id === contractId);
    expect(p).toMatchObject({ status: 'active', policy: 'active', address: 'Rua do Mapa 10, Centro, Vila' });
    expect(p.lat).toBeCloseTo(LAT, 5);
    expect(dentro.boxes).toBeUndefined();                                   // só as camadas pedidas
    const fora = (await call(admin, 'GET', `/api/map/points?south=${LAT + 1}&north=${LAT + 2}&west=${LNG}&east=${LNG + 1}`)).body;
    expect(fora.contracts.find((x: any) => x.id === contractId)).toBeUndefined();
  });

  it('latitude e longitude andam juntas, dentro dos limites, e limpar remove do mapa', async () => {
    expect((await call(admin, 'PUT', `/api/contracts/${contractId}/location`, { latitude: LAT, longitude: null })).status).toBe(400);
    expect((await call(admin, 'PUT', `/api/contracts/${contractId}/location`, { latitude: 120, longitude: LNG })).status).toBe(400);
    expect((await call(admin, 'PUT', `/api/contracts/${contractId}/location`, { latitude: null, longitude: null })).status).toBe(200);
    expect((await call(admin, 'GET', `/api/map/points?${area()}`)).body.contracts.find((p: any) => p.id === contractId)).toBeUndefined();
  });

  it('filtro por situação: encerrado não entra em "ativo"', async () => {
    await call(admin, 'PUT', `/api/contracts/${contractId}/location`, { latitude: LAT, longitude: LNG });
    const todos = (await call(admin, 'GET', `/api/map/points?${area()}&layers=contracts&status=active`)).body.contracts;
    expect(todos.some((p: any) => p.id === contractId)).toBe(true);
    const enc = (await call(admin, 'GET', `/api/map/points?${area()}&layers=contracts&status=ended`)).body.contracts;
    expect(enc.some((p: any) => p.id === contractId)).toBe(false);
  });

  it('POP com coordenada aparece na camada de POPs; cobertura conta o que já foi posicionado', async () => {
    expect((await call(admin, 'PUT', `/api/pops/${popId}/location`, { latitude: LAT, longitude: LNG })).status).toBe(200);
    const m = (await call(admin, 'GET', `/api/map/points?${area()}&layers=pops`)).body;
    expect(m.pops.some((p: any) => p.id === popId)).toBe(true);
    const cov = (await call(admin, 'GET', '/api/map/coverage')).body;
    expect(cov.contracts.located).toBeGreaterThanOrEqual(1);
    expect(cov.pops.located).toBeGreaterThanOrEqual(1);
  });

  it('outro provedor não vê nem altera; financeiro não posiciona contrato', async () => {
    const b = (await call(beta, 'GET', `/api/map/points?${area(1)}`)).body;
    expect(b.contracts.some((p: any) => p.id === contractId)).toBe(false);
    expect((await call(beta, 'PUT', `/api/contracts/${contractId}/location`, { latitude: 1, longitude: 1 })).status).toBe(404);
    expect((await call(fin, 'PUT', `/api/contracts/${contractId}/location`, { latitude: 1, longitude: 1 })).status).toBe(403);
    expect((await call(fin, 'GET', `/api/map/points?${area()}`)).status).toBe(200);   // leitura é permitida
  });
});
