// Medição curta com volume SINTÉTICO (não é o volume do piloto, que ainda é desconhecido). Rodar: ./nexo load-check
import { describe, expect, it } from 'vitest';
import { fakeCpf } from '../src/seed.js';
import { call, login, testAgent } from './helpers.js';

const N = Number(process.env.NEXO_LOAD_N ?? 5000);
const ms = async <T>(label: string, fn: () => Promise<T>) => { const t = performance.now(); const r = await fn(); console.log(`MEDIDA ${label}: ${Math.round(performance.now() - t)} ms`); return r; };

describe('carga sintética', () => {
  it(`importa ${N} assinantes e mede operações comuns`, async () => {
    const admin = await login('admin@beta.demo');
    await call(admin, 'PUT', '/api/finance/settings', { gateway: 'demo', billing_auto: false, auto_suspend: false, suspend_after_days: null, auto_resume_on_payment: false });
    const ag = await testAgent(admin, `carga-${Date.now()}`);
    const rows = ['id_externo;nome;cpf_cnpj;situacao;plano;vencimento_dia;pppoe_usuario;pppoe_senha'];
    for (let i = 0; i < N; i++) rows.push(`C${i};Cliente Carga ${i};${fakeCpf(100000 + i)};ativo;Fibra 200;${1 + (i % 28)};carga${i};senha-${i}`);
    const body = { kind: 'subscribers', source: 'carga', csv: rows.join('\n'), device_id: ag.deviceId };
    const r = await ms(`importar ${N} assinantes+contratos+contas`, () => call(admin, 'POST', '/api/import/apply', body));
    expect(r.body.totals.error).toBe(0);
    await ms(`reimportar ${N} (sem alterações)`, () => call(admin, 'POST', '/api/import/apply', body));
    await ms('buscar assinante por nome', () => call(admin, 'GET', '/api/subscribers?q=Carga%204321'));
    await ms('listar contratos (500)', () => call(admin, 'GET', '/api/contracts'));
    const g = await ms(`gerar mensalidades (${N}) + cobranças demo`, () => call(admin, 'POST', '/api/finance/generate', {}));
    console.log('MEDIDA faturas criadas:', g.body.created);
    await ms('listar faturas em aberto', () => call(admin, 'GET', '/api/invoices?status=open'));
    await ms('resumo financeiro', () => call(admin, 'GET', '/api/finance/summary'));
    const lote = (await call(admin, 'GET', '/api/import/batches')).body[0];
    await ms(`solicitar provisionamento do lote (${N} operações assinadas)`, () => call(admin, 'POST', `/api/import/batches/${lote.id}/provision`));
    const t = performance.now(); let done = 0;
    while (done < 200 && (await ag.runNext())) done++;
    console.log(`MEDIDA agente: ${done} operações (poll+begin+result) em ${Math.round(performance.now() - t)} ms`);
    await ms('saúde da rede com fila grande', () => call(admin, 'GET', '/api/network/health'));
  }, 600_000);
});
