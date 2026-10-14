import { beforeAll, describe, expect, it } from 'vitest';
import { fakeCpf } from '../src/seed.js';
import { call, login } from './helpers.js';

// Coleta de acessos da ANATEL (DICI): contratos em serviço no fim do mês, por CNPJ, município (IBGE), cliente, área, meio, tecnologia e velocidade.
let admin: string, atend: string;
const r = 100 + (Date.now() % 800);
const CITY = `Vila Anatel ${r}`, IBGE = `31${String(10000 + r).slice(-5)}`, CNPJ = `${String(11222333000100 + r * 100).padStart(14, '0')}`;
const COMP = '2031-06';
let empresa: any, fibra: string, radio: string;
const contrato = async (plan: string, opts: { cnpj?: boolean; area?: 'rural'; ended?: boolean } = {}) => {
  const sub = (await call(admin, 'POST', '/api/subscribers', { name: `Dici ${r} ${Math.random()}`, document: opts.cnpj ? '11444777000161' : fakeCpf(Math.floor(Math.random() * 1e6)) })).body;
  const k = (await call(admin, 'POST', '/api/contracts', { subscriber_id: sub.id, plan_id: plan, due_day: 10 })).body.id;
  await call(admin, 'PUT', `/api/contracts/${k}/install-address`, { street: 'Rua A', city: CITY.toUpperCase().replace('VILA', 'VÍLA'), state: 'MG' });   // grafia diferente casa
  await call(admin, 'PUT', `/api/contracts/${k}/company`, { company_id: empresa.id });
  if (opts.area) await call(admin, 'PUT', `/api/contracts/${k}/service-area`, { service_area: opts.area });
  if (opts.ended) await call(admin, 'PATCH', `/api/contracts/${k}`, { end: true });
  return k;
};

beforeAll(async () => {
  admin = await login('admin@alfa.demo'); atend = await login('atendimento@alfa.demo');
  empresa = (await call(admin, 'POST', '/api/companies', { name: `Empresa DICI ${r}`, document: CNPJ })).body;
  fibra = (await call(admin, 'POST', '/api/plans', { name: `Fibra DICI ${r}`, price_cents: 9900, down_kbps: 300000, up_kbps: 150000, profile_name: `dicif${r}` })).body.id;
  radio = (await call(admin, 'POST', '/api/plans', { name: `Rádio DICI ${r}`, price_cents: 5900, down_kbps: 20000, up_kbps: 5000, profile_name: `dicir${r}` })).body.id;
});

describe('ANATEL — coleta de acessos (DICI)', () => {
  it('aponta o que falta: município sem código IBGE e plano sem tecnologia', async () => {
    await contrato(fibra);
    const d = (await call(admin, 'GET', `/api/anatel/dici?competence=${COMP}`)).body;
    expect(d.pending.cities_without_code.some((c: any) => c.state === 'MG' && /ANATEL/i.test(c.city))).toBe(true);
    expect(d.pending.plans_without_technology.some((p: any) => p.id === fibra)).toBe(true);
    expect(d.rows.some((x: any) => x.ibge_code === IBGE)).toBe(false);
    expect((await call(atend, 'GET', `/api/anatel/dici?competence=${COMP}`)).status).toBe(403);
  });

  it('código IBGE confere com a UF; tecnologia do plano vem de lista fechada', async () => {
    expect((await call(admin, 'PUT', '/api/anatel/municipalities', { name: CITY, state: 'MG', ibge_code: '3550308' })).status).toBe(400);   // 35 = SP
    expect((await call(admin, 'PUT', '/api/anatel/municipalities', { name: CITY, state: 'MG', ibge_code: IBGE })).status).toBe(200);
    expect((await call(admin, 'PUT', `/api/plans/${fibra}/technology`, { access_technology: 'FIBRA' })).status).toBe(400);
    expect((await call(admin, 'PUT', `/api/plans/${fibra}/technology`, { access_technology: 'FTTH' })).status).toBe(200);
    expect((await call(admin, 'PUT', `/api/plans/${radio}/technology`, { access_technology: 'RADIO' })).status).toBe(200);
  });

  it('agrupa por cliente, área, meio, tecnologia e velocidade; encerrado antes do fim do mês fica fora; CSV no leiaute', async () => {
    await contrato(fibra); await contrato(fibra, { cnpj: true }); await contrato(radio, { area: 'rural' }); await contrato(fibra, { ended: true });
    const d = (await call(admin, 'GET', `/api/anatel/dici?competence=${COMP}`)).body;
    const mine = d.rows.filter((x: any) => x.ibge_code === IBGE && x.cnpj === CNPJ);
    const find = (o: object) => mine.find((x: any) => Object.entries(o).every(([k, v]) => x[k] === v));
    expect(find({ tipo_cliente: 'PF', tipo_atendimento: 'URBANO', meio: 'fibra', tecnologia: 'FTTH', velocidade_mbps: 300 })?.acessos).toBe(2);   // 1º teste + este
    expect(find({ tipo_cliente: 'PJ', tecnologia: 'FTTH' })?.acessos).toBe(1);
    expect(find({ tipo_atendimento: 'RURAL', meio: 'radio', tecnologia: 'RADIO', velocidade_mbps: 20 })?.acessos).toBe(1);
    expect(mine.reduce((s: number, x: any) => s + x.acessos, 0)).toBe(4);      // o encerrado não conta
    const csv = await call(admin, 'GET', `/api/anatel/dici?competence=${COMP}&format=csv`);
    expect(String(csv.body)).toMatch(/^CNPJ;ANO;MES;COD_IBGE;TIPO_CLIENTE;TIPO_ATENDIMENTO;TIPO_MEIO;TIPO_PRODUTO;TIPO_TECNOLOGIA;VELOCIDADE;ACESSOS/);
    expect(String(csv.body)).toContain(`${CNPJ};2031;06;${IBGE};PF;URBANO;fibra;internet;FTTH;300;2`);
  });
});
