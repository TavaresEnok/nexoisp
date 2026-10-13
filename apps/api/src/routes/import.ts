import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, guard, HttpError } from '../auth.js';
import { pool, type Tx } from '../db.js';
import { encryptSecret } from '../network/crypto.js';
import { requestOperation } from '../network/engine.js';
import { onlyDigits, validDocument, zUuid } from '../validators.js';
import { withScope } from '../db.js';

/**
 * Importador do FORMATO CSV INTERMEDIÁRIO do NexoISP (docs/importacao-csv.md).
 * Não é o formato do MK-Auth: a compatibilidade direta depende de uma exportação real autorizada.
 */
export const FIELDS = {
  subscribers: ['id_externo', 'nome', 'cpf_cnpj', 'email', 'telefone', 'logradouro', 'numero', 'bairro', 'cidade', 'uf', 'cep', 'observacoes',
    'situacao', 'plano', 'vencimento_dia', 'pppoe_usuario', 'pppoe_senha',
    // modelo v2 (opcionais): só atuam quando a coluna existe no arquivo; arquivo sem elas nunca apaga o que já está no sistema
    'nascimento', 'rg', 'nome_mae', 'nome_fantasia', 'celular', 'whatsapp', 'aceita_avisos', 'inicio_contrato', 'mac', 'etiquetas', 'pop',
    'fidelidade_ate', 'multa_valor', 'multa_modelo', 'indicado_por'],
  invoices: ['id_externo', 'id_externo_assinante', 'vencimento', 'valor', 'competencia', 'descricao', 'situacao', 'pago_em', 'valor_pago', 'forma_pagamento'],
} as const;
const REQUIRED = { subscribers: ['id_externo', 'nome'], invoices: ['id_externo', 'id_externo_assinante', 'vencimento', 'valor'] } as const;

export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const first = src.split(/\r?\n/, 1)[0] ?? '';
  const delim = (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [], cur = '', q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '"' && src[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some((v) => v.trim() !== '')) rows.push(row);
      row = [];
    } else cur += ch;
  }
  row.push(cur);
  if (row.some((v) => v.trim() !== '')) rows.push(row);
  return rows;
}

/** "1.234,56" | "1234.56" | "99" -> centavos, sem ponto flutuante. */
export function parseCents(v: string): number | null {
  let s = v.trim().replace(/^R\$\s*/, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const m = s.match(/^(\d{1,9})(?:\.(\d{1,2}))?$/);
  return m ? Number(m[1]) * 100 + Number((m[2] ?? '0').padEnd(2, '0')) : null;
}
function parseDate(v: string): string | null {
  const s = v.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) { const b = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/); if (b) m = [s, b[3], b[2], b[1]] as any; }
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`, d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null;
}

const zBody = z.object({
  kind: z.enum(['subscribers', 'invoices']),
  source: z.string().regex(/^[a-z0-9-]{2,40}$/, 'origem: minúsculas, números e hífen').default('csv-intermediario'),
  filename: z.string().max(200).optional(),
  csv: z.string().min(1).max(15 * 1024 * 1024),
  mapping: z.record(z.string()).optional(),       // campo do NexoISP -> nome da coluna no arquivo
  plan_map: z.record(zUuid).optional(),           // nome do plano no arquivo -> plano do NexoISP
  device_id: zUuid.nullish(),
});
type Body = z.infer<typeof zBody>;
interface RowResult { row: number; external_id: string | null; status: 'created' | 'updated' | 'unchanged' | 'error'; messages: string[]; entity_id?: string }
class RowError extends Error {}

const YES = new Set(['sim', 's', 'yes', 'y', '1', 'true', 'verdadeiro']);
const NO = new Set(['nao', 'não', 'n', 'no', '0', 'false', 'falso', '']);

async function importSubscriberRow(c: Tx, tenantId: string, b: Body, r: Record<string, string>, plans: Map<string, any>, totals: any, mapped: Set<string>): Promise<Omit<RowResult, 'row'>> {
  const msgs: string[] = [];
  const ext = r.id_externo;
  if (!ext) throw new RowError('id_externo ausente');
  if (!r.nome || r.nome.length < 2) throw new RowError('nome ausente');
  const doc = r.cpf_cnpj ? onlyDigits(r.cpf_cnpj) : null;
  if (doc && !validDocument(doc)) throw new RowError(`CPF/CNPJ inválido: ${r.cpf_cnpj}`);
  if (r.email && !z.string().email().safeParse(r.email).success) throw new RowError(`e-mail inválido: ${r.email}`);
  const sit = (r.situacao || 'ativo').toLowerCase();
  if (!['ativo', 'inativo'].includes(sit)) throw new RowError(`situação desconhecida: "${r.situacao}" (use ativo ou inativo)`);
  const vals = [r.nome, doc, r.email || null, r.telefone || null, r.logradouro || null, r.numero || null, r.bairro || null, r.cidade || null,
    (r.uf || '').toUpperCase().slice(0, 2) || null, r.cep || null, r.observacoes || null, sit === 'ativo' ? 'active' : 'inactive'];
  const cols = ['name', 'document', 'email', 'phone', 'address_street', 'address_number', 'address_district', 'address_city', 'address_state', 'address_zip', 'notes', 'status'];
  // dados da pessoa (v2): só entram quando a coluna veio no arquivo
  if (mapped.has('nascimento')) {
    const bd = r.nascimento ? parseDate(r.nascimento) : null;
    if (r.nascimento && !bd) throw new RowError(`nascimento inválido: "${r.nascimento}" (use AAAA-MM-DD ou DD/MM/AAAA)`);
    cols.push('birth_date'); vals.push(bd);
  }
  if (mapped.has('rg')) {
    if (r.rg && !/^[0-9A-Za-z.\- /]{3,20}$/.test(r.rg)) throw new RowError(`RG inválido: "${r.rg}"`);
    cols.push('rg'); vals.push(r.rg || null);
  }
  if (mapped.has('nome_mae')) { if (r.nome_mae.length > 200) throw new RowError('nome da mãe acima de 200 caracteres'); cols.push('mother_name'); vals.push(r.nome_mae || null); }
  if (mapped.has('nome_fantasia')) { if (r.nome_fantasia.length > 200) throw new RowError('nome fantasia acima de 200 caracteres'); cols.push('trade_name'); vals.push(r.nome_fantasia || null); }

  let status: RowResult['status'];
  let sub = (await c.query('select * from subscribers where external_source = $1 and external_id = $2', [b.source, ext])).rows[0];
  if (sub) {
    const changed = cols.some((k, i) => (sub[k] ?? null) !== vals[i]);
    if (changed) await c.query(`update subscribers set ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1`, [sub.id, ...vals]);
    status = changed ? 'updated' : 'unchanged';
  } else {
    if (doc) {
      const clash = (await c.query('select name from subscribers where document = $1', [doc])).rows[0];
      if (clash) throw new RowError(`documento já cadastrado para "${clash.name}" sem vínculo com esta origem; confira antes de importar`);
    }
    sub = (await c.query(
      `insert into subscribers (tenant_id, ${cols.join(', ')}, external_source, external_id) values ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}, $${cols.length + 2}, $${cols.length + 3}) returning *`,
      [tenantId, ...vals, b.source, ext])).rows[0];
    status = 'created';
  }

  // contatos com consentimento explícito para avisos (padrão: sem consentimento)
  const consent = mapped.has('aceita_avisos') ? r.aceita_avisos.trim().toLowerCase() : '';
  if (mapped.has('aceita_avisos') && !YES.has(consent) && !NO.has(consent)) throw new RowError(`aceita_avisos inválido: "${r.aceita_avisos}" (use sim ou não)`);
  for (const [col, kind] of [['celular', 'mobile'], ['whatsapp', 'whatsapp']] as const) {
    if (!mapped.has(col) || !r[col]) continue;
    const val = r[col].trim();
    if (val.length < 3 || val.length > 200) throw new RowError(`${col} inválido: "${r[col]}"`);
    const has = (await c.query('select 1 from subscriber_contacts where subscriber_id = $1 and kind = $2 and value = $3', [sub.id, kind, val])).rowCount;
    if (!has) {
      await c.query(`insert into subscriber_contacts (tenant_id, subscriber_id, kind, value, purpose, allow_notices) values ($1,$2,$3,$4,'general',$5)`,
        [tenantId, sub.id, kind, val, YES.has(consent)]);
      totals.contacts_created++;
      if (status === 'unchanged') status = 'updated';
    }
  }

  if (r.plano) {
    const plan = plans.get(b.plan_map?.[r.plano] ?? '') ?? [...plans.values()].find((p) => p.name.toLowerCase() === r.plano.toLowerCase());
    if (!plan) { totals.plans_unmatched.add(r.plano); throw new RowError(`plano "${r.plano}" não corresponde a nenhum plano cadastrado; mapeie-o antes de importar`); }
    let k = (await c.query('select k.id, pv.plan_id from contracts k join plan_versions pv on pv.id = k.plan_version_id where k.external_source = $1 and k.external_id = $2', [b.source, ext])).rows[0];
    if (k) {
      if (k.plan_id !== plan.id) msgs.push('contrato já importado com outro plano; não foi alterado (troque pelo painel se necessário)');
    } else if (sit !== 'ativo') msgs.push('assinante inativo: contrato não criado');
    else {
      const due = Number(r.vencimento_dia);
      if (!Number.isInteger(due) || due < 1 || due > 28) throw new RowError(`vencimento_dia inválido: "${r.vencimento_dia}" (aceito: 1 a 28; ajuste na origem ou no arquivo)`);
      const start = mapped.has('inicio_contrato') && r.inicio_contrato ? parseDate(r.inicio_contrato) : null;
      if (mapped.has('inicio_contrato') && r.inicio_contrato && !start) throw new RowError(`inicio_contrato inválido: "${r.inicio_contrato}" (use AAAA-MM-DD ou DD/MM/AAAA)`);
      k = (await c.query(
        `insert into contracts (tenant_id, subscriber_id, plan_version_id, due_day, start_date, external_source, external_id)
         values ($1,$2,$3,$4,coalesce($5::date, current_date),$6,$7) returning id`,
        [tenantId, sub.id, plan.version_id, due, start, b.source, ext])).rows[0];
      await c.query(`insert into contract_history (tenant_id, contract_id, event, detail) values ($1,$2,'created',$3)`, [tenantId, k.id, JSON.stringify({ import: b.source, plan: plan.name, plan_version: plan.version })]);
      totals.contracts_created++;
      if (status === 'unchanged') status = 'updated';
    }
    if (k && r.pppoe_usuario) {
      const has = (await c.query('select 1 from service_resources where contract_id = $1', [k.id])).rowCount;
      if (!has) {
        if (!b.device_id) msgs.push('conta PPPoE não criada: selecione o equipamento (NAS) de destino');
        else {
          if (!/^[A-Za-z0-9_.@-]{3,64}$/.test(r.pppoe_usuario)) throw new RowError(`usuário PPPoE inválido: "${r.pppoe_usuario}"`);
          let mac: string | null = null;
          if (mapped.has('mac') && r.mac) {
            mac = r.mac.trim().toUpperCase().replace(/[-.]/g, ':');
            if (/^[0-9A-F]{12}$/.test(mac.replace(/:/g, ''))) mac = mac.replace(/:/g, '').match(/.{2}/g)!.join(':');
            if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac)) throw new RowError(`MAC inválido: "${r.mac}"`);
          }
          // credencial ausente NÃO vira senha inventada: a conta fica sem segredo até ser informada
          await c.query(
            `insert into service_resources (tenant_id, contract_id, device_id, pppoe_username, secret_enc, desired_profile, mac, external_source, external_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [tenantId, k.id, b.device_id, r.pppoe_usuario, r.pppoe_senha ? encryptSecret(r.pppoe_senha) : null, plan.profile_name, mac, b.source, ext]);
          totals.accounts_created++;
          if (!r.pppoe_senha) { totals.accounts_without_secret++; msgs.push('sem senha PPPoE no arquivo: credencial indisponível, conta não poderá ser provisionada até informar a senha'); }
          if (status === 'unchanged') status = 'updated';
        }
      }
    }
    if (k) {
      const extras = await applyContractExtras(c, tenantId, b, k.id, r, mapped, totals, msgs);
      if (extras && status === 'unchanged') status = 'updated';
    }
  } else if (r.pppoe_usuario) msgs.push('pppoe_usuario ignorado: linha sem plano/contrato');
  return { external_id: ext, status, messages: msgs, entity_id: sub.id };
}


/**
 * Etiquetas, POP, fidelidade e indicação do contrato. Não destrutivo: preenche o que está vazio e acrescenta etiquetas;
 * nunca troca POP, fidelidade ou indicador que já existam (isso é decisão de quem opera, pelo painel).
 */
async function applyContractExtras(c: Tx, tenantId: string, b: Body, contractId: string, r: Record<string, string>, mapped: Set<string>, totals: any, msgs: string[]): Promise<boolean> {
  let changed = false;
  if (mapped.has('etiquetas') && r.etiquetas) {
    for (const name of r.etiquetas.split('|').map((s) => s.trim()).filter(Boolean)) {
      if (name.length < 2 || name.length > 40) throw new RowError(`etiqueta inválida: "${name}" (2 a 40 caracteres)`);
      const tag = (await c.query(
        `insert into tags (tenant_id, name) values ($1,$2) on conflict (tenant_id, name) do update set name = excluded.name returning id`, [tenantId, name])).rows[0];
      const ins = await c.query(`insert into contract_tags (tenant_id, contract_id, tag_id) values ($1,$2,$3) on conflict do nothing`, [tenantId, contractId, tag.id]);
      if (ins.rowCount) { totals.tags_applied++; changed = true; }
    }
  }
  if (mapped.has('pop') && r.pop) {
    const pop = (await c.query('select id from pops where lower(name) = lower($1) and active', [r.pop])).rows[0];
    if (!pop) { totals.pops_unmatched.add(r.pop); msgs.push(`POP "${r.pop}" não existe: cadastre-o e reimporte para vincular`); }
    else if ((await c.query('update contracts set pop_id = $2 where id = $1 and pop_id is null', [contractId, pop.id])).rowCount) changed = true;
  }
  if (mapped.has('fidelidade_ate') && r.fidelidade_ate) {
    const until = parseDate(r.fidelidade_ate);
    if (!until) throw new RowError(`fidelidade_ate inválida: "${r.fidelidade_ate}" (use AAAA-MM-DD ou DD/MM/AAAA)`);
    const fee = parseCents(r.multa_valor ?? '');
    if (fee === null) throw new RowError(`multa_valor inválido ou ausente: "${r.multa_valor}" (obrigatório com fidelidade_ate)`);
    const model = (r.multa_modelo || 'fixo').toLowerCase();
    if (!['fixo', 'mensal'].includes(model)) throw new RowError(`multa_modelo desconhecido: "${r.multa_modelo}" (use fixo ou mensal)`);
    if ((await c.query(
      `update contracts set loyalty_until = $2, penalty_model = $3, penalty_cents = $4 where id = $1 and loyalty_until is null`,
      [contractId, until, model === 'mensal' ? 'monthly' : 'fixed', fee])).rowCount) { totals.loyalty_set++; changed = true; }
  }
  if (mapped.has('indicado_por') && r.indicado_por) {
    const ref = (await c.query('select id from subscribers where external_source = $1 and external_id = $2', [b.source, r.indicado_por])).rows[0];
    if (!ref) msgs.push(`indicador "${r.indicado_por}" não encontrado nesta origem: importe-o antes e reimporte`);
    else if ((await c.query(
      `update contracts set referred_by_subscriber_id = $2 where id = $1 and referred_by_subscriber_id is null and subscriber_id <> $2`, [contractId, ref.id])).rowCount) changed = true;
  }
  return changed;
}

async function importInvoiceRow(c: Tx, tenantId: string, b: Body, r: Record<string, string>, totals: any): Promise<Omit<RowResult, 'row'>> {
  const ext = r.id_externo;
  // situação do título na origem: aberto (padrão), pago, cancelado. Histórico pago/cancelado não vira cobrança.
  const sit = (r.situacao || 'aberto').toLowerCase();
  if (!['aberto', 'pago', 'cancelado'].includes(sit)) throw new RowError(`situação do título desconhecida: "${r.situacao}" (use aberto, pago ou cancelado)`);
  if (!ext) throw new RowError('id_externo ausente');
  const cents = parseCents(r.valor ?? '');
  if (cents === null || cents <= 0) throw new RowError(`valor inválido: "${r.valor}"`);
  const due = parseDate(r.vencimento ?? '');
  if (!due) throw new RowError(`vencimento inválido: "${r.vencimento}" (use AAAA-MM-DD ou DD/MM/AAAA)`);
  let comp: string | null = null;
  if (r.competencia) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(r.competencia)) throw new RowError(`competência inválida: "${r.competencia}" (use AAAA-MM)`);
    comp = `${r.competencia}-01`;
  }
  const k = (await c.query('select id, subscriber_id from contracts where external_source = $1 and external_id = $2', [b.source, r.id_externo_assinante])).rows[0];
  if (!k) throw new RowError(`contrato do assinante "${r.id_externo_assinante}" não encontrado nesta origem; importe os assinantes antes`);
  const ex = (await c.query('select id, amount_cents, due_date from invoices where external_source = $1 and external_id = $2', [b.source, ext])).rows[0];
  if (ex) {
    const same = ex.amount_cents === cents && ex.due_date === due;
    return { external_id: ext, status: 'unchanged', entity_id: ex.id, messages: same ? [] : ['título já importado com valor/vencimento diferentes; não foi alterado'] };
  }
  if (comp && (await c.query(`select 1 from invoices where contract_id = $1 and competence = $2 and kind = 'monthly'`, [k.id, comp])).rowCount)
    throw new RowError(`já existe mensalidade da competência ${r.competencia} para este contrato; título não importado para evitar cobrança em dobro`);
  let paidAt: string | null = null, paidCents = 0;
  if (sit === 'pago') {
    paidAt = parseDate(r.pago_em ?? '');
    if (!paidAt) throw new RowError(`pago_em inválido ou ausente: "${r.pago_em}" (obrigatório para título pago)`);
    paidCents = r.valor_pago ? (parseCents(r.valor_pago) ?? -1) : cents;
    if (paidCents <= 0) throw new RowError(`valor_pago inválido: "${r.valor_pago}"`);
    if (paidCents > cents * 2) throw new RowError(`valor_pago (${r.valor_pago}) muito acima do valor do título; confira o arquivo`);
  }
  const full = sit === 'pago' && paidCents >= cents;      // pagamento a menor deixa o título em aberto com o que já foi pago
  const status = sit === 'cancelado' ? 'canceled' : full ? 'paid' : 'open';
  const i = (await c.query(
    `insert into invoices (tenant_id, contract_id, subscriber_id, kind, competence, due_date, amount_cents, status, paid_at, canceled_at, status_note, external_source, external_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
    [tenantId, k.id, k.subscriber_id, comp ? 'monthly' : 'manual', comp, due, cents, status, full ? paidAt : null, status === 'canceled' ? new Date() : null,
      status === 'canceled' ? `cancelado na origem (${b.source})` : null, b.source, ext])).rows[0];
  await c.query('insert into invoice_items (tenant_id, invoice_id, description, amount_cents) values ($1,$2,$3,$4)', [tenantId, i.id, r.descricao || `Título importado (${b.source} ${ext})`, cents]);
  const msgs: string[] = [];
  if (sit === 'pago') {
    await c.query(`insert into payments (tenant_id, invoice_id, amount_cents, paid_at, method, source, note) values ($1,$2,$3,$4,$5,'manual',$6)`,
      [tenantId, i.id, paidCents, paidAt, r.forma_pagamento || null, `Importado de ${b.source} (id ${ext})`]);
    totals.paid_cents_total += paidCents;
    if (full) totals.invoices_paid++; else { totals.invoices_partial++; msgs.push(`pagamento parcial (${(paidCents / 100).toFixed(2).replace('.', ',')} de ${(cents / 100).toFixed(2).replace('.', ',')}): título segue em aberto pelo saldo`); }
  } else if (sit === 'cancelado') totals.invoices_canceled++;
  if (status === 'open') totals.amount_cents_total += cents - paidCents;
  return { external_id: ext, status: 'created', messages: msgs, entity_id: i.id };
}

/** Prévia e aplicação usam o MESMO código; a prévia executa tudo e desfaz (rollback). */
async function runImport(ctx: { tenantId: string; userId: string }, b: Body, apply: boolean) {
  const table = parseCsv(b.csv);
  if (table.length < 2) throw new HttpError(400, 'arquivo sem linhas de dados');
  const headers = table[0].map((h) => h.trim());
  const fields = FIELDS[b.kind] as readonly string[];
  const norm = (s: string) => s.trim().toLowerCase();
  const mapping: Record<string, string | null> = {};
  for (const f of fields) {
    const want = b.mapping?.[f];
    mapping[f] = want !== undefined ? (headers.includes(want) ? want : null) : headers.find((h) => norm(h) === f) ?? null;
  }
  const missing = REQUIRED[b.kind].filter((f) => !mapping[f]);
  const mapped = new Set(Object.entries(mapping).filter(([, v]) => v).map(([k]) => k));   // colunas que existem no arquivo
  const rows: RowResult[] = [];
  const totals: any = { rows: table.length - 1, created: 0, updated: 0, unchanged: 0, error: 0, contracts_created: 0, accounts_created: 0, accounts_without_secret: 0, amount_cents_total: 0, plans_unmatched: new Set<string>(),
    contacts_created: 0, tags_applied: 0, loyalty_set: 0, pops_unmatched: new Set<string>(), invoices_paid: 0, invoices_partial: 0, invoices_canceled: 0, paid_cents_total: 0 };
  let batchId: string | null = null;

  const c = await pool().connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('app.tenant_id', $1, true), set_config('app.is_operator', 'off', true), set_config('app.subscriber_id', '', true)`, [ctx.tenantId]);
    if (missing.length === 0) {
      const plans = new Map<string, any>((await c.query(
        `select p.id, p.name, v.id as version_id, v.version, v.profile_name from plans p
         join lateral (select * from plan_versions x where x.plan_id = p.id order by version desc limit 1) v on true where p.active`)).rows.map((p) => [p.id, p]));
      if (b.device_id && !(await c.query('select 1 from devices where id = $1', [b.device_id])).rowCount) throw new HttpError(400, 'equipamento não encontrado');
      const seen = new Set<string>();
      for (let n = 1; n < table.length; n++) {
        const rec: Record<string, string> = {};
        for (const f of fields) rec[f] = mapping[f] ? (table[n][headers.indexOf(mapping[f]!)] ?? '').trim() : '';
        let res: RowResult;
        await c.query('savepoint r');
        try {
          if (rec.id_externo && seen.has(rec.id_externo)) throw new RowError(`id_externo "${rec.id_externo}" repetido no arquivo`);
          seen.add(rec.id_externo);
          res = { row: n + 1, ...(b.kind === 'subscribers' ? await importSubscriberRow(c, ctx.tenantId, b, rec, plans, totals, mapped) : await importInvoiceRow(c, ctx.tenantId, b, rec, totals)) };
          await c.query('release savepoint r');
        } catch (e: any) {
          await c.query('rollback to savepoint r');
          const msg = e instanceof RowError ? e.message : e.code === '23505' ? `conflito com registro existente (${e.constraint})` : e.code ? `erro de dados (${e.code})` : null;
          if (!msg) throw e;
          res = { row: n + 1, external_id: rec.id_externo || null, status: 'error', messages: [msg] };
        }
        totals[res.status]++;
        rows.push(res);
      }
    }
    totals.plans_unmatched = [...totals.plans_unmatched];
    totals.pops_unmatched = [...totals.pops_unmatched];
    if (apply && missing.length === 0) {
      batchId = (await c.query('insert into import_batches (tenant_id, source, kind, filename, totals, created_by) values ($1,$2,$3,$4,$5,$6) returning id',
        [ctx.tenantId, b.source, b.kind, b.filename ?? null, JSON.stringify(totals), ctx.userId])).rows[0].id;
      for (const r of rows)
        await c.query('insert into import_rows (tenant_id, batch_id, row_number, external_id, status, messages, entity_id) values ($1,$2,$3,$4,$5,$6,$7)',
          [ctx.tenantId, batchId, r.row, r.external_id, r.status, JSON.stringify(r.messages), r.entity_id ?? null]);
      await c.query(`insert into audit_events (tenant_id, actor_type, actor_id, action, entity_type, entity_id, detail) values ($1,'user',$2,'import.apply','import_batch',$3,$4)`,
        [ctx.tenantId, ctx.userId, batchId, JSON.stringify(totals)]);
      await c.query('commit');
    } else await c.query('rollback');
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
  return { applied: apply && missing.length === 0, batch_id: batchId, headers, fields, mapping, missing_required: missing, totals,
    rows: rows.filter((r) => r.status === 'error' || r.messages.length).slice(0, 500), sample: rows.slice(0, 20) };
}

export async function importRoutes(app: FastifyInstance) {
  app.post('/api/import/preview', { preHandler: guard('import:run') }, async (req) =>
    runImport({ tenantId: req.ctx.tenantId!, userId: req.ctx.userId }, zBody.parse(req.body), false));

  app.post('/api/import/apply', { preHandler: guard('import:run') }, async (req) => {
    const r = await runImport({ tenantId: req.ctx.tenantId!, userId: req.ctx.userId }, zBody.parse(req.body), true);
    if (!r.applied) throw new HttpError(400, `colunas obrigatórias sem mapeamento: ${r.missing_required.join(', ')}`);
    return r;
  });

  app.get('/api/import/batches', { preHandler: guard('import:run') }, async (req) =>
    withScope(req.ctx.scope, async (c) =>
      (await c.query(
        `select b.*, u.name as created_by_name,
                (select count(*) from service_resources r join import_rows ir on ir.batch_id = b.id and ir.external_id = r.external_id
                  where r.external_source = b.source and r.desired_version = 0 and r.secret_enc is not null) as accounts_to_provision
         from import_batches b left join users u on u.id = b.created_by order by b.created_at desc limit 50`)).rows));

  app.get('/api/import/batches/:id', { preHandler: guard('import:run') }, async (req) =>
    withScope(req.ctx.scope, async (c) =>
      (await c.query(`select row_number as row, external_id, status, messages from import_rows where batch_id = $1 and (status = 'error' or messages <> '[]') order by row_number limit 1000`,
        [zUuid.parse((req.params as any).id)])).rows));

  /** Virada controlada: provisiona no RADIUS/NAS as contas importadas deste lote que têm credencial. Ação explícita e auditada. */
  app.post('/api/import/batches/:id/provision', { preHandler: guard('import:run') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    return withScope(req.ctx.scope, async (c) => {
      const res = (await c.query(
        `select r.id from service_resources r join import_batches b on b.id = $1 and b.source = r.external_source
         join import_rows ir on ir.batch_id = b.id and ir.external_id = r.external_id
         join contracts k on k.id = r.contract_id
         where r.desired_version = 0 and r.secret_enc is not null and k.status = 'active'`, [id])).rows;
      for (const r of res)
        await requestOperation(c, req.ctx.tenantId!, r.id, 'subscriber.provision', { type: 'user', id: req.ctx.userId, reason: 'provisionamento de lote importado' });
      await audit(c, req.ctx, 'import.provision_batch', 'import_batch', id, { requested: res.length });
      return { requested: res.length };
    });
  });
}
