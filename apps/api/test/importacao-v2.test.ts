import { beforeAll, describe, expect, it } from 'vitest';
import { withScope } from '../src/db.js';
import { call, login } from './helpers.js';

// Modelo canônico v2 da importação: dados da pessoa, contatos com consentimento, MAC, etiquetas, POP, fidelidade,
// indicação e histórico financeiro (pago, parcial, cancelado). Colunas ausentes nunca apagam dados existentes.
let admin: string, tenantId: string, deviceId: string;
const tag = String(Date.now()).slice(-6);
const planName = `Plano imp v2 ${tag}`;
const popName = `POP Imp ${tag}`;
const source = `teste-v2-${tag}`;
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const br = (iso: string) => iso.split('-').reverse().join('/');
const sql = async (q: string, p: unknown[] = []) => withScope({ tenantId, operator: false }, async (c) => (await c.query(q, p)).rows);
const run = async (kind: string, csv: string, apply = true) =>
  (await call(admin, 'POST', apply ? '/api/import/apply' : '/api/import/preview', { kind, csv, source, device_id: deviceId, filename: `${kind}.csv` })).body;

beforeAll(async () => {
  admin = await login('admin@alfa.demo');
  tenantId = (await call(admin, 'GET', '/api/me')).body.tenant.id;
  await call(admin, 'POST', '/api/plans', { name: planName, price_cents: 9990, down_kbps: 100000, up_kbps: 50000, profile_name: `iv${tag}` });
  deviceId = (await call(admin, 'POST', '/api/devices', { name: `nas-imp-v2-${tag}`, driver: 'demo' })).body.id;
  await call(admin, 'POST', '/api/pops', { name: popName });
});

describe('assinantes v2', () => {
  const cols = ['id_externo', 'nome', 'plano', 'vencimento_dia', 'pppoe_usuario', 'pppoe_senha', 'nascimento', 'rg', 'nome_mae', 'celular', 'whatsapp', 'aceita_avisos',
    'inicio_contrato', 'mac', 'etiquetas', 'pop', 'fidelidade_ate', 'multa_valor', 'multa_modelo', 'indicado_por'];
  const header = cols.join(';');
  const row = (o: Record<string, string>) => cols.map((c) => o[c] ?? '').join(';');
  const fim = day(300);
  const base = { plano: planName, vencimento_dia: '10' };
  const rows = [
    row({ ...base, id_externo: 'V1', nome: `Indicador ${tag}`, pppoe_usuario: `v1${tag}`, pppoe_senha: 'senha123' }),
    row({ ...base, id_externo: 'V2', nome: `Cliente Completo ${tag}`, vencimento_dia: '12', pppoe_usuario: `v2${tag}`, pppoe_senha: 'senha123', nascimento: '15/03/1990', rg: '1234567',
      nome_mae: 'Maria Souza', celular: '81999990001', whatsapp: '81999990001', aceita_avisos: 'sim', inicio_contrato: '01/02/2026', mac: 'aa-bb-cc-00-11-22',
      etiquetas: 'vip|fibra', pop: popName, fidelidade_ate: br(fim), multa_valor: '300,00', multa_modelo: 'fixo', indicado_por: 'V1' }),
    row({ ...base, id_externo: 'V3', nome: `Sem Consentimento ${tag}`, vencimento_dia: '5', celular: '81988887777' }),
    row({ ...base, id_externo: 'V4', nome: `Nascimento Ruim ${tag}`, nascimento: '31/02/1990' }),
    row({ ...base, id_externo: 'V5', nome: `Multa Sem Valor ${tag}`, pop: popName, fidelidade_ate: br(fim), multa_modelo: 'fixo' }),
    row({ ...base, id_externo: 'V6', nome: `MAC Ruim ${tag}`, pppoe_usuario: `v6${tag}`, pppoe_senha: 'senha123', mac: 'zz:zz' }),
  ];
  const csv = [header, ...rows].join('\n');

  it('prévia não grava; aplicar traz tudo; linhas ruins ficam como erro com a causa', async () => {
    const pv = await run('subscribers', csv, false);
    expect(pv.totals).toMatchObject({ rows: 6, created: 3, error: 3 });
    expect((await sql(`select 1 from subscribers where external_source = $1`, [source])).length).toBe(0);
    const ap = await run('subscribers', csv);
    expect(ap.applied).toBe(true);
    const erros = Object.fromEntries(ap.rows.filter((r: any) => r.status === 'error').map((r: any) => [r.external_id, r.messages.join(' ')]));
    expect(erros.V4).toMatch(/nascimento inválido/);
    expect(erros.V5).toMatch(/multa_valor/);
    expect(erros.V6).toMatch(/MAC inválido/);
    expect(ap.totals).toMatchObject({ contacts_created: 3, tags_applied: 2, loyalty_set: 1 });
  });

  it('dados da pessoa, contrato, MAC, etiquetas, POP, fidelidade e indicação entram; consentimento só quando o arquivo diz sim', async () => {
    const [s] = await sql(`select s.*, k.id as contract_id, k.start_date, k.loyalty_until, k.penalty_model, k.penalty_cents, k.pop_id, k.referred_by_subscriber_id
                           from subscribers s join contracts k on k.subscriber_id = s.id where s.external_source = $1 and s.external_id = 'V2'`, [source]);
    expect(String(s.birth_date)).toMatch(/^1990-03-15/);
    expect(s).toMatchObject({ rg: '1234567', mother_name: 'Maria Souza', penalty_model: 'fixed', penalty_cents: 30000 });
    expect(String(s.start_date)).toMatch(/^2026-02-01/);
    expect(String(s.loyalty_until)).toMatch(new RegExp(`^${day(300)}`));
    expect(s.pop_id).toBeTruthy();
    const ind = (await sql(`select id from subscribers where external_source = $1 and external_id = 'V1'`, [source]))[0];
    expect(s.referred_by_subscriber_id).toBe(ind.id);
    const tags = (await sql(`select t.name from contract_tags ct join tags t on t.id = ct.tag_id where ct.contract_id = $1 order by 1`, [s.contract_id])).map((r) => r.name);
    expect(tags).toEqual(['fibra', 'vip']);
    const mac = (await sql(`select mac from service_resources where external_source = $1 and external_id = 'V2'`, [source]))[0].mac;
    expect(mac).toBe('AA:BB:CC:00:11:22');
    const contatos = await sql(`select kind, value, allow_notices from subscriber_contacts where subscriber_id = $1 order by kind`, [s.id]);
    expect(contatos).toEqual([{ kind: 'mobile', value: '81999990001', allow_notices: true }, { kind: 'whatsapp', value: '81999990001', allow_notices: true }]);
    // arquivo sem a coluna aceita_avisos: contato entra SEM consentimento
    const v3 = (await sql(`select c.allow_notices from subscriber_contacts c join subscribers s on s.id = c.subscriber_id where s.external_source = $1 and s.external_id = 'V3'`, [source]))[0];
    expect(v3.allow_notices).toBe(false);
    // quem indicou aparece no relatório
    expect((await call(admin, 'GET', '/api/reports/referrals')).body.find((r: any) => r.referrer_id === ind.id)).toMatchObject({ referred: 1 });
  });

  it('reimportar não duplica contato, etiqueta nem fidelidade; arquivo sem as colunas v2 não apaga nada', async () => {
    const again = await run('subscribers', [header, ...rows.slice(0, 3)].join('\n'));
    expect(again.totals).toMatchObject({ created: 0, error: 0, contacts_created: 0, tags_applied: 0, loyalty_set: 0 });
    // mesmo assinante, arquivo "antigo" só com as colunas básicas
    const basico = await run('subscribers', ['id_externo;nome', `V2;Cliente Completo ${tag}`].join('\n'));
    expect(basico.totals.error).toBe(0);
    const [s] = await sql(`select birth_date, rg, mother_name from subscribers where external_source = $1 and external_id = 'V2'`, [source]);
    expect(String(s.birth_date)).toMatch(/^1990-03-15/);
    expect(s.rg).toBe('1234567');
    expect(s.mother_name).toBe('Maria Souza');
    expect((await sql(`select 1 from subscriber_contacts c join subscribers s on s.id = c.subscriber_id where s.external_source = $1 and s.external_id = 'V2'`, [source])).length).toBe(2);
  });

  it('POP inexistente vira aviso, não erro, e a linha entra', async () => {
    const r = await run('subscribers', [header, row({ ...base, id_externo: 'V7', nome: `Pop Faltando ${tag}`, pop: 'POP Que Nao Existe' })].join('\n'));
    expect(r.totals).toMatchObject({ created: 1, error: 0, pops_unmatched: ['POP Que Nao Existe'] });
  });
});

describe('títulos v2 (histórico financeiro)', () => {
  const header = 'id_externo;id_externo_assinante;vencimento;valor;competencia;descricao;situacao;pago_em;valor_pago;forma_pagamento';
  const rows = [
    `T1;V2;10/01/2026;99,90;2026-01;Mensalidade jan;pago;12/01/2026;;pix`,
    `T2;V2;10/02/2026;99,90;2026-02;Mensalidade fev;pago;11/02/2026;50,00;boleto`,
    `T3;V2;10/03/2026;99,90;2026-03;Mensalidade mar;cancelado;;;`,
    `T4;V2;10/04/2026;99,90;2026-04;Mensalidade abr;aberto;;;`,
    `T5;V2;10/05/2026;99,90;2026-05;Mensalidade mai;pago;;;`,
    `T6;V2;10/06/2026;99,90;2026-06;Mensalidade jun;talvez;;;`,
  ];
  const csv = [header, ...rows].join('\n');

  it('pago, parcial, cancelado e aberto entram com o estado certo; pago sem data e situação estranha são erro', async () => {
    const ap = await run('invoices', csv);
    const erros = Object.fromEntries(ap.rows.filter((r: any) => r.status === 'error').map((r: any) => [r.external_id, r.messages.join(' ')]));
    expect(erros.T5).toMatch(/pago_em/);
    expect(erros.T6).toMatch(/situação do título desconhecida/);
    expect(ap.totals).toMatchObject({ created: 4, error: 2, invoices_paid: 1, invoices_partial: 1, invoices_canceled: 1, paid_cents_total: 9990 + 5000 });
    // saldo em aberto = título aberto (9990) + restante do parcial (4990)
    expect(ap.totals.amount_cents_total).toBe(9990 + 4990);
    const inv = Object.fromEntries((await sql(
      `select external_id, status, amount_cents, to_char(paid_at, 'YYYY-MM-DD') as paid_at,
              (select coalesce(sum(signed_cents), 0)::int from payments p where p.invoice_id = i.id) as paid_cents
       from invoices i where external_source = $1`, [source])).map((r) => [r.external_id, r]));
    expect(inv.T1).toMatchObject({ status: 'paid', paid_at: '2026-01-12', paid_cents: 9990 });
    expect(inv.T2).toMatchObject({ status: 'open', paid_cents: 5000 });
    expect(inv.T3).toMatchObject({ status: 'canceled', paid_cents: 0 });
    expect(inv.T4).toMatchObject({ status: 'open', paid_cents: 0 });
    // fatura histórica nunca vai ao gateway
    expect((await sql(`select 1 from invoices where external_source = $1 and gateway_charge_id is not null`, [source])).length).toBe(0);
  });

  it('reimportar os títulos não duplica pagamento', async () => {
    const again = await run('invoices', csv);
    expect(again.totals).toMatchObject({ created: 0, unchanged: 4, error: 2 });
    expect((await sql(`select count(*)::int n from payments p join invoices i on i.id = p.invoice_id where i.external_source = $1`, [source]))[0].n).toBe(2);
  });
});
