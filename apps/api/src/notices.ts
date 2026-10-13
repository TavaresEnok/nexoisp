import { assertSafeWebhookUrl } from './notify.js';
import { noScope, withScope, type Tx } from './db.js';
import { decryptSecret } from './network/crypto.js';

/** Variáveis que um modelo pode usar. Nome desconhecido é recusado ao salvar: nada de "{xyz}" indo para o assinante. */
export const VARS = ['nome', 'valor', 'vencimento', 'plano', 'link'] as const;
export function templateVars(body: string): string[] {
  return [...body.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]);
}
export function unknownVars(body: string): string[] {
  return [...new Set(templateVars(body).filter((v) => !(VARS as readonly string[]).includes(v)))];
}
export function render(body: string, vars: Record<string, string>): string {
  return body.replace(/\{([a-z_]+)\}/g, (_, k) => vars[k] ?? '').replace(/\s{2,}/g, ' ').trim();
}

export interface Channel { url: string; phone_field: string; message_field: string; extra_body: Record<string, unknown>; headers_enc: string | null }

/** Envia UMA mensagem. Sem redirecionamento, limite de tempo, destino validado como nos webhooks (HTTPS e nunca rede interna). */
export async function sendMessage(ch: Channel, phone: string, message: string): Promise<void> {
  const u = await assertSafeWebhookUrl(ch.url);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (ch.headers_enc) {
    const h = JSON.parse(decryptSecret(ch.headers_enc)) as Record<string, string>;
    for (const [k, v] of Object.entries(h)) if (/^[A-Za-z0-9-]{1,40}$/.test(k)) headers[k] = String(v);
  }
  const r = await fetch(u, { method: 'POST', headers, body: JSON.stringify({ ...ch.extra_body, [ch.phone_field]: phone, [ch.message_field]: message }),
    redirect: 'error', signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`o provedor de envio respondeu ${r.status}`);
}

const MAX_ATTEMPTS = 3;
const SYS = (tenantId: string) => ({ tenantId, operator: false });
const brl = (cents: number) => `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;

/**
 * Régua de cobrança de UM provedor: para cada regra ativa, os títulos em aberto que estão exatamente no dia relativo ao vencimento.
 * Garantias: no máximo um aviso por regra e título; só para contato com consentimento; só dentro da janela; nunca repete cegamente
 * (falha conta tentativa e para na terceira); contrato encerrado ou assinante inativo não recebe.
 */
export async function runNotices(tenantId: string, opts: { force?: boolean } = {}): Promise<{ sent: number; failed: number; skipped: number }> {
  const out = { sent: 0, failed: 0, skipped: 0 };
  await withScope(SYS(tenantId), async (c: Tx) => {
    const t = (await c.query(
      `select coalesce((select timezone from tenant_settings where tenant_id = $1), 'America/Sao_Paulo') as tz,
              (select 'messages' = any(modules) from tenants where id = $1) as enabled,
              extract(hour from now() at time zone coalesce((select timezone from tenant_settings where tenant_id = $1), 'America/Sao_Paulo'))::int as hour,
              extract(dow from now() at time zone coalesce((select timezone from tenant_settings where tenant_id = $1), 'America/Sao_Paulo'))::int as dow`, [tenantId])).rows[0];
    if (!t.enabled && !opts.force) return;
    const rules = (await c.query(
      `select r.*, tp.body, ch.url, ch.phone_field, ch.message_field, ch.extra_body, ch.headers_enc
       from notice_rules r join notice_templates tp on tp.id = r.template_id join notice_channels ch on ch.id = r.channel_id
       where r.active and tp.active and ch.active`)).rows;
    for (const r of rules) {
      if (t.hour < r.hour_from || t.hour >= r.hour_to || !r.weekdays.includes(t.dow)) continue;   // fora da janela: nada é gravado; a próxima rodada tenta
      const cands = (await c.query(
        `select i.id as invoice_id, i.due_date::text as due, k.id as contract_id, s.id as subscriber_id, s.name, pl.name as plan_name,
                i.amount_cents + i.fee_cents - i.discount_cents - coalesce((select sum(p.signed_cents) from payments p where p.invoice_id = i.id), 0) as due_cents
         from invoices i join contracts k on k.id = i.contract_id join subscribers s on s.id = k.subscriber_id
         join plan_versions pv on pv.id = k.plan_version_id join plans pl on pl.id = pv.plan_id
         where i.status = 'open' and k.status = 'active' and s.status = 'active'
           and ((now() at time zone $1)::date - i.due_date) = $2
           and ($3::uuid is null or pl.id = $3) and ($4::uuid is null or k.pop_id = $4)
           and ($5::uuid is null or exists (select 1 from contract_tags x where x.contract_id = k.id and x.tag_id = $5))
           and not exists (select 1 from notice_log l where l.rule_id = $6 and l.invoice_id = i.id and (l.status in ('sent','skipped_no_consent') or l.attempts >= $7))
           and not exists (select 1 from notice_log l where l.subscriber_id = s.id and l.status = 'sent' and l.created_at > now() - make_interval(days => $8::int))
         order by i.due_date limit 500`,
        [t.tz, r.days_relative, r.plan_id, r.pop_id, r.tag_id, r.id, MAX_ATTEMPTS, r.min_interval_days])).rows;
      for (const k of cands) {
        const contact = (await c.query(
          `select value from subscriber_contacts where subscriber_id = $1 and allow_notices and kind in ('mobile','whatsapp') and purpose in ('billing','general')
           order by (purpose = 'billing') desc, created_at limit 1`, [k.subscriber_id])).rows[0];
        const log = (status: string, error: string | null = null, value: string | null = null) => c.query(
          `insert into notice_log (tenant_id, rule_id, invoice_id, contract_id, subscriber_id, contact_value, status, error)
           values ($1,$2,$3,$4,$5,$6,$7,$8)
           on conflict (rule_id, invoice_id) do update set status = excluded.status, error = excluded.error, contact_value = excluded.contact_value,
             attempts = notice_log.attempts + 1, created_at = now()`,
          [tenantId, r.id, k.invoice_id, k.contract_id, k.subscriber_id, value, status, error]);
        if (!contact) { await log('skipped_no_consent'); out.skipped++; continue; }
        const base = process.env.NEXO_PUBLIC_URL ? `${process.env.NEXO_PUBLIC_URL.replace(/\/$/, '')}/` : '';
        const msg = render(r.body, { nome: String(k.name).split(' ')[0], valor: brl(Number(k.due_cents)), vencimento: k.due.split('-').reverse().join('/'), plano: k.plan_name, link: base });
        try {
          await sendMessage(r, contact.value, msg);
          await log('sent', null, contact.value);
          out.sent++;
        } catch (e) {
          await log('failed', String((e as Error).message).slice(0, 300), contact.value);
          out.failed++;
        }
      }
    }
  });
  return out;
}

/** Rotina periódica: todos os provedores com o módulo ligado. */
export async function runNoticesAll(log: (m: string) => void = () => {}) {
  const tenants = (await withScope(noScope, async (c) => (await c.query('select tenant_id from worker_tenants()')).rows)).map((t) => t.tenant_id as string);
  for (const id of tenants) {
    try {
      const r = await runNotices(id);
      if (r.sent || r.failed) log(`avisos ao assinante: ${r.sent} enviado(s), ${r.failed} falha(s) para ${id}`);
    } catch (e) {
      log(`avisos ao assinante falharam para ${id}: ${(e as Error).message}`);
    }
  }
}
