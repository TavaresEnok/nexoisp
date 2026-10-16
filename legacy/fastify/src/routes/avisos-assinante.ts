import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, guard, HttpError } from '../auth.js';
import { withScope } from '../db.js';
import { encryptSecret } from '../network/crypto.js';
import { assertSafeWebhookUrl } from '../notify.js';
import { render, runNotices, sendMessage, unknownVars, VARS } from '../notices.js';
import { zUuid } from '../validators.js';

const SAMPLE = { nome: 'Maria', valor: 'R$ 79,90', vencimento: '10/11/2026', plano: 'Fibra 200', link: 'https://exemplo.invalido/' };

export async function avisosAssinanteRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- canais
  app.get('/api/notice-channels', { preHandler: guard('settings:manage') }, async (req) =>
    withScope(req.ctx.scope, async (c) =>
      (await c.query(`select id, name, url, phone_field, message_field, extra_body, active, (headers_enc is not null) as has_headers, created_at from notice_channels order by name`)).rows));

  app.post('/api/notice-channels', { preHandler: guard('settings:manage') }, async (req) => {
    const b = z.object({
      name: z.string().trim().min(2).max(60), url: z.string().trim().url().max(500),
      phone_field: z.string().regex(/^[A-Za-z0-9_.-]{1,40}$/).default('to'), message_field: z.string().regex(/^[A-Za-z0-9_.-]{1,40}$/).default('message'),
      extra_body: z.record(z.union([z.string().max(200), z.number(), z.boolean()])).default({}),
      headers: z.record(z.string().max(500)).default({}),
    }).parse(req.body);
    await assertSafeWebhookUrl(b.url);
    for (const k of Object.keys(b.headers)) if (!/^[A-Za-z0-9-]{1,40}$/.test(k)) throw new HttpError(400, `cabeçalho inválido: ${k}`);
    return withScope(req.ctx.scope, async (c) => {
      const r = (await c.query(
        `insert into notice_channels (tenant_id, name, url, phone_field, message_field, extra_body, headers_enc) values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (tenant_id, name) do nothing returning id, name`,
        [req.ctx.tenantId, b.name, b.url, b.phone_field, b.message_field, JSON.stringify(b.extra_body), Object.keys(b.headers).length ? encryptSecret(JSON.stringify(b.headers)) : null])).rows[0];
      if (!r) throw new HttpError(409, 'já existe um canal com este nome');
      await audit(c, req.ctx, 'notice_channel.create', 'notice_channel', r.id, { name: b.name, url_host: new URL(b.url).host, headers: Object.keys(b.headers) });   // o valor dos cabeçalhos nunca vai para a auditoria
      return r;
    });
  });

  app.patch('/api/notice-channels/:id', { preHandler: guard('settings:manage') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ active: z.boolean() }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const r = await c.query('update notice_channels set active = $2 where id = $1 returning id, active', [id, b.active]);
      if (!r.rowCount) throw new HttpError(404, 'canal não encontrado');
      await audit(c, req.ctx, 'notice_channel.update', 'notice_channel', id, b);
      return r.rows[0];
    });
  });

  app.delete('/api/notice-channels/:id', { preHandler: guard('settings:manage') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    return withScope(req.ctx.scope, async (c) => {
      if ((await c.query('select 1 from notice_rules where channel_id = $1', [id])).rowCount) throw new HttpError(409, 'há regras usando este canal');
      const r = await c.query('delete from notice_channels where id = $1', [id]);
      if (!r.rowCount) throw new HttpError(404, 'canal não encontrado');
      await audit(c, req.ctx, 'notice_channel.delete', 'notice_channel', id);
      return { ok: true };
    });
  });

  /** Envia uma mensagem de teste a um número informado pelo operador; fica registrado como "teste" e nunca como aviso de cobrança. */
  app.post('/api/notice-channels/:id/test', { preHandler: guard('settings:manage') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ phone: z.string().trim().min(8).max(20), message: z.string().trim().min(2).max(160).default('Teste de aviso do NexoISP.') }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const ch = (await c.query('select * from notice_channels where id = $1', [id])).rows[0];
      if (!ch) throw new HttpError(404, 'canal não encontrado');
      try {
        await sendMessage(ch, b.phone, b.message);
        await c.query(`insert into notice_log (tenant_id, contact_value, status) values ($1,$2,'test')`, [req.ctx.tenantId, b.phone]);
        await audit(c, req.ctx, 'notice_channel.test', 'notice_channel', id, { ok: true });
        return { ok: true };
      } catch (e) {
        await audit(c, req.ctx, 'notice_channel.test', 'notice_channel', id, { ok: false, error: (e as Error).message }, 'error');
        throw new HttpError(502, `o envio de teste falhou: ${(e as Error).message}`);
      }
    });
  });

  // ---------------------------------------------------------------- modelos
  app.get('/api/notice-templates', { preHandler: guard('settings:manage') }, async (req) =>
    withScope(req.ctx.scope, async (c) => ({
      variables: VARS, rows: (await c.query('select id, name, body, active from notice_templates order by name')).rows.map((r: any) => ({ ...r, preview: render(r.body, SAMPLE) })),
    })));

  app.post('/api/notice-templates', { preHandler: guard('settings:manage') }, async (req) => {
    const b = z.object({ name: z.string().trim().min(2).max(60), body: z.string().trim().min(3).max(480) }).parse(req.body);
    const bad = unknownVars(b.body);
    if (bad.length) throw new HttpError(400, `variável desconhecida: ${bad.map((v) => `{${v}}`).join(', ')}. Use: ${VARS.map((v) => `{${v}}`).join(', ')}`);
    return withScope(req.ctx.scope, async (c) => {
      const r = (await c.query(`insert into notice_templates (tenant_id, name, body) values ($1,$2,$3) on conflict (tenant_id, name) do nothing returning id, name`,
        [req.ctx.tenantId, b.name, b.body])).rows[0];
      if (!r) throw new HttpError(409, 'já existe um modelo com este nome');
      await audit(c, req.ctx, 'notice_template.create', 'notice_template', r.id, { name: b.name });
      return { ...r, preview: render(b.body, SAMPLE) };
    });
  });

  app.delete('/api/notice-templates/:id', { preHandler: guard('settings:manage') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    return withScope(req.ctx.scope, async (c) => {
      if ((await c.query('select 1 from notice_rules where template_id = $1', [id])).rowCount) throw new HttpError(409, 'há regras usando este modelo');
      if (!(await c.query('delete from notice_templates where id = $1', [id])).rowCount) throw new HttpError(404, 'modelo não encontrado');
      await audit(c, req.ctx, 'notice_template.delete', 'notice_template', id);
      return { ok: true };
    });
  });

  // ---------------------------------------------------------------- regras
  app.get('/api/notice-rules', { preHandler: guard('settings:manage') }, async (req) =>
    withScope(req.ctx.scope, async (c) =>
      (await c.query(
        `select r.id, r.name, r.days_relative, r.plan_id, r.pop_id, r.tag_id, r.hour_from, r.hour_to, r.weekdays, r.min_interval_days, r.active,
                t.name as template_name, ch.name as channel_name,
                (select count(*)::int from notice_log l where l.rule_id = r.id and l.status = 'sent') as sent
         from notice_rules r join notice_templates t on t.id = r.template_id join notice_channels ch on ch.id = r.channel_id order by r.days_relative, r.name`)).rows));

  app.post('/api/notice-rules', { preHandler: guard('settings:manage') }, async (req) => {
    const b = z.object({
      name: z.string().trim().min(2).max(80), template_id: zUuid, channel_id: zUuid, days_relative: z.number().int().min(-30).max(365),
      plan_id: zUuid.nullish(), pop_id: zUuid.nullish(), tag_id: zUuid.nullish(),
      hour_from: z.number().int().min(0).max(23).default(8), hour_to: z.number().int().min(1).max(24).default(20),
      weekdays: z.array(z.number().int().min(0).max(6)).min(1).default([0, 1, 2, 3, 4, 5, 6]), min_interval_days: z.number().int().min(0).max(60).default(1),
    }).parse(req.body);
    if (b.hour_from >= b.hour_to) throw new HttpError(400, 'a janela de envio precisa ter início antes do fim');
    return withScope(req.ctx.scope, async (c) => {
      if (!(await c.query('select 1 from notice_templates where id = $1', [b.template_id])).rowCount) throw new HttpError(400, 'modelo não encontrado');
      if (!(await c.query('select 1 from notice_channels where id = $1', [b.channel_id])).rowCount) throw new HttpError(400, 'canal não encontrado');
      const r = (await c.query(
        `insert into notice_rules (tenant_id, name, template_id, channel_id, days_relative, plan_id, pop_id, tag_id, hour_from, hour_to, weekdays, min_interval_days)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id, name`,
        [req.ctx.tenantId, b.name, b.template_id, b.channel_id, b.days_relative, b.plan_id ?? null, b.pop_id ?? null, b.tag_id ?? null, b.hour_from, b.hour_to, [...new Set(b.weekdays)], b.min_interval_days])).rows[0];
      await audit(c, req.ctx, 'notice_rule.create', 'notice_rule', r.id, { name: b.name, days_relative: b.days_relative });
      return r;
    });
  });

  app.patch('/api/notice-rules/:id', { preHandler: guard('settings:manage') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ active: z.boolean() }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const r = await c.query('update notice_rules set active = $2 where id = $1 returning id, active', [id, b.active]);
      if (!r.rowCount) throw new HttpError(404, 'regra não encontrada');
      await audit(c, req.ctx, 'notice_rule.update', 'notice_rule', id, b);
      return r.rows[0];
    });
  });

  app.delete('/api/notice-rules/:id', { preHandler: guard('settings:manage') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    return withScope(req.ctx.scope, async (c) => {
      if (!(await c.query('delete from notice_rules where id = $1', [id])).rowCount) throw new HttpError(404, 'regra não encontrada');
      await audit(c, req.ctx, 'notice_rule.delete', 'notice_rule', id);
      return { ok: true };
    });
  });

  /** Roda a régua agora (mesma rotina periódica). Respeita janela, consentimento e "uma vez por título". */
  app.post('/api/notice-rules/run', { preHandler: guard('settings:manage') }, async (req) => {
    const r = await runNotices(req.ctx.tenantId!);
    await audit(null, req.ctx, 'notice_rules.run', null, null, r);
    return r;
  });

  app.get('/api/notice-log', { preHandler: guard('settings:manage') }, async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    return withScope(req.ctx.scope, async (c) =>
      (await c.query(
        `select l.id, l.created_at, l.status, l.attempts, l.error, l.contact_value, coalesce(r.name, case l.phase when 'start' then 'Aviso: ' when 'resolved' then 'Normalizado: ' end || m.title) as rule_name, s.name as subscriber_name, l.contract_id
         from notice_log l left join notice_rules r on r.id = l.rule_id left join subscribers s on s.id = l.subscriber_id left join maintenance_notices m on m.id = l.maintenance_notice_id order by l.id desc limit $1`, [q.limit])).rows);
  });
}
