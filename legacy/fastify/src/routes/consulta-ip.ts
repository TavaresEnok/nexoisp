import type { FastifyInstance } from 'fastify';
import { isIP } from 'node:net';
import { z } from 'zod';
import { audit, guard, HttpError } from '../auth.js';
import { withScope } from '../db.js';
import { blocksPerPublic, forward, intToIp, ipToInt, parseCidr4, reverse, type CgnatPlan } from '../network/cgnat.js';

/**
 * Consulta de IP para responder ofício (requisição judicial/policial): quem estava com um endereço num período.
 * - IP público de CGNAT com porta: a porta aponta um único IP privado (bloco determinístico do plano); sem porta, o IP público é
 *   compartilhado e a resposta lista todos os assinantes daquele IP público no período.
 * - Outro IPv4 (público entregue direto, ou privado): sessões com esse endereço.
 * - IPv6: delegação de prefixo ao contrato (registro fixo, sem histórico de titulares anteriores).
 * A fonte é o registro de sessões (accounting). Cada consulta exige o número do ofício/processo e fica na auditoria.
 */
const MAX_DAYS = 92, MAX_ROWS = 1000;

export async function consultaIpRoutes(app: FastifyInstance) {
  app.post('/api/legal/ip-lookup', { preHandler: guard('legal:query') }, async (req) => {
    const b = z.object({
      ip: z.string().trim().refine((v) => isIP(v) !== 0, 'endereço IP inválido'),
      port: z.number().int().min(1).max(65535).nullish(),
      from: z.string().datetime({ offset: true }), to: z.string().datetime({ offset: true }),
      margin_minutes: z.number().int().min(0).max(60).default(0),
      reference: z.string().trim().min(3, 'informe o número do ofício ou do processo').max(120),
    }).parse(req.body);
    const from = new Date(b.from), to = new Date(b.to);
    if (to < from) throw new HttpError(400, 'o fim do período é anterior ao início');
    if (to.getTime() - from.getTime() > MAX_DAYS * 86_400_000) throw new HttpError(400, `período máximo de ${MAX_DAYS} dias por consulta`);
    const lo = new Date(from.getTime() - b.margin_minutes * 60_000), hi = new Date(to.getTime() + b.margin_minutes * 60_000);

    return withScope(req.ctx.scope, async (c) => {
      const notes: string[] = [];
      // 1. que endereços procurar nas sessões
      let targets: { ip: string; cgnat?: { plan: string; public_ip: string; port_start: number; port_end: number } }[] = [];
      let mode: 'cgnat_port' | 'cgnat_shared' | 'direct' | 'ipv6';
      let ipv6: any[] = [];
      if (isIP(b.ip) === 6) {
        mode = 'ipv6';
        ipv6 = (await c.query(
          `select d.prefix::text as prefix, d.created_at, k.id as contract_id, s.id as subscriber_id, s.name, s.document, s.phone, s.email,
                  concat_ws(', ', s.address_street, s.address_number, s.address_district, s.address_city, s.address_state) as address
           from ip6_delegations d join contracts k on k.id = d.contract_id join subscribers s on s.id = k.subscriber_id
           where d.prefix >>= $1::inet and d.created_at <= $2`, [b.ip, hi])).rows;
        notes.push('IPv6: o resultado é a delegação de prefixo registrada para o contrato. O sistema não guarda histórico de titulares anteriores do mesmo prefixo.');
        if (b.port) notes.push('A porta não se aplica a IPv6 (não há CGNAT).');
      } else {
        const plans: (CgnatPlan & { created_at: Date; retired_at: Date | null })[] = (await c.query(
          `select id, name, host(public_cidr) || '/' || masklen(public_cidr) as public_cidr, host(private_cidr) || '/' || masklen(private_cidr) as private_cidr,
                  ports_per_subscriber, port_start, created_at, retired_at
           from cgnat_plans where $1::inet << public_cidr and created_at <= $3 and (retired_at is null or retired_at >= $2) order by created_at`, [b.ip, lo, hi])).rows;
        if (plans.length) {
          for (const p of plans) {
            if (b.port) {
              const blk = reverse(p, b.ip, b.port);
              if (blk) targets.push({ ip: blk.private_ip, cgnat: { plan: p.name, public_ip: blk.public_ip, port_start: blk.port_start, port_end: blk.port_end } });
              else notes.push(`A porta ${b.port} não pertence a nenhum bloco do plano de CGNAT "${p.name}".`);
            } else {
              const pub = parseCidr4(p.public_cidr), priv = parseCidr4(p.private_cidr), per = blocksPerPublic(p), pi = ipToInt(b.ip) - pub.base;
              for (let i = pi * per; i < Math.min((pi + 1) * per, priv.size); i++) {
                const blk = forward(p, intToIp(priv.base + i));
                if (blk) targets.push({ ip: blk.private_ip, cgnat: { plan: p.name, public_ip: blk.public_ip, port_start: blk.port_start, port_end: blk.port_end } });
              }
            }
          }
          mode = b.port ? 'cgnat_port' : 'cgnat_shared';
          if (!b.port) notes.push(`Sem a porta de origem, este IP público é compartilhado por até ${targets.length} assinantes (CGNAT). A lista abaixo traz todos os que o usaram no período; peça a porta para identificar um só.`);
          if (plans.length > 1) notes.push('Mais de um plano de CGNAT cobriu este IP no período (troca de plano): todos foram considerados.');
        } else {
          mode = 'direct';
          targets = [{ ip: b.ip }];
          if (b.port) notes.push('Este IP não pertence a um plano de CGNAT do provedor: a porta não muda o resultado.');
        }
      }

      // 2. sessões que se sobrepõem ao período
      const ips = [...new Set(targets.map((t) => t.ip))];
      const rows = ips.length ? (await c.query(
        `select s.ip, s.started_at, s.stopped_at, s.mac, s.nas_ip, s.terminate_cause, s.session_key, r.pppoe_username as login,
                k.id as contract_id, sub.id as subscriber_id, sub.name, sub.document, sub.phone, sub.email,
                concat_ws(', ', sub.address_street, sub.address_number, sub.address_district, sub.address_city, sub.address_state) as address
         from service_sessions s join service_resources r on r.id = s.resource_id join contracts k on k.id = r.contract_id join subscribers sub on sub.id = k.subscriber_id
         where s.ip = any($1::text[]) and s.started_at <= $3 and coalesce(s.stopped_at, now()) >= $2
         order by s.started_at limit ${MAX_ROWS + 1}`, [ips, lo, hi])).rows : [];
      if (rows.length > MAX_ROWS) { rows.length = MAX_ROWS; notes.push(`Resultado limitado a ${MAX_ROWS} sessões: reduza o período.`); }
      const byIp = new Map(targets.map((t) => [t.ip, t.cgnat]));
      const sessions = rows.map((r) => ({ ...r, cgnat: byIp.get(r.ip) ?? null }));

      // 3. IP fixo atual (pista; o histórico vale pelas sessões) e cobertura do registro
      const fixed = ips.length ? (await c.query(
        `select host(a.address) as ip, a.created_at, k.id as contract_id, s.name from ip_allocations a join contracts k on k.id = a.contract_id
         join subscribers s on s.id = k.subscriber_id where a.address = any($1::inet[])`, [ips])).rows : [];
      const since = (await c.query('select min(started_at) as t from service_sessions')).rows[0].t;
      if (!since || new Date(since) > lo) notes.push(`O registro de sessões deste provedor começa em ${since ? new Date(since).toISOString() : '(nenhuma sessão registrada)'}: períodos anteriores não podem ser respondidos por este sistema.`);
      if (mode !== 'ipv6' && !sessions.length) notes.push('Nenhuma sessão encontrada com este endereço no período informado.');

      const subscribers = new Set([...sessions.map((s) => s.subscriber_id), ...ipv6.map((d) => d.subscriber_id)]).size;
      await audit(c, req.ctx, 'legal.ip_lookup', 'legal', null,
        { reference: b.reference, ip: b.ip, port: b.port ?? null, from: b.from, to: b.to, margin_minutes: b.margin_minutes, mode, sessions: sessions.length, subscribers });
      return { query: { ...b, from: lo.toISOString(), to: hi.toISOString() }, mode, targets, sessions, ipv6, fixed, notes, records_since: since,
        subscribers, generated_at: new Date().toISOString(), generated_by: req.ctx.name };
    });
  });

  // Histórico das consultas feitas (para conferência e para responder de novo o mesmo ofício).
  app.get('/api/legal/ip-lookup/history', { preHandler: guard('legal:query') }, async (req) =>
    withScope(req.ctx.scope, async (c) =>
      (await c.query(
        `select e.at, e.detail, u.name as user_name from audit_events e left join users u on u.id::text = e.actor_id
         where e.action = 'legal.ip_lookup' order by e.at desc limit 100`)).rows));
}
