import type { FastifyInstance } from 'fastify';
import { authenticator } from 'otplib';
import { z } from 'zod';
import { audit, guard, hashPassword, HttpError, newToken, sessionCookie, sha256, verifyPassword, MODULES } from '../auth.js';
import { noScope, paged, withScope } from '../db.js';
import { decryptSecret, encryptSecret } from '../network/crypto.js';
import { zPage, zUuid } from '../validators.js';

const SESSION_HOURS = 12;
const zPassword = z.string().min(8, 'senha deve ter ao menos 8 caracteres').max(200);
authenticator.options = { window: 1 };

// Limite simples de tentativas de login por e-mail (em memória, por processo).
const fails = new Map<string, { n: number; until: number }>();
function throttle(email: string) {
  const f = fails.get(email);
  if (f && f.n >= 8 && f.until > Date.now()) throw new HttpError(429, 'muitas tentativas; aguarde alguns minutos');
  if (f && f.until <= Date.now()) fails.delete(email);
}
function failed(email: string) {
  const f = fails.get(email) ?? { n: 0, until: 0 };
  fails.set(email, { n: f.n + 1, until: Date.now() + 10 * 60_000 });
  if (fails.size > 10_000) fails.clear();
}

export async function identityRoutes(app: FastifyInstance) {
  app.post('/api/auth/login', async (req, reply) => {
    const b = z.object({ email: z.string().email(), password: z.string().min(1), code: z.string().trim().max(10).optional() }).parse(req.body);
    const key = b.email.toLowerCase();
    throttle(key);
    const u = await withScope(noScope, async (c) => (await c.query('select * from auth_find_user($1)', [b.email])).rows[0]);
    let ok = u && u.active && (u.tenant_status ?? 'active') === 'active' && verifyPassword(b.password, u.password_hash);
    if (ok && u.mfa_enabled) {
      if (!b.code) throw new HttpError(401, 'informe o código de verificação', 'mfa_required');
      ok = authenticator.check(b.code.replace(/\s/g, ''), decryptSecret(u.mfa_secret_enc));
    }
    if (!ok) {
      failed(key);
      if (u) await audit(null, { userId: u.id, tenantId: u.tenant_id, support: false, scope: { tenantId: u.tenant_id, operator: !u.tenant_id } },
        'auth.login', 'user', u.id, {}, 'denied');
      throw new HttpError(401, 'e-mail ou senha inválidos');
    }
    const token = newToken();
    await withScope(noScope, (c) =>
      c.query(`select session_create($1,$2, now() + interval '${SESSION_HOURS} hours')`, [u.id, sha256(token)]));
    await audit(null, { userId: u.id, tenantId: u.tenant_id, support: false, scope: { tenantId: u.tenant_id, operator: !u.tenant_id } },
      'auth.login', 'user', u.id);
    fails.delete(key);
    reply.header('set-cookie', sessionCookie(req, token, SESSION_HOURS * 3600));
    return { token }; // o painel usa o cookie; o token no corpo serve a integrações
  });

  app.post('/api/auth/logout', { preHandler: guard(undefined, { allowMfaPending: true }) }, async (req, reply) => {
    await withScope(noScope, (c) => c.query('select session_delete($1)', [req.ctx.tokenHash]));
    reply.header('set-cookie', sessionCookie(req, null));
    return { ok: true };
  });

  app.get('/api/me', { preHandler: guard(undefined, { allowMfaPending: true }) }, async (req) => {
    const x = req.ctx;
    const tenant = x.tenantId
      ? await withScope(x.scope, async (c) => (await c.query('select id, name, slug from tenants where id = $1', [x.tenantId])).rows[0])
      : null;
    const self = await withScope(noScope, async (c) => (await c.query('select mfa_enabled from user_self_get($1)', [x.userId])).rows[0]);
    return { id: x.userId, name: x.name, email: x.email, role: x.role, perms: x.perms, support: x.support, tenant, modules: x.modules,
      demo: process.env.NEXO_DEMO_MODE === '1', mfa_enabled: self.mfa_enabled, mfa_pending: x.mfaPending };
  });

  // ---- Conta do próprio usuário: senha e verificação em duas etapas (TOTP) ----
  const self = { preHandler: guard(undefined, { allowMfaPending: true }) };
  app.post('/api/me/password', self, async (req) => {
    const b = z.object({ current: z.string().min(1), next: zPassword }).parse(req.body);
    await withScope(noScope, async (c) => {
      const u = (await c.query('select * from user_self_get($1)', [req.ctx.userId])).rows[0];
      if (!verifyPassword(b.current, u.password_hash)) throw new HttpError(400, 'senha atual incorreta');
      await c.query('select user_self_update($1,$2,null,null)', [req.ctx.userId, hashPassword(b.next)]);
      await c.query('select sessions_revoke_others($1,$2)', [req.ctx.userId, req.ctx.tokenHash]);
    });
    await audit(null, req.ctx, 'user.password_change', 'user', req.ctx.userId);
    return { ok: true };
  });

  app.post('/api/me/mfa/setup', self, async (req) => {
    const secret = authenticator.generateSecret();
    await withScope(noScope, async (c) => {
      const u = (await c.query('select * from user_self_get($1)', [req.ctx.userId])).rows[0];
      if (u.mfa_enabled) throw new HttpError(400, 'verificação em duas etapas já está ativa');
      await c.query('select user_self_update($1,null,$2,null)', [req.ctx.userId, encryptSecret(secret)]);
    });
    return { secret, otpauth_url: authenticator.keyuri(req.ctx.email, 'NexoISP', secret) };
  });

  app.post('/api/me/mfa/enable', self, async (req) => {
    const b = z.object({ code: z.string().trim().min(6).max(10) }).parse(req.body);
    await withScope(noScope, async (c) => {
      const u = (await c.query('select * from user_self_get($1)', [req.ctx.userId])).rows[0];
      if (!u.mfa_secret_enc) throw new HttpError(400, 'inicie a configuração primeiro');
      if (!authenticator.check(b.code.replace(/\s/g, ''), decryptSecret(u.mfa_secret_enc))) throw new HttpError(400, 'código incorreto');
      await c.query('select user_self_update($1,null,null,true)', [req.ctx.userId]);
      await c.query('select sessions_revoke_others($1,$2)', [req.ctx.userId, req.ctx.tokenHash]);
    });
    await audit(null, req.ctx, 'user.mfa_enable', 'user', req.ctx.userId);
    return { ok: true };
  });

  app.post('/api/me/mfa/disable', self, async (req) => {
    const b = z.object({ password: z.string().min(1), code: z.string().trim().min(6).max(10) }).parse(req.body);
    await withScope(noScope, async (c) => {
      const u = (await c.query('select * from user_self_get($1)', [req.ctx.userId])).rows[0];
      if (!u.mfa_enabled || !verifyPassword(b.password, u.password_hash) || !authenticator.check(b.code.replace(/\s/g, ''), decryptSecret(u.mfa_secret_enc)))
        throw new HttpError(400, 'senha ou código incorretos');
      await c.query('select user_self_update($1,null,null,false)', [req.ctx.userId]);
    });
    await audit(null, req.ctx, 'user.mfa_disable', 'user', req.ctx.userId);
    return { ok: true };
  });

  // ---- Provedores (operador do SaaS) ----
  app.get('/api/tenants', { preHandler: guard('tenants:manage') }, async (req) => {
    if (req.ctx.role !== 'saas_operator') throw new HttpError(403, 'sem permissão');
    return withScope({ tenantId: null, operator: true }, async (c) =>
      (await c.query(
        `select t.*, (select count(*) from users u where u.tenant_id = t.id and u.role <> 'subscriber') as users,
                h.agents, h.agents_offline, h.uncertain, h.failed_recent
         from tenants t left join platform_health() h on h.tenant_id = t.id order by t.name`)).rows);
  });

  app.post('/api/tenants', { preHandler: guard('tenants:manage') }, async (req) => {
    if (req.ctx.support) throw new HttpError(400, 'saia do acesso de suporte para gerenciar provedores');
    const b = z.object({
      name: z.string().trim().min(2).max(120),
      slug: z.string().regex(/^[a-z0-9-]{2,40}$/, 'identificador: letras minúsculas, números e hífen'),
      admin_name: z.string().trim().min(2), admin_email: z.string().email(), admin_password: zPassword,
    }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const t = (await c.query('insert into tenants (name, slug) values ($1,$2) returning *', [b.name, b.slug])).rows[0];
      await c.query(`insert into users (tenant_id, email, name, password_hash, role) values ($1,$2,$3,$4,'admin')`,
        [t.id, b.admin_email, b.admin_name, hashPassword(b.admin_password)]);
      await c.query(`insert into audit_events (tenant_id, actor_type, actor_id, action, entity_type, entity_id) values ($1::uuid,'user',$2,'tenant.create','tenant',$1::text)`,
        [t.id, req.ctx.userId]);
      return t;
    });
  });

  app.patch('/api/tenants/:id', { preHandler: guard('tenants:manage') }, async (req) => {
    if (req.ctx.support) throw new HttpError(400, 'saia do acesso de suporte para gerenciar provedores');
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ name: z.string().trim().min(2).optional(), status: z.enum(['active', 'suspended']).optional(),
      modules: z.array(z.enum(MODULES)).max(MODULES.length).transform((m) => [...new Set(m)]).optional() }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const t = (await c.query('update tenants set name = coalesce($2,name), status = coalesce($3,status), modules = coalesce($4::text[], modules) where id = $1 returning *',
        [id, b.name ?? null, b.status ?? null, b.modules ?? null])).rows[0];
      if (!t) throw new HttpError(404, 'provedor não encontrado');
      await c.query(`insert into audit_events (tenant_id, actor_type, actor_id, action, entity_type, entity_id, detail) values ($1::uuid,'user',$2,'tenant.update','tenant',$1::text,$3)`,
        [id, req.ctx.userId, JSON.stringify(b)]);
      return t;
    });
  });

  // Acesso de suporte: explícito, com motivo, auditado no tenant acessado.
  app.post('/api/support/enter', { preHandler: guard('tenants:manage') }, async (req) => {
    if (req.ctx.role !== 'saas_operator') throw new HttpError(403, 'sem permissão');
    const b = z.object({ tenant_id: zUuid, reason: z.string().trim().min(5, 'informe o motivo do acesso') }).parse(req.body);
    await withScope({ tenantId: null, operator: true }, async (c) => {
      const t = (await c.query('select id from tenants where id = $1', [b.tenant_id])).rows[0];
      if (!t) throw new HttpError(404, 'provedor não encontrado');
      await c.query('select session_set_support($1,$2)', [req.ctx.tokenHash, b.tenant_id]);
      await c.query(`insert into audit_events (tenant_id, actor_type, actor_id, action, entity_type, entity_id, detail) values ($1::uuid,'user',$2,'support.enter','tenant',$1::text,$3)`,
        [b.tenant_id, req.ctx.userId, JSON.stringify({ reason: b.reason, operator: req.ctx.email })]);
    });
    return { ok: true };
  });
  app.post('/api/support/exit', { preHandler: guard() }, async (req) => {
    if (req.ctx.role !== 'saas_operator') throw new HttpError(403, 'sem permissão');
    if (req.ctx.support) await audit(null, req.ctx, 'support.exit', 'tenant', req.ctx.tenantId);
    await withScope(noScope, (c) => c.query('select session_set_support($1, null)', [req.ctx.tokenHash]));
    return { ok: true };
  });

  // ---- Usuários do provedor ----
  const zRole = z.enum(['admin', 'attendant', 'finance', 'noc']);
  app.get('/api/users', { preHandler: guard('users:manage') }, async (req) =>
    withScope(req.ctx.scope, async (c) =>
      (await c.query(`select id, name, email, role, active, mfa_enabled, created_at from users where tenant_id = $1 and role <> 'subscriber' order by name`, [req.ctx.tenantId])).rows));

  app.post('/api/users', { preHandler: guard('users:manage') }, async (req) => {
    const b = z.object({ name: z.string().trim().min(2), email: z.string().email(), role: zRole, password: zPassword }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const u = (await c.query(`insert into users (tenant_id, email, name, password_hash, role) values ($1,$2,$3,$4,$5) returning id, name, email, role, active`,
        [req.ctx.tenantId, b.email, b.name, hashPassword(b.password), b.role])).rows[0];
      await audit(c, req.ctx, 'user.create', 'user', u.id, { role: b.role });
      return u;
    });
  });

  app.patch('/api/users/:id', { preHandler: guard('users:manage') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ name: z.string().trim().min(2).optional(), role: zRole.optional(), active: z.boolean().optional(), password: zPassword.optional(), reset_mfa: z.boolean().optional() }).parse(req.body);
    if (id === req.ctx.userId && (b.active === false || (b.role && b.role !== 'admin')))
      throw new HttpError(400, 'você não pode remover o próprio acesso de administrador');
    return withScope(req.ctx.scope, async (c) => {
      const u = (await c.query(
        `update users set name = coalesce($3,name), role = coalesce($4,role), active = coalesce($5,active), password_hash = coalesce($6,password_hash)
         where id = $1 and tenant_id = $2 and role <> 'subscriber' returning id, name, email, role, active`,
        [id, req.ctx.tenantId, b.name ?? null, b.role ?? null, b.active ?? null, b.password ? hashPassword(b.password) : null])).rows[0];
      if (!u) throw new HttpError(404, 'usuário não encontrado');
      if (b.reset_mfa) await c.query('update users set mfa_enabled = false, mfa_secret_enc = null where id = $1 and tenant_id = $2', [id, req.ctx.tenantId]);
      await audit(c, req.ctx, 'user.update', 'user', id, { name: b.name, role: b.role, active: b.active, password_changed: !!b.password, mfa_reset: !!b.reset_mfa });
      return u;
    });
  });

  app.get('/api/audit', { preHandler: guard('audit:read') }, async (req, reply) => {
    const q = z.object(zPage).parse(req.query);
    return withScope(req.ctx.scope, async (c) =>
      paged(c, reply,
        `select a.id, a.at, a.actor_type, a.actor_id, coalesce(u.name, a.actor_id) as actor_name, a.action, a.entity_type, a.entity_id, a.result, a.detail
         from audit_events a left join users u on a.actor_type = 'user' and u.id::text = a.actor_id
         where a.tenant_id = $1 order by a.id desc`, [req.ctx.tenantId], q, 300));
  });
}
