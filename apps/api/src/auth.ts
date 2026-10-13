import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { noScope, withScope, type DbScope, type Tx } from './db.js';

export type Role = 'saas_operator' | 'admin' | 'attendant' | 'finance' | 'noc' | 'subscriber';

const ALL_TENANT = [
  'users:manage', 'subscribers:read', 'subscribers:write', 'plans:read', 'plans:write',
  'contracts:read', 'contracts:write', 'network:read', 'network:write', 'network:operate',
  'finance:read', 'finance:write', 'audit:read', 'import:run', 'settings:manage',
  'os:read', 'os:write', 'stock:read', 'stock:write', 'crm:read', 'crm:write', 'trust:grant',
];
export const PERMISSIONS: Record<Role, string[]> = {
  saas_operator: ['tenants:manage'],
  admin: ALL_TENANT,
  attendant: ['subscribers:read', 'subscribers:write', 'plans:read', 'contracts:read', 'contracts:write', 'network:read', 'network:operate', 'finance:read',
    'os:read', 'os:write', 'stock:read', 'crm:read', 'crm:write', 'trust:grant'],
  finance: ['subscribers:read', 'plans:read', 'contracts:read', 'finance:read', 'finance:write', 'crm:read', 'crm:write', 'trust:grant'],
  noc: ['subscribers:read', 'plans:read', 'contracts:read', 'network:read', 'network:write', 'network:operate',
    'os:read', 'os:write', 'stock:read', 'stock:write', 'crm:read', 'crm:write'],
  subscriber: ['portal:self'],
};

/**
 * Módulos adicionais, liberados por provedor pelo operador do SaaS. A rota decide o módulo; sem ele, o servidor recusa
 * (não basta esconder o menu). O núcleo da operação não aparece aqui: está sempre disponível.
 */
export const MODULES = ['olt', 'ipam', 'field', 'ftth', 'crm', 'noc', 'notices', 'messages'] as const;
export type Module = (typeof MODULES)[number];
const MODULE_ROUTES: [Module | Module[], RegExp][] = [
  ['olt', /^\/api\/(olt\/|onus(\/|$)|contracts\/[^/]+\/onu$)/],
  ['ipam', /^\/api\/(ipam\/|cgnat\/|contracts\/[^/]+\/(ips|ipv6)$)/],
  ['field', /^\/api\/(work-orders(\/|$)|stock\/|contracts\/[^/]+\/equipment$|agenda(\/|$)|surveys(\/|$)|portal\/surveys(\/|$))/],
  [['crm', 'field'], /^\/api\/(catalogs(\/|$)|sla-policies(\/|$)|reports\/sla$)/],
  ['ftth', /^\/api\/(ftth\/|contracts\/[^/]+\/ftth$)/],
  ['crm', /^\/api\/(leads(\/|$)|tickets(\/|$)|crm\/|portal\/tickets(\/|$))/],
  ['noc', /^\/api\/(noc\/|contracts\/[^/]+\/diagnosis$)/],
  ['notices', /^\/api\/notifications(\/|$)/],
  ['messages', /^\/api\/(notice-(channels|templates|rules|log)(\/|$))/],
];
/** Módulos que liberam a rota (qualquer um basta). */
export const moduleOf = (url: string): Module[] | null => {
  const m = MODULE_ROUTES.find(([, re]) => re.test(url.split('?')[0]))?.[0];
  return m ? (Array.isArray(m) ? m : [m]) : null;
};

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(pw, salt, 32).toString('hex')}`;
}
export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const a = scryptSync(pw, Buffer.from(salt, 'hex'), 32);
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');

export interface Ctx {
  userId: string;
  name: string;
  email: string;
  role: Role;
  /** tenant efetivo (do usuário ou do acesso de suporte) */
  tenantId: string | null;
  support: boolean;
  subscriberId: string | null;
  perms: string[];
  tokenHash: string;
  scope: DbScope;
  /** conta administrativa obrigada a ter MFA e ainda sem configurar */
  mfaPending: boolean;
  /** módulos adicionais liberados para o provedor da sessão */
  modules: string[];
}
declare module 'fastify' {
  interface FastifyRequest {
    ctx: Ctx;
  }
}

export const SESSION_COOKIE = 'nexo_session';
/** Cookie HttpOnly (inacessível a scripts da página), SameSite=Strict; Secure sob HTTPS. */
export function sessionCookie(req: FastifyRequest, token: string | null, maxAgeS = 12 * 3600): string {
  // Secure quando a requisição chegou por HTTPS (proxy) ou quando a instalação declara que só atende por HTTPS.
  const secure = process.env.NEXO_COOKIE_SECURE === '1' || req.headers['x-forwarded-proto'] === 'https';
  return `${SESSION_COOKIE}=${token ?? ''}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token ? maxAgeS : 0}${secure ? '; Secure' : ''}`;
}
function cookieToken(req: FastifyRequest): string | null {
  const m = (req.headers.cookie ?? '').split(/;\s*/).find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  return m ? m.slice(SESSION_COOKIE.length + 1) || null : null;
}

export async function loadCtx(req: FastifyRequest): Promise<Ctx> {
  const h = req.headers.authorization;
  let token = h?.startsWith('Bearer ') ? h.slice(7) : null;   // integrações/testes
  if (!token) {
    token = cookieToken(req);                                  // navegador
    // CSRF: além do SameSite=Strict, escrita por cookie exige cabeçalho próprio (não enviável entre sites sem CORS, que não é habilitado)
    if (token && !['GET', 'HEAD'].includes(req.method) && req.headers['x-nexo-csrf'] !== '1') throw new HttpError(403, 'requisição sem proteção CSRF');
  }
  if (!token) throw new HttpError(401, 'não autenticado');
  const tokenHash = sha256(token);
  const s = await withScope(noScope, async (c) => (await c.query('select * from session_get($1)', [tokenHash])).rows[0]);
  if (!s) throw new HttpError(401, 'sessão inválida ou expirada');
  const isOp = s.role === 'saas_operator';
  const support = isOp && !!s.support_tenant_id;
  const tenantId: string | null = isOp ? s.support_tenant_id : s.tenant_id;
  const modules: string[] = tenantId
    ? (await withScope({ tenantId, operator: false }, async (c) => (await c.query('select modules from tenants where id = $1', [tenantId])).rows[0]))?.modules ?? []
    : [];
  return {
    modules,
    userId: s.user_id, name: s.name, email: s.email, role: s.role, tenantId, support,
    subscriberId: s.subscriber_id, tokenHash,
    mfaPending: mfaRequiredFor(s.role) && !s.mfa_enabled,
    // Em suporte explícito o operador age como admin daquele tenant (auditado), sem visão global.
    perms: support ? [...PERMISSIONS.admin, 'tenants:manage'] : PERMISSIONS[s.role as Role],
    scope: { tenantId, operator: isOp && !support, subscriberId: s.role === 'subscriber' ? s.subscriber_id : null },
  };
}

/** MFA obrigatório para contas administrativas quando NEXO_REQUIRE_ADMIN_MFA=1 (exigido antes do piloto com dados reais). */
export const mfaRequiredFor = (role: string) => process.env.NEXO_REQUIRE_ADMIN_MFA === '1' && (role === 'admin' || role === 'saas_operator');

/** preHandler: autentica e exige permissão. O tenant vem sempre da sessão, nunca do navegador. */
export function guard(perm?: string, opts: { allowMfaPending?: boolean } = {}) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    req.ctx = await loadCtx(req);
    if (req.ctx.mfaPending && !opts.allowMfaPending) throw new HttpError(403, 'configure a verificação em duas etapas para continuar', 'mfa_setup_required');
    if (perm && !req.ctx.perms.includes(perm)) {
      await audit(null, req.ctx, 'access.denied', 'permission', perm, { url: req.url }, 'denied').catch(() => {});
      throw new HttpError(403, 'sem permissão para esta ação');
    }
    if (perm && perm !== 'tenants:manage' && perm !== 'portal:self' && !req.ctx.tenantId)
      throw new HttpError(403, 'selecione um provedor (acesso de suporte) para esta ação');
    const mod = moduleOf(req.url);
    if (mod && !mod.some((m) => req.ctx.modules.includes(m))) throw new HttpError(403, 'este recurso não está liberado para o provedor', 'module_disabled');
  };
}

export async function audit(
  c: Tx | null, ctx: Pick<Ctx, 'userId' | 'tenantId' | 'scope' | 'support'> | null,
  action: string, entityType: string | null, entityId: string | null,
  detail: Record<string, unknown> = {}, result = 'ok',
  actor?: { type: 'agent' | 'system'; id: string; tenantId: string },
) {
  const q = `insert into audit_events (tenant_id, actor_type, actor_id, action, entity_type, entity_id, result, detail)
             values ($1,$2,$3,$4,$5,$6,$7,$8)`;
  const tenantId = actor?.tenantId ?? ctx?.tenantId ?? null;
  const p = [tenantId, actor?.type ?? 'user', actor?.id ?? ctx?.userId ?? null, action, entityType, entityId, result,
    JSON.stringify(ctx?.support ? { ...detail, support_access: true } : detail)];
  if (c) await c.query(q, p);
  else await withScope(ctx?.scope ?? { tenantId, operator: false }, (cc) => cc.query(q, p));
}
