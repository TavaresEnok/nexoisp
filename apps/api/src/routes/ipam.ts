import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, guard, HttpError } from '../auth.js';
import { withScope, type Tx } from '../db.js';
import { requestOperation } from '../network/engine.js';
import { blocks, capacity, forward, ipv6Subnet, isIpv4, parseCidr4, reverse, routerosScript, type CgnatPlan } from '../network/cgnat.js';
import { zUuid } from '../validators.js';

/** Expansão IPAM/CGNAT: blocos, endereços fixos/reservados, plano de CGNAT determinístico, script para revisão e rastreabilidade. */
const MAX_AUTO = 65536;      // maior bloco em que o sistema procura endereço livre / gera plano de CGNAT (/16)
const zCidr = z.string().trim().regex(/^[0-9a-fA-F:.]{2,45}\/\d{1,3}$/, 'bloco no formato 100.64.0.0/22');
const zAddr = z.string().trim().regex(/^[0-9a-fA-F:.]{2,45}$/, 'endereço IP inválido');

const POOL_SELECT = `
  select p.*, family(p.cidr) as family, masklen(p.cidr) as masklen, d.name as device_name,
         case when family(p.cidr) = 4 then (2 ^ (32 - masklen(p.cidr)))::bigint end as size,
         (select count(*) from ip_allocations a where a.pool_id = p.id) + (select count(*) from ip6_delegations x where x.pool_id = p.id) as allocated,
         (select g.id from cgnat_plans g where g.retired_at is null and (g.private_pool_id = p.id or g.public_pool_id = p.id) limit 1) as cgnat_plan_id
  from ip_pools p left join devices d on d.id = p.device_id`;
const ALLOC_SELECT = `
  select a.id, a.pool_id, host(a.address) as address, a.contract_id, a.description, a.created_at, p.name as pool_name, p.kind as pool_kind,
         s.id as subscriber_id, s.name as subscriber_name, u.name as created_by_name
  from ip_allocations a join ip_pools p on p.id = a.pool_id
  left join contracts k on k.id = a.contract_id left join subscribers s on s.id = k.subscriber_id left join users u on u.id = a.created_by`;
const PLAN_SELECT = `
  select g.*, pub.name as public_pool_name, priv.name as private_pool_name, u.name as created_by_name
  from cgnat_plans g join ip_pools pub on pub.id = g.public_pool_id join ip_pools priv on priv.id = g.private_pool_id left join users u on u.id = g.created_by`;

/**
 * O IP fixo de um contrato é entregue pelo RADIUS local (Framed-IP-Address). Ao alocar ou liberar, a intenção atual da conta PPPoE
 * é reenviada ao agente pela fila normal de operações, preservando a situação (liberado/suspenso). Sem conta provisionada, nada é enviado:
 * o endereço segue junto no primeiro provisionamento.
 */
async function reapplyFixedIp(c: Tx, ctx: { tenantId: string | null; userId: string }, contractId: string, reason: string, released = false) {
  const r = (await c.query(
    `select r.id, r.desired_version, r.desired_policy, k.status, d.agent_id from service_resources r
     join contracts k on k.id = r.contract_id join devices d on d.id = r.device_id where r.contract_id = $1`, [contractId])).rows[0];
  if (!r || r.desired_version === 0) return { requested: false, note: 'contrato sem acesso PPPoE provisionado: o endereço será aplicado no provisionamento' };
  if (!r.agent_id) return { requested: false, note: 'equipamento sem agente: use “Reaplicar” no contrato quando houver' };
  if (r.status !== 'active' && r.desired_policy !== 'suspended') return { requested: false, note: 'contrato encerrado: nada foi enviado ao equipamento' };
  const op = await requestOperation(c, ctx.tenantId!, r.id, r.desired_policy === 'suspended' ? 'subscriber.suspend' : 'subscriber.resume', { type: 'user', id: ctx.userId, reason });
  return { requested: true, operation_id: op.id as string, note: released ? 'enviado ao agente; a sessão em uso mantém o endereço até a próxima reconexão' : 'enviado ao agente; a sessão em uso é reconectada para receber o novo endereço' };
}

export async function ipamRoutes(app: FastifyInstance) {
  // ---- Blocos ----
  app.get('/api/ipam/pools', { preHandler: guard('network:read') }, async (req) =>
    withScope(req.ctx.scope, async (c) => (await c.query(`${POOL_SELECT} order by p.kind, p.cidr`)).rows));

  app.post('/api/ipam/pools', { preHandler: guard('network:write') }, async (req) => {
    const b = z.object({
      name: z.string().trim().min(2).max(80), cidr: zCidr, kind: z.enum(['public', 'cgnat', 'private', 'management']),
      device_id: zUuid.nullish(), notes: z.string().trim().max(500).nullish(), delegation_len: z.number().int().min(48).max(64).nullish(),
    }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      // o tipo cidr recusa bits de host ligados (ex.: 10.0.0.5/24): a mensagem padrão do banco não ajuda o operador
      const ok = (await c.query(`select pg_input_is_valid($1, 'cidr') as ok`, [b.cidr])).rows[0].ok;
      if (!ok) throw new HttpError(400, 'bloco inválido: use o endereço de rede, ex.: 100.64.0.0/22');
      const clash = (await c.query('select name, cidr from ip_pools where cidr && $1::cidr limit 1', [b.cidr])).rows[0];
      if (clash) throw new HttpError(409, `o bloco se sobrepõe a “${clash.name}” (${clash.cidr})`);
      const shape = (await c.query('select family($1::cidr) as family, masklen($1::cidr) as masklen', [b.cidr])).rows[0];
      if (b.delegation_len && (shape.family !== 6 || b.delegation_len < shape.masklen)) throw new HttpError(400, 'prefixo por assinante só se aplica a bloco IPv6 e não pode ser maior que o próprio bloco');
      const p = (await c.query(`insert into ip_pools (tenant_id, name, cidr, kind, device_id, notes, delegation_len) values ($1,$2,$3,$4,$5,$6,$7) returning *`,
        [req.ctx.tenantId, b.name, b.cidr, b.kind, b.device_id ?? null, b.notes || null, b.delegation_len ?? null])).rows[0];
      await audit(c, req.ctx, 'ipam.pool_create', 'ip_pool', p.id, { cidr: p.cidr, kind: b.kind });
      return p;
    });
  });

  app.patch('/api/ipam/pools/:id', { preHandler: guard('network:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ name: z.string().trim().min(2).max(80).optional(), notes: z.string().trim().max(500).nullish(), device_id: zUuid.nullish() }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const p = (await c.query(
        `update ip_pools set name = coalesce($2, name), notes = case when $3 then $4 else notes end, device_id = case when $5 then $6 else device_id end where id = $1 returning *`,
        [id, b.name ?? null, b.notes !== undefined, b.notes || null, b.device_id !== undefined, b.device_id ?? null])).rows[0];
      if (!p) throw new HttpError(404, 'bloco não encontrado');
      await audit(c, req.ctx, 'ipam.pool_update', 'ip_pool', id, b);
      return p;
    });
  });

  app.delete('/api/ipam/pools/:id', { preHandler: guard('network:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    return withScope(req.ctx.scope, async (c) => {
      const p = (await c.query(`${POOL_SELECT} where p.id = $1`, [id])).rows[0];
      if (!p) throw new HttpError(404, 'bloco não encontrado');
      if (p.allocated > 0) throw new HttpError(409, 'o bloco tem endereços alocados; libere-os antes de excluir');
      if ((await c.query('select 1 from cgnat_plans where private_pool_id = $1 or public_pool_id = $1 limit 1', [id])).rowCount)
        throw new HttpError(409, 'o bloco faz parte de um plano de CGNAT (vigente ou encerrado) e é mantido para rastreabilidade');
      await c.query('delete from ip_pools where id = $1', [id]);
      await audit(c, req.ctx, 'ipam.pool_delete', 'ip_pool', id, { cidr: p.cidr });
      return { ok: true };
    });
  });

  // ---- Endereços ----
  app.get('/api/ipam/pools/:id/allocations', { preHandler: guard('network:read') }, async (req) =>
    withScope(req.ctx.scope, async (c) =>
      (await c.query(`${ALLOC_SELECT} where a.pool_id = $1 order by a.address limit 2000`, [zUuid.parse((req.params as any).id)])).rows));

  app.get('/api/contracts/:id/ips', { preHandler: guard('network:read') }, async (req) =>
    withScope(req.ctx.scope, async (c) =>
      (await c.query(`${ALLOC_SELECT} where a.contract_id = $1 order by a.address`, [zUuid.parse((req.params as any).id)])).rows));

  /** Sem `address`, o sistema escolhe o primeiro endereço livre do bloco (IPv4, sem rede e broadcast). */
  app.post('/api/ipam/pools/:id/allocations', { preHandler: guard('network:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ address: zAddr.nullish().or(z.literal('')), contract_id: zUuid.nullish(), description: z.string().trim().max(200).nullish() }).parse(req.body);
    if (!b.contract_id && !b.description) throw new HttpError(400, 'informe o contrato ou uma descrição para a reserva');
    return withScope(req.ctx.scope, async (c) => {
      const p = (await c.query(`${POOL_SELECT} where p.id = $1 for update of p`, [id])).rows[0];
      if (!p) throw new HttpError(404, 'bloco não encontrado');
      if (b.contract_id) {
        const k = (await c.query('select status from contracts where id = $1', [b.contract_id])).rows[0];
        if (!k) throw new HttpError(400, 'contrato não encontrado');
        if (k.status !== 'active') throw new HttpError(400, 'contrato encerrado');
      }
      let address = b.address || null;
      if (address) {
        if (!(await c.query(`select pg_input_is_valid($1, 'inet') as ok`, [address])).rows[0].ok) throw new HttpError(400, 'endereço IP inválido');
        if (!(await c.query('select $1::inet << $2::cidr as ok', [address, p.cidr])).rows[0].ok) throw new HttpError(400, `o endereço não pertence ao bloco ${p.cidr}`);
      } else {
        if (p.family !== 4 || p.size > MAX_AUTO) throw new HttpError(400, 'escolha automática só para blocos IPv4 de até /16; informe o endereço');
        const edge = p.masklen <= 30 ? 1 : 0;   // /31 e /32 não têm endereço de rede/broadcast
        address = (await c.query(
          `select host($2::cidr + g) as addr from generate_series($3::bigint, $4::bigint) g
           where not exists (select 1 from ip_allocations a where a.pool_id = $1 and a.address = host($2::cidr + g)::inet) order by g limit 1`,
          [id, p.cidr, edge, p.size - 1 - edge])).rows[0]?.addr ?? null;
        if (!address) throw new HttpError(409, 'não há endereço livre neste bloco');
      }
      // o RADIUS entrega um único endereço IPv4 por conta
      if (b.contract_id && p.family === 4 && (await c.query('select 1 from ip_allocations where contract_id = $1 and family(address) = 4', [b.contract_id])).rowCount)
        throw new HttpError(409, 'o contrato já tem um endereço IPv4 fixo; libere-o antes de alocar outro');
      const a = (await c.query(
        `insert into ip_allocations (tenant_id, pool_id, address, contract_id, description, created_by) values ($1,$2,host($3::inet)::inet,$4,$5,$6) returning id, host(address) as address`,
        [req.ctx.tenantId, id, address, b.contract_id ?? null, b.description || null, req.ctx.userId])).rows[0];
      await audit(c, req.ctx, 'ipam.allocate', 'ip_allocation', a.id, { address: a.address, contract_id: b.contract_id ?? null });
      const network = b.contract_id && p.family === 4 ? await reapplyFixedIp(c, req.ctx, b.contract_id, `IP fixo ${a.address}`) : null;
      return { ...a, network };
    });
  });

  app.delete('/api/ipam/allocations/:id', { preHandler: guard('network:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    return withScope(req.ctx.scope, async (c) => {
      const a = (await c.query('delete from ip_allocations where id = $1 returning host(address) as address, contract_id, family(address) as family', [id])).rows[0];
      if (!a) throw new HttpError(404, 'alocação não encontrada');
      await audit(c, req.ctx, 'ipam.release', 'ip_allocation', id, a);
      const network = a.contract_id && a.family === 4 ? await reapplyFixedIp(c, req.ctx, a.contract_id, `IP fixo ${a.address} liberado`, true) : null;
      return { ok: true, network };
    });
  });

  // ---- IPv6: prefixo delegado por contrato (registro; a entrega ao assinante não é feita pelo sistema) ----
  const DELEG_SELECT = `
    select x.id, x.pool_id, x.prefix, x.contract_id, x.created_at, p.name as pool_name, s.id as subscriber_id, s.name as subscriber_name
    from ip6_delegations x join ip_pools p on p.id = x.pool_id join contracts k on k.id = x.contract_id join subscribers s on s.id = k.subscriber_id`;

  app.get('/api/ipam/pools/:id/delegations', { preHandler: guard('network:read') }, async (req) =>
    withScope(req.ctx.scope, async (c) => (await c.query(`${DELEG_SELECT} where x.pool_id = $1 order by x.prefix limit 2000`, [zUuid.parse((req.params as any).id)])).rows));

  app.get('/api/contracts/:id/ipv6', { preHandler: guard('network:read') }, async (req) =>
    withScope(req.ctx.scope, async (c) => ({ delegation: (await c.query(`${DELEG_SELECT} where x.contract_id = $1`, [zUuid.parse((req.params as any).id)])).rows[0] ?? null })));

  /** Sem `prefix`, o sistema escolhe o primeiro prefixo livre do tamanho configurado no bloco. */
  app.post('/api/ipam/pools/:id/delegations', { preHandler: guard('network:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ contract_id: zUuid, prefix: zCidr.nullish().or(z.literal('')) }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const p = (await c.query(`${POOL_SELECT} where p.id = $1 for update of p`, [id])).rows[0];
      if (!p) throw new HttpError(404, 'bloco não encontrado');
      if (p.family !== 6 || !p.delegation_len) throw new HttpError(400, 'este bloco não está configurado para delegar prefixos IPv6');
      const k = (await c.query('select status from contracts where id = $1', [b.contract_id])).rows[0];
      if (!k) throw new HttpError(400, 'contrato não encontrado');
      if (k.status !== 'active') throw new HttpError(400, 'contrato encerrado');
      if ((await c.query('select 1 from ip6_delegations where contract_id = $1', [b.contract_id])).rowCount) throw new HttpError(409, 'o contrato já tem um prefixo IPv6; libere-o antes de delegar outro');
      let prefix = b.prefix || null;
      if (prefix) {
        const ok = (await c.query(`select pg_input_is_valid($1, 'cidr') as valid`, [prefix])).rows[0].valid
          && (await c.query('select ($1::cidr <<= $2::cidr and masklen($1::cidr) = $3) as ok', [prefix, p.cidr, p.delegation_len])).rows[0].ok;
        if (!ok) throw new HttpError(400, `o prefixo precisa ser um /${p.delegation_len} dentro de ${p.cidr}`);
        if ((await c.query('select 1 from ip6_delegations where prefix && $1::cidr', [prefix])).rowCount) throw new HttpError(409, 'prefixo já delegado');
      } else {
        const total = Math.min(2 ** (p.delegation_len - p.masklen), MAX_AUTO);
        for (let from = 0; from < total && !prefix; from += 1024) {
          const cand = Array.from({ length: Math.min(1024, total - from) }, (_, i) => ipv6Subnet(p.cidr, p.delegation_len, from + i));
          prefix = (await c.query(
            `select c.prefix::text as prefix from unnest($1::cidr[]) with ordinality as c(prefix, ord)
             where not exists (select 1 from ip6_delegations d where d.prefix && c.prefix) order by c.ord limit 1`, [cand])).rows[0]?.prefix ?? null;
        }
        if (!prefix) throw new HttpError(409, `não há prefixo /${p.delegation_len} livre entre os primeiros ${MAX_AUTO} deste bloco`);
      }
      const x = (await c.query('insert into ip6_delegations (tenant_id, pool_id, prefix, contract_id, created_by) values ($1,$2,$3,$4,$5) returning id, prefix',
        [req.ctx.tenantId, id, prefix, b.contract_id, req.ctx.userId])).rows[0];
      await audit(c, req.ctx, 'ipam.delegate_v6', 'ip6_delegation', x.id, { prefix: x.prefix, contract_id: b.contract_id });
      return x;
    });
  });

  app.delete('/api/ipam/delegations/:id', { preHandler: guard('network:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    return withScope(req.ctx.scope, async (c) => {
      const x = (await c.query('delete from ip6_delegations where id = $1 returning prefix, contract_id', [id])).rows[0];
      if (!x) throw new HttpError(404, 'delegação não encontrada');
      await audit(c, req.ctx, 'ipam.release_v6', 'ip6_delegation', id, x);
      return { ok: true };
    });
  });

  // ---- CGNAT ----
  const withCap = (g: any) => ({ ...g, capacity: capacity(g) });

  app.get('/api/cgnat/plans', { preHandler: guard('network:read') }, async (req) =>
    withScope(req.ctx.scope, async (c) => (await c.query(`${PLAN_SELECT} order by g.retired_at nulls first, g.created_at desc`)).rows.map(withCap)));

  /** Só valida e devolve a capacidade: nada é gravado. */
  const zPlan = z.object({
    name: z.string().trim().min(2).max(80), public_pool_id: zUuid, private_pool_id: zUuid,
    ports_per_subscriber: z.number().int().min(64).max(32768), port_start: z.number().int().min(1024).max(65000).default(1024),
  });
  async function checkPlan(c: any, b: z.infer<typeof zPlan>) {
    const pools = (await c.query('select id, cidr, kind, family(cidr) as family from ip_pools where id = any($1::uuid[])', [[b.public_pool_id, b.private_pool_id]])).rows;
    const pub = pools.find((p: any) => p.id === b.public_pool_id), priv = pools.find((p: any) => p.id === b.private_pool_id);
    if (!pub || !priv) throw new HttpError(400, 'bloco não encontrado');
    if (pub.kind !== 'public') throw new HttpError(400, 'o bloco de saída precisa ser do tipo “público”');
    if (priv.kind !== 'cgnat') throw new HttpError(400, 'o bloco dos assinantes precisa ser do tipo “CGNAT”');
    if (pub.family !== 4 || priv.family !== 4) throw new HttpError(400, 'CGNAT é calculado apenas para IPv4');
    const plan = { ...b, public_cidr: pub.cidr as string, private_cidr: priv.cidr as string };
    const cap = capacity(plan);
    if (cap.private_ips > MAX_AUTO) throw new HttpError(400, 'bloco de assinantes maior que /16: divida em mais de um plano');
    if (!cap.fits)
      throw new HttpError(400, `não cabe: ${cap.private_ips} endereços privados para ${cap.public_ips} público(s) × ${cap.blocks_per_public} bloco(s) de ${b.ports_per_subscriber} portas = ${cap.max_private_ips}. Reduza as portas por assinante ou aumente o bloco público.`);
    return { plan, cap };
  }

  app.post('/api/cgnat/plans/check', { preHandler: guard('network:read') }, async (req) => {
    const b = zPlan.parse(req.body);
    return withScope(req.ctx.scope, async (c) => (await checkPlan(c, b)).cap);
  });

  app.post('/api/cgnat/plans', { preHandler: guard('network:write') }, async (req) => {
    const b = zPlan.parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const { plan } = await checkPlan(c, b);
      if ((await c.query('select 1 from cgnat_plans where private_pool_id = $1 and retired_at is null', [b.private_pool_id])).rowCount)
        throw new HttpError(409, 'este bloco de assinantes já tem um plano de CGNAT vigente; encerre-o antes de criar outro');
      const g = (await c.query(
        `insert into cgnat_plans (tenant_id, name, public_pool_id, private_pool_id, public_cidr, private_cidr, ports_per_subscriber, port_start, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
        [req.ctx.tenantId, b.name, b.public_pool_id, b.private_pool_id, plan.public_cidr, plan.private_cidr, b.ports_per_subscriber, b.port_start, req.ctx.userId])).rows[0];
      await audit(c, req.ctx, 'cgnat.plan_create', 'cgnat_plan', g.id, { public: g.public_cidr, private: g.private_cidr, ports: b.ports_per_subscriber });
      return withCap(g);
    });
  });

  app.post('/api/cgnat/plans/:id/retire', { preHandler: guard('network:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    return withScope(req.ctx.scope, async (c) => {
      const g = (await c.query('update cgnat_plans set retired_at = now() where id = $1 and retired_at is null returning *', [id])).rows[0];
      if (!g) throw new HttpError(404, 'plano vigente não encontrado');
      await audit(c, req.ctx, 'cgnat.plan_retire', 'cgnat_plan', id);
      return g;
    });
  });

  const loadPlan = async (c: any, id: string): Promise<CgnatPlan & Record<string, any>> => {
    const g = (await c.query(`${PLAN_SELECT} where g.id = $1`, [id])).rows[0];
    if (!g) throw new HttpError(404, 'plano de CGNAT não encontrado');
    return g;
  };

  app.get('/api/cgnat/plans/:id/map', { preHandler: guard('network:read') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const q = z.object({ limit: z.coerce.number().int().min(1).max(2000).default(256), offset: z.coerce.number().int().min(0).default(0) }).parse(req.query);
    return withScope(req.ctx.scope, async (c) => {
      const g = await loadPlan(c, id);
      const rows = [];
      let i = 0;
      for (const b of blocks(g)) { if (i >= q.offset + q.limit) break; if (i++ >= q.offset) rows.push(b); }
      return { plan: withCap(g), total: parseCidr4(g.private_cidr).size, rows };
    });
  });

  /** Script RouterOS para revisão. O sistema não o envia a nenhum equipamento; o download fica na auditoria. */
  app.get('/api/cgnat/plans/:id/script', { preHandler: guard('network:write') }, async (req, reply) => {
    const id = zUuid.parse((req.params as any).id);
    const g = await withScope(req.ctx.scope, async (c) => {
      const g = await loadPlan(c, id);
      await audit(c, req.ctx, 'cgnat.script_export', 'cgnat_plan', id);
      return g;
    });
    return reply.header('content-type', 'text/plain; charset=utf-8').header('content-disposition', `attachment; filename="cgnat-${id.slice(0, 8)}.rsc"`).send(routerosScript(g));
  });

  /** Rastreabilidade: IP público + porta (+ data) -> IP privado e, quando o sistema sabe, o assinante. Consulta auditada. */
  app.get('/api/cgnat/trace', { preHandler: guard('network:read') }, async (req) => {
    const q = z.object({ ip: z.string().trim().refine(isIpv4, 'IP público inválido'), port: z.coerce.number().int().min(1).max(65535), at: z.string().datetime({ offset: true }).optional() }).parse(req.query);
    return withScope(req.ctx.scope, async (c) => {
      const at = q.at ?? new Date().toISOString();
      const plans = (await c.query(
        `${PLAN_SELECT} where $1::inet << g.public_cidr and g.created_at <= $2::timestamptz and (g.retired_at is null or g.retired_at > $2::timestamptz) order by g.created_at desc`, [q.ip, at])).rows;
      await audit(c, req.ctx, 'cgnat.trace', 'cgnat', null, { ip: q.ip, port: q.port, at });
      for (const g of plans) {
        const b = reverse(g, q.ip, q.port);
        if (!b) continue;
        const fixed = (await c.query(`${ALLOC_SELECT} where a.address = $1::inet`, [b.private_ip])).rows[0] ?? null;
        // sessão PPPoE observada AGORA com esse IP (não prova quem usava o endereço no passado)
        const session = (await c.query(
          `select r.pppoe_username, r.observed_at, r.contract_id, s.id as subscriber_id, s.name as subscriber_name
           from service_resources r join contracts k on k.id = r.contract_id join subscribers s on s.id = k.subscriber_id
           where r.observed_session->>'ip' = $1 and (r.observed_session->>'online')::boolean is true`, [b.private_ip])).rows[0] ?? null;
        return { found: true, at, plan: { id: g.id, name: g.name, retired_at: g.retired_at }, ...b, fixed_allocation: fixed, current_session: session,
          note: fixed ? 'Endereço privado fixo de um contrato.'
            : 'Endereço privado dinâmico: o titular na data consultada está no accounting do RADIUS local do provedor (tabela radacct: framedipaddress + horário). A sessão atual, se exibida, não comprova o uso no passado.' };
      }
      return { found: false, at, note: plans.length ? 'A porta não pertence a nenhum bloco do plano vigente na data.' : 'Nenhum plano de CGNAT do provedor cobria esse IP público na data informada.' };
    });
  });

  app.get('/api/cgnat/plans/:id/lookup', { preHandler: guard('network:read') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const q = z.object({ private_ip: z.string().trim().refine(isIpv4, 'IP inválido') }).parse(req.query);
    return withScope(req.ctx.scope, async (c) => {
      const b = forward(await loadPlan(c, id), q.private_ip);
      if (!b) throw new HttpError(404, 'o endereço não pertence ao bloco de assinantes deste plano');
      return b;
    });
  });
}
