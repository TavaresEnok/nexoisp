import { beforeAll, describe, expect, it } from 'vitest';
import { call, login } from './helpers.js';

// Histórico do sistema anterior: atendimentos, OS e anotações entram como registros já ocorridos, sem SLA, e reimportar não duplica.
let admin: string, atend: string;
const r = 100 + (Date.now() % 800), src = `hist-${r}`;
const subsCsv = `id_externo;nome;situacao\nH${r}-1;Cliente Historico ${r};ativo\n`;
const histCsv = [
  'id_externo;id_externo_assinante;tipo;data;assunto;descricao;situacao;encerrado_em;solucao;responsavel;categoria;tipo_os',
  `A1;H${r}-1;atendimento;2024-03-10 09:15;Sem internet;Cliente relata queda;fechado;10/03/2024 11:00;Troca do conector;Maria;técnico;`,
  `A2;H${r}-1;Ocorrência;2024-05-02;Boleto;Pediu 2ª via;aberto;;;João;financeiro;`,
  `O1;H${r}-1;os;2023-12-01 14:00;Instalação;Instalar fibra;concluído;2023-12-02 10:00;Instalado ONU;Carlos;;instalação`,
  `O2;H${r}-1;os;2024-01-05;Retirada;Retirar equipamento;cancelado;;;;;retirada`,
  `N1;H${r}-1;anotação;2022-07-01;;Cliente prefere contato por WhatsApp;;;;Ana;;`,
  `X1;H${r}-1;telefonema;2024-01-01;;x;;;;;;`,
  `X2;NAO-EXISTE;atendimento;2024-01-01;;x;;;;;;`,
  `X3;H${r}-1;atendimento;31/02/2024;;x;;;;;;`,
].join('\n');
let subscriberId: string;

beforeAll(async () => {
  admin = await login('admin@alfa.demo'); atend = await login('atendimento@alfa.demo');
  const s = (await call(admin, 'POST', '/api/import/apply', { kind: 'subscribers', source: src, csv: subsCsv })).body;
  expect(s.totals.created).toBe(1);
  subscriberId = s.sample[0].entity_id;                                    // o id que a importação devolveu (sem busca por nome)
  expect(subscriberId).toBeTruthy();
});

describe('importação do histórico do sistema anterior', () => {
  it('prévia não grava; erros por linha explicam o que corrigir', async () => {
    const pv = (await call(admin, 'POST', '/api/import/preview', { kind: 'history', source: src, csv: histCsv })).body;
    expect(pv.applied).toBe(false);
    expect(pv.totals).toMatchObject({ created: 5, error: 3 });
    const msgs = pv.rows.filter((x: any) => x.status === 'error').map((x: any) => x.messages[0]).join(' | ');
    expect(msgs).toMatch(/tipo desconhecido/);
    expect(msgs).toMatch(/não encontrado nesta origem/);
    expect(msgs).toMatch(/data inválida/);
    expect((await call(admin, 'GET', `/api/subscribers/${subscriberId}/notes`)).body).toHaveLength(0);
    expect((await call(atend, 'POST', '/api/import/preview', { kind: 'history', source: src, csv: histCsv })).status).toBe(403);
  });

  it('aplicar grava com a data original, sem SLA; reimportar não duplica', async () => {
    const ap = (await call(admin, 'POST', '/api/import/apply', { kind: 'history', source: src, csv: histCsv })).body;
    expect(ap.totals).toMatchObject({ created: 5, history_tickets: 2, history_work_orders: 2, history_notes: 1 });
    const tickets = (await call(admin, 'GET', `/api/tickets?subscriber_id=${subscriberId}&limit=50`)).body;
    const mine = (Array.isArray(tickets) ? tickets : tickets.rows ?? []).filter((t: any) => t.subscriber_id === subscriberId || t.subscriber_name === `Cliente Historico ${r}`);
    expect(mine.length).toBe(2);
    const fechado = mine.find((t: any) => t.subject === 'Sem internet');
    expect(fechado).toMatchObject({ status: 'closed', category: 'technical' });
    expect(new Date(fechado.created_at).toISOString()).toBe('2024-03-10T12:15:00.000Z');   // 09:15 em Brasília
    expect(fechado.sla_due_at ?? null).toBeNull();
    const det = (await call(admin, 'GET', `/api/tickets/${fechado.id}`)).body;
    expect(JSON.stringify(det)).toMatch(/Troca do conector/);
    expect(JSON.stringify(det)).toMatch(/responsável no sistema anterior: Maria/);
    const wos = (await call(admin, 'GET', `/api/work-orders?subscriber_id=${subscriberId}&limit=50`)).body;
    const wlist = (Array.isArray(wos) ? wos : wos.rows ?? []).filter((w: any) => w.subscriber_id === subscriberId);
    expect(wlist.map((w: any) => `${w.kind}:${w.status}`).sort()).toEqual(['install:done', 'removal:canceled']);
    const notes = (await call(admin, 'GET', `/api/subscribers/${subscriberId}/notes`)).body;
    expect(notes[0].body).toMatch(/WhatsApp/);
    const again = (await call(admin, 'POST', '/api/import/apply', { kind: 'history', source: src, csv: histCsv })).body;
    expect(again.totals).toMatchObject({ created: 0, unchanged: 5 });
  });
});
