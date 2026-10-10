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
    'situacao', 'plano', 'vencimento_dia', 'pppoe_usuario', 'pppoe_senha'],
  invoices: ['id_externo', 'id_externo_assinante', 'vencimento', 'valor', 'competencia', 'descricao'],
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

async function importSubscriberRow(c: Tx, tenantId: string, b: Body, r: Record<string, string>, plans: Map<string, any>, totals: any): Promise<Omit<RowResult, 'row'>> {
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
      `insert into subscribers (tenant_id, ${cols.join(', ')}, external_source, external_id) values ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}, $14, $15) returning *`,
      [tenantId, ...vals, b.source, ext])).rows[0];
    status = 'created';
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
      k = (await c.query(
        `insert into contracts (tenant_id, subscriber_id, plan_version_id, due_day, external_source, external_id) values ($1,$2,$3,$4,$5,$6) returning id`,
        [tenantId, sub.id, plan.version_id, due, b.source, ext])).rows[0];
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
          // credencial ausente NÃO vira senha inventada: a conta fica sem segredo até ser informada
          await c.query(
            `insert into service_resources (tenant_id, contract_id, device_id, pppoe_username, secret_enc, desired_profile, external_source, external_id) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [tenantId, k.id, b.device_id, r.pppoe_usuario, r.pppoe_senha ? encryptSecret(r.pppoe_senha) : null, plan.profile_name, b.source, ext]);
          totals.accounts_created++;
          if (!r.pppoe_senha) { totals.accounts_without_secret++; msgs.push('sem senha PPPoE no arquivo: credencial indisponível, conta não poderá ser provisionada até informar a senha'); }
          if (status === 'unchanged') status = 'updated';
        }
      }
    }
  } else if (r.pppoe_usuario) msgs.push('pppoe_usuario ignorado: linha sem plano/contrato');
  return { external_id: ext, status, messages: msgs, entity_id: sub.id };
}

async function importInvoiceRow(c: Tx, tenantId: string, b: Body, r: Record<string, string>, totals: any): Promise<Omit<RowResult, 'row'>> {
  const ext = r.id_externo;
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
  const i = (await c.query(
    `insert into invoices (tenant_id, contract_id, subscriber_id, kind, competence, due_date, amount_cents, external_source, external_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`, [tenantId, k.id, k.subscriber_id, comp ? 'monthly' : 'manual', comp, due, cents, b.source, ext])).rows[0];
  await c.query('insert into invoice_items (tenant_id, invoice_id, description, amount_cents) values ($1,$2,$3,$4)', [tenantId, i.id, r.descricao || `Título importado (${b.source} ${ext})`, cents]);
  totals.amount_cents_total += cents;
  return { external_id: ext, status: 'created', messages: [], entity_id: i.id };
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
  const rows: RowResult[] = [];
  const totals: any = { rows: table.length - 1, created: 0, updated: 0, unchanged: 0, error: 0, contracts_created: 0, accounts_created: 0, accounts_without_secret: 0, amount_cents_total: 0, plans_unmatched: new Set<string>() };
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
          res = { row: n + 1, ...(b.kind === 'subscribers' ? await importSubscriberRow(c, ctx.tenantId, b, rec, plans, totals) : await importInvoiceRow(c, ctx.tenantId, b, rec, totals)) };
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
