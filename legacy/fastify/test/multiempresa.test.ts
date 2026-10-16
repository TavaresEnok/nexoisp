import { beforeAll, describe, expect, it } from 'vitest';
import { call, login } from './helpers.js';

// Multiempresa: a fatura nasce com a empresa do contrato; filtros e isolamento.
let admin: string, beta: string, fin: string, planId: string;
const r = 100 + (Date.now() % 800);
const cnpj = (n: number) => String(10000000000000 + r * 1000 + n).padStart(14, '0');
let matriz: any, filial: any;
const novoContrato = async (nome: string) => {
  const sub = (await call(admin, 'POST', '/api/subscribers', { name: `${nome} ${r}` })).body;
  return (await call(admin, 'POST', '/api/contracts', { subscriber_id: sub.id, plan_id: planId, due_day: 10 })).body.id as string;
};
const manual = (contract_id: string) => call(admin, 'POST', '/api/invoices', { contract_id, description: 'Taxa avulsa', due_date: '2031-05-10', amount_cents: 7000 });

beforeAll(async () => {
  admin = await login('admin@alfa.demo'); beta = await login('admin@beta.demo'); fin = await login('financeiro@alfa.demo');
  planId = (await call(admin, 'POST', '/api/plans', { name: `Plano emp ${r}`, price_cents: 5000, down_kbps: 1000, up_kbps: 1000, profile_name: `emp${r}` })).body.id;
});

describe('multiempresa', () => {
  it('cadastro: CNPJ com 14 dígitos, nome único, uma só empresa padrão', async () => {
    expect((await call(admin, 'POST', '/api/companies', { name: `Matriz ${r}`, document: '123' })).status).toBe(400);
    matriz = (await call(admin, 'POST', '/api/companies', { name: `Matriz ${r}`, document: cnpj(1) })).body;
    expect(matriz.id).toBeTruthy();
    filial = (await call(admin, 'POST', '/api/companies', { name: `Filial ${r}`, document: cnpj(2) })).body;
    expect((await call(admin, 'POST', '/api/companies', { name: `Filial ${r}` })).status).toBe(409);        // nome repetido
    expect((await call(admin, 'POST', '/api/companies', { name: `Outra ${r}`, document: cnpj(2) })).status).toBe(409);   // CNPJ repetido
    expect((await call(admin, 'PATCH', `/api/companies/${filial.id}`, { is_default: true })).status).toBe(200);
    const lista = (await call(admin, 'GET', '/api/companies')).body;
    expect(lista.filter((e: any) => e.is_default)).toHaveLength(1);
    expect(lista.find((e: any) => e.is_default).id).toBe(filial.id);
    expect((await call(admin, 'PATCH', `/api/companies/${filial.id}`, { active: false })).status).toBe(409);   // a padrão não desativa
    expect((await call(fin, 'POST', '/api/companies', { name: `Sem permissão ${r}` })).status).toBe(403);
  });

  it('a fatura nasce com a empresa do contrato; sem empresa vale a padrão; mudar depois não altera as emitidas', async () => {
    const k = await novoContrato('Cli A');
    const semEmpresa = (await manual(k)).body;
    expect(semEmpresa.company_id).toBe(filial.id);                       // padrão
    expect((await call(admin, 'PUT', `/api/contracts/${k}/company`, { company_id: matriz.id })).status).toBe(200);
    const comMatriz = (await manual(k)).body;
    expect(comMatriz.company_id).toBe(matriz.id);
    expect((await call(admin, 'GET', `/api/invoices/${semEmpresa.id}`)).body.company_id).toBe(filial.id);   // a antiga ficou como estava
  });

  it('filtro por empresa na lista de faturas, no resumo e nos contratos', async () => {
    const k = await novoContrato('Cli B');
    await call(admin, 'PUT', `/api/contracts/${k}/company`, { company_id: matriz.id });
    const f = (await manual(k)).body;
    const lista = (await call(admin, 'GET', `/api/invoices?company_id=${matriz.id}&limit=500`)).body;
    expect(lista.some((i: any) => i.id === f.id)).toBe(true);
    expect(lista.every((i: any) => i.company_id === matriz.id)).toBe(true);
    const outra = (await call(admin, 'GET', `/api/invoices?company_id=${filial.id}&limit=500`)).body;
    expect(outra.some((i: any) => i.id === f.id)).toBe(false);
    const sm = (await call(admin, 'GET', `/api/finance/summary?company_id=${matriz.id}`)).body;
    const sf = (await call(admin, 'GET', `/api/finance/summary?company_id=${filial.id}`)).body;
    const st = (await call(admin, 'GET', '/api/finance/summary')).body;
    expect(Number(sm.open) + Number(sf.open)).toBeLessThanOrEqual(Number(st.open));
    expect(Number(sm.open)).toBeGreaterThanOrEqual(2);                   // as duas faturas da matriz criadas acima
    const ct = (await call(admin, 'GET', `/api/contracts?company_id=${matriz.id}&limit=500`)).body;
    expect(ct.some((x: any) => x.id === k)).toBe(true);
    expect(ct.every((x: any) => x.company_id === matriz.id)).toBe(true);
  });

  it('outro provedor não vê as empresas nem pode usá-las em contrato', async () => {
    expect((await call(beta, 'GET', '/api/companies')).body.some((e: any) => e.id === matriz.id)).toBe(false);
    const k = await novoContrato('Cli C');
    expect((await call(admin, 'PUT', `/api/contracts/${k}/company`, { company_id: '00000000-0000-4000-8000-000000000000' })).status).toBe(400);
    const subB = (await call(beta, 'POST', '/api/subscribers', { name: `Beta ${r}` })).body;
    const planB = (await call(beta, 'POST', '/api/plans', { name: `Plano B ${r}`, price_cents: 5000, down_kbps: 1000, up_kbps: 1000, profile_name: `eb${r}` })).body.id;
    const kb = (await call(beta, 'POST', '/api/contracts', { subscriber_id: subB.id, plan_id: planB, due_day: 10 })).body.id;
    expect((await call(beta, 'PUT', `/api/contracts/${kb}/company`, { company_id: matriz.id })).status).toBe(400);
  });
});
