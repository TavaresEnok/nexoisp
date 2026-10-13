import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, guard, HttpError } from '../auth.js';
import { noScope, withScope } from '../db.js';
import { zUuid } from '../validators.js';

/** D11 permissão por POP, C5 página de aviso do provedor (pública) e P4 documentos do assinante. */
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
const zPage = z.object({
  title: z.string().trim().min(3).max(80),
  blocked_text: z.string().trim().min(10).max(600),
  reduced_text: z.string().trim().max(600).nullish().transform((v) => v || null),
  phone: z.string().trim().max(30).nullish().transform((v) => v || null),
  whatsapp: z.string().trim().regex(/^\d{10,15}$/, 'WhatsApp: só números, com DDI e DDD').nullish().or(z.literal('')).transform((v) => v || null),
  show_portal_link: z.boolean().default(true),
});

/** O tipo declarado precisa bater com os primeiros bytes do arquivo (não se confia no nome nem no cabeçalho enviado). */
function sniff(buf: Buffer): string | null {
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}
const MAX_DOC = 5 * 1024 * 1024, MAX_PER_SUBSCRIBER = 50;

export async function escopoDocsRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- POPs do usuário
  app.get('/api/users/:id/pops', { preHandler: guard('users:manage') }, async (req) =>
    withScope(req.ctx.scope, async (c) =>
      (await c.query('select p.id, p.name from user_pops u join pops p on p.id = u.pop_id where u.user_id = $1 order by p.name', [zUuid.parse((req.params as any).id)])).rows));

  // Lista vazia = sem restrição. Administrador não é restringido (precisa enxergar o provedor inteiro).
  app.put('/api/users/:id/pops', { preHandler: guard('users:manage') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ pop_ids: z.array(zUuid).max(200) }).parse(req.body);
    const ids = [...new Set(b.pop_ids)];
    return withScope(req.ctx.scope, async (c) => {
      const u = (await c.query(`select role from users where id = $1 and tenant_id = $2 and role <> 'subscriber'`, [id, req.ctx.tenantId])).rows[0];
      if (!u) throw new HttpError(404, 'usuário não encontrado');
      if (u.role === 'admin' && ids.length) throw new HttpError(400, 'administrador não pode ser restrito a POPs; mude o papel antes');
      if (ids.length && (await c.query('select count(*)::int as n from pops where id = any($1::uuid[])', [ids])).rows[0].n !== ids.length)
        throw new HttpError(400, 'POP não encontrado neste provedor');
      await c.query('delete from user_pops where user_id = $1', [id]);
      for (const p of ids) await c.query('insert into user_pops (tenant_id, user_id, pop_id) values ($1,$2,$3)', [req.ctx.tenantId, id, p]);
      await audit(c, req.ctx, 'user.pops', 'user', id, { pop_ids: ids });
      return { pop_ids: ids };
    });
  });

  // ---------------------------------------------------------------- página de aviso
  app.get('/api/notice-page', { preHandler: guard('settings:manage') }, async (req) =>
    withScope(req.ctx.scope, async (c) => {
      const t = (await c.query('select t.slug, s.notice_page from tenants t left join tenant_settings s on s.tenant_id = t.id where t.id = $1', [req.ctx.tenantId])).rows[0];
      return { page: t.notice_page ?? null, path: `/aviso/${t.slug}` };
    }));

  app.put('/api/notice-page', { preHandler: guard('settings:manage') }, async (req) => {
    const b = z.object({ page: zPage.nullable() }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      await c.query(
        `insert into tenant_settings (tenant_id, notice_page, updated_by) values ($1,$2,$3)
         on conflict (tenant_id) do update set notice_page = excluded.notice_page, updated_at = now(), updated_by = excluded.updated_by`,
        [req.ctx.tenantId, b.page ? JSON.stringify(b.page) : null, req.ctx.userId]);
      await audit(c, req.ctx, 'notice_page.update', 'tenant', req.ctx.tenantId, { enabled: !!b.page });
      return { page: b.page };
    });
  });

  // Pública e sem identificação do assinante: é para onde o concentrador redireciona quem está bloqueado ou com velocidade
  // reduzida. Não mostra nome, valor nem fatura; o assinante entra no portal para ver e resolver.
  app.get('/aviso/:slug', async (req, reply) => {
    const slug = z.string().regex(/^[a-z0-9-]{2,40}$/).safeParse((req.params as any).slug);
    const reduced = (req.query as any)?.m === 'reduzida';
    const t = slug.success ? await withScope(noScope, async (c) => (await c.query('select * from notice_page_get($1)', [slug.data])).rows[0]) : null;
    reply.header('content-type', 'text/html; charset=utf-8').header('cache-control', 'no-store').header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'").header('referrer-policy', 'no-referrer');
    if (!t) return reply.status(404).send('<!doctype html><meta charset="utf-8"><title>Aviso</title><p>Página não encontrada.</p>');
    const p = t.page;
    const text = reduced && p.reduced_text ? p.reduced_text : p.blocked_text;
    return reply.send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(p.title)}</title><style>body{font-family:system-ui,sans-serif;margin:0;background:#f4f5f7;color:#1c1f24}main{max-width:560px;margin:8vh auto;padding:28px;background:#fff;border-radius:12px;border:1px solid #d9dde3}
h1{font-size:1.4rem;margin:0 0 4px}small{color:#5b6470}p{line-height:1.5;white-space:pre-line}a.b{display:inline-block;margin:6px 8px 0 0;padding:10px 16px;border-radius:8px;background:#0b5cad;color:#fff;text-decoration:none}
a.b.s{background:#fff;color:#0b5cad;border:1px solid #0b5cad}@media(prefers-color-scheme:dark){body{background:#14171c;color:#e8ebef}main{background:#1d2128;border-color:#333a44}small{color:#a2abb7}a.b.s{background:transparent;color:#8fc0f5;border-color:#8fc0f5}}</style></head>
<body><main><small>${esc(t.name)}</small><h1>${esc(p.title)}</h1><p>${esc(text)}</p>
${p.show_portal_link ? '<a class="b" href="/login">Entrar no portal do assinante</a>' : ''}
${p.whatsapp ? `<a class="b s" href="https://wa.me/${esc(p.whatsapp)}" rel="noopener noreferrer">Falar no WhatsApp</a>` : ''}
${p.phone ? `<p><small>Atendimento: ${esc(p.phone)}</small></p>` : ''}</main></body></html>`);
  });

  // ---------------------------------------------------------------- documentos do assinante
  app.get('/api/subscribers/:id/documents', { preHandler: guard('subscribers:read') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    return withScope(req.ctx.scope, async (c) =>
      (await c.query(
        `select d.id, d.kind, d.name, d.mime, d.size_bytes, d.contract_id, d.created_at, d.deleted_at, u.name as created_by_name
         from documents d left join users u on u.id = d.created_by where d.subscriber_id = $1 and d.deleted_at is null order by d.created_at desc`, [id])).rows);
  });

  app.post('/api/subscribers/:id/documents', { preHandler: guard('subscribers:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({
      kind: z.enum(['identity', 'address_proof', 'contract', 'photo', 'other']), name: z.string().trim().min(1).max(120),
      contract_id: zUuid.nullish(), content_base64: z.string().min(8).max(Math.ceil(MAX_DOC * 1.4)),
    }).parse(req.body);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b.content_base64)) throw new HttpError(400, 'conteúdo não está em base64');
    const buf = Buffer.from(b.content_base64, 'base64');
    if (buf.length === 0 || buf.length > MAX_DOC) throw new HttpError(400, 'arquivo vazio ou acima de 5 MB');
    const mime = sniff(buf);
    if (!mime) throw new HttpError(400, 'tipo de arquivo não aceito: envie PDF, JPEG, PNG ou WebP');
    const name = b.name.replace(/[\\/\x00-\x1f"<>|:*?]/g, '_');
    return withScope(req.ctx.scope, async (c) => {
      if (!(await c.query('select 1 from subscribers where id = $1', [id])).rowCount) throw new HttpError(404, 'assinante não encontrado');
      if (b.contract_id && !(await c.query('select 1 from contracts where id = $1 and subscriber_id = $2', [b.contract_id, id])).rowCount)
        throw new HttpError(400, 'o contrato não pertence a este assinante');
      if ((await c.query('select count(*)::int as n from documents where subscriber_id = $1 and deleted_at is null', [id])).rows[0].n >= MAX_PER_SUBSCRIBER)
        throw new HttpError(409, `limite de ${MAX_PER_SUBSCRIBER} documentos por assinante atingido`);
      const d = (await c.query(
        `insert into documents (tenant_id, subscriber_id, contract_id, kind, name, mime, size_bytes, sha256, content, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id, kind, name, mime, size_bytes, created_at`,
        [req.ctx.tenantId, id, b.contract_id ?? null, b.kind, name, mime, buf.length, createHash('sha256').update(buf).digest('hex'), buf, req.ctx.userId])).rows[0];
      await audit(c, req.ctx, 'document.upload', 'document', d.id, { subscriber_id: id, kind: b.kind, mime, size_bytes: buf.length });
      return d;
    });
  });

  // Baixar exige permissão de escrita no cadastro (documento pessoal) e fica na auditoria.
  app.get('/api/documents/:id/download', { preHandler: guard('subscribers:write') }, async (req, reply) => {
    const id = zUuid.parse((req.params as any).id);
    const d = await withScope(req.ctx.scope, async (c) => {
      const r = (await c.query('select name, mime, content, subscriber_id from documents where id = $1 and deleted_at is null', [id])).rows[0];
      if (r) await audit(c, req.ctx, 'document.download', 'document', id, { subscriber_id: r.subscriber_id });
      return r;
    });
    if (!d) throw new HttpError(404, 'documento não encontrado');
    return reply.header('content-type', d.mime).header('x-content-type-options', 'nosniff').header('cache-control', 'private, no-store')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(d.name)}`).send(d.content);
  });

  // Excluir apaga o conteúdo; o registro (quem, quando, tipo) fica.
  app.delete('/api/documents/:id', { preHandler: guard('subscribers:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    return withScope(req.ctx.scope, async (c) => {
      const r = await c.query('update documents set content = null, deleted_at = now(), deleted_by = $2 where id = $1 and deleted_at is null returning subscriber_id', [id, req.ctx.userId]);
      if (!r.rowCount) throw new HttpError(404, 'documento não encontrado');
      await audit(c, req.ctx, 'document.delete', 'document', id, { subscriber_id: r.rows[0].subscriber_id });
      return { ok: true };
    });
  });
}
