import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { audit, guard, HttpError } from '../auth.js';
import { withScope } from '../db.js';
import { zUuid } from '../validators.js';

/**
 * Aceite eletrônico simples (Lei 14.063/2020, art. 4º, I): o assinante é identificado pelo acesso autenticado ao portal.
 * Registra o texto exato (e o resumo SHA-256), data e hora, endereço de rede e navegador. Não é assinatura avançada nem
 * qualificada; a força probatória em disputa depende do contexto e deve ser avaliada com o jurídico do provedor.
 */
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
/** Texto canônico da prova: tudo o que identifica o ato, em ordem fixa, para poder ser conferido depois. */
const evidenceOf = (a: { id: string; contract_id: string; subscriber_id: string; body_hash: string }, userId: string, atIso: string, ip: string) =>
  sha(JSON.stringify({ v: 1, id: a.id, contract: a.contract_id, subscriber: a.subscriber_id, body: a.body_hash, user: userId, at: atIso, ip }));

const COLS = `a.id, a.contract_id, a.subscriber_id, a.amendment_id, a.title, a.status, a.body_hash, a.requested_at, a.accepted_at, a.accepted_ip,
              a.evidence_hash, a.canceled_at, u.name as requested_by_name`;

export async function aceitesRoutes(app: FastifyInstance) {
  app.get('/api/contracts/:id/acceptances', { preHandler: guard('contracts:read') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    return withScope(req.ctx.scope, async (c) =>
      (await c.query(`select ${COLS} from acceptances a left join users u on u.id = a.requested_by where a.contract_id = $1 order by a.requested_at desc`, [id])).rows);
  });

  app.post('/api/contracts/:id/acceptances', { preHandler: guard('contracts:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({
      amendment_id: zUuid.optional(),
      title: z.string().trim().min(3).max(120).optional(), body: z.string().trim().min(1).max(8000).optional(),
    }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const k = (await c.query('select id, subscriber_id from contracts where id = $1', [id])).rows[0];
      if (!k) throw new HttpError(404, 'contrato não encontrado');
      let title = b.title, body = b.body;
      if (b.amendment_id) {
        const am = (await c.query('select title, body from contract_amendments where id = $1 and contract_id = $2', [b.amendment_id, id])).rows[0];
        if (!am) throw new HttpError(400, 'aditivo não encontrado neste contrato');
        title = am.title; body = am.body;
      }
      if (!title || !body) throw new HttpError(400, 'informe o título e o texto do documento (ou escolha um aditivo)');
      const portal = (await c.query(`select 1 from users where subscriber_id = $1 and role = 'subscriber' and active`, [k.subscriber_id])).rowCount;
      if (!portal) throw new HttpError(409, 'o assinante não tem acesso ao portal: crie o acesso antes de pedir o aceite');
      const r = (await c.query(
        `insert into acceptances (tenant_id, contract_id, subscriber_id, amendment_id, title, body, body_hash, requested_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing returning id`,
        [req.ctx.tenantId, id, k.subscriber_id, b.amendment_id ?? null, title, body, sha(body), req.ctx.userId])).rows[0];
      if (!r) throw new HttpError(409, 'já existe um pedido pendente com este mesmo texto');
      await audit(c, req.ctx, 'acceptance.request', 'contract', id, { acceptance_id: r.id, title });
      return { id: r.id, status: 'pending' };
    });
  });

  app.post('/api/acceptances/:id/cancel', { preHandler: guard('contracts:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    return withScope(req.ctx.scope, async (c) => {
      const r = (await c.query(`update acceptances set status = 'canceled', canceled_at = now() where id = $1 and status = 'pending' returning id, contract_id`, [id])).rows[0];
      if (!r) throw new HttpError(409, 'só um pedido pendente pode ser cancelado');
      await audit(c, req.ctx, 'acceptance.cancel', 'contract', r.contract_id, { acceptance_id: id });
      return { ok: true };
    });
  });

  /** Comprovante: o que foi aceito, por quem, quando e de onde, com a conferência dos resumos. */
  app.get('/api/acceptances/:id/evidence', { preHandler: guard('contracts:read') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    return withScope(req.ctx.scope, async (c) => {
      const a = (await c.query(
        `select a.*, s.name as subscriber_name, s.document as subscriber_document, pu.email as accepted_email
         from acceptances a join subscribers s on s.id = a.subscriber_id left join users pu on pu.id = a.accepted_by where a.id = $1`, [id])).rows[0];
      if (!a) throw new HttpError(404, 'aceite não encontrado');
      const textOk = sha(a.body) === a.body_hash;
      const proofOk = a.status === 'accepted'
        ? evidenceOf(a, a.accepted_by, new Date(a.accepted_at).toISOString(), a.accepted_ip) === a.evidence_hash : null;
      return {
        id: a.id, status: a.status, title: a.title, body: a.body, body_hash: a.body_hash, contract_id: a.contract_id,
        subscriber: { id: a.subscriber_id, name: a.subscriber_name, document: a.subscriber_document },
        requested_at: a.requested_at, accepted_at: a.accepted_at, accepted_ip: a.accepted_ip, accepted_user_agent: a.accepted_user_agent,
        accepted_email: a.accepted_email, evidence_hash: a.evidence_hash,
        verification: { text_matches_hash: textOk, evidence_matches: proofOk },
        method: 'Aceite eletrônico simples: identificação por acesso autenticado ao portal do assinante (Lei 14.063/2020, art. 4º, I). Não é assinatura avançada nem qualificada.',
      };
    });
  });

  // ---- Portal do assinante ----
  app.get('/api/portal/acceptances', { preHandler: guard('portal:self') }, async (req) =>
    withScope(req.ctx.scope, async (c) =>
      (await c.query(
        `select a.id, a.contract_id, a.title, a.body, a.status, a.requested_at, a.accepted_at
         from acceptances a where a.status <> 'canceled' order by (a.status = 'pending') desc, a.requested_at desc limit 50`)).rows));

  app.post('/api/portal/acceptances/:id/accept', { preHandler: guard('portal:self') }, async (req) => {
    const sid = req.ctx.subscriberId;
    if (!sid || !req.ctx.userId) throw new HttpError(403, 'sessão sem assinante');
    const id = zUuid.parse((req.params as any).id);
    z.object({ agree: z.literal(true, { errorMap: () => ({ message: 'confirme que leu e concorda com o texto' }) }) }).parse(req.body);
    const own = await withScope(req.ctx.scope, async (c) =>
      (await c.query('select id, contract_id, subscriber_id, body_hash, status from acceptances where id = $1 and subscriber_id = $2', [id, sid])).rows[0]);
    if (!own) throw new HttpError(404, 'documento não encontrado');
    if (own.status !== 'pending') throw new HttpError(409, own.status === 'accepted' ? 'documento já aceito' : 'este pedido foi cancelado');
    const at = new Date();
    const ip = req.ip, ua = String(req.headers['user-agent'] ?? '').slice(0, 300) || null;
    const ev = evidenceOf(own, req.ctx.userId, at.toISOString(), ip);
    return withScope({ tenantId: req.ctx.tenantId!, operator: false }, async (c) => {
      const r = (await c.query(
        `update acceptances set status = 'accepted', accepted_at = $2, accepted_by = $3, accepted_ip = $4, accepted_user_agent = $5, evidence_hash = $6
         where id = $1 and status = 'pending' returning id`, [id, at.toISOString(), req.ctx.userId, ip, ua, ev])).rows[0];
      if (!r) throw new HttpError(409, 'documento já respondido');
      await audit(c, req.ctx, 'acceptance.accept', 'contract', own.contract_id, { acceptance_id: id, evidence_hash: ev });
      return { id, status: 'accepted', accepted_at: at.toISOString(), evidence_hash: ev };
    });
  });
}
