import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Tx } from '../db.js';

export interface GatewayPayment { paymentId: string; amountCents: number; paidAt: string; method?: string }
export interface GatewayEvent { eventId: string; type: string; chargeId: string | null; payment?: GatewayPayment }
/** Um adaptador por gateway. Integração real: implementar esta interface com a API do provedor escolhido (pendente). */
export interface Gateway {
  name: string;
  demo: boolean;
  /** Idempotente por fatura: repetir não cria segunda cobrança. */
  createCharge(c: Tx, inv: { id: string; tenant_id: string; amount_cents: number; due_date: string }): Promise<{ chargeId: string; methods: Record<string, string> }>;
  verifyWebhook(rawBody: string, headers: Record<string, unknown>): boolean;
  parseWebhook(body: any): GatewayEvent;
  /** Consulta o estado da cobrança no provedor (conciliação de eventos perdidos). */
  getCharge(c: Tx, chargeId: string): Promise<{ payments: GatewayPayment[] } | null>;
}

const secret = () => process.env.NEXO_GATEWAY_WEBHOOK_SECRET ?? '';
export function demoSign(rawBody: string, timestamp: string): string {
  return 'sha256=' + createHmac('sha256', secret()).update(`${timestamp}.${rawBody}`).digest('hex');
}

/**
 * GATEWAY DE DEMONSTRAÇÃO — não emite PIX/boleto reais nem movimenta dinheiro.
 * O "lado do provedor" é a tabela demo_gateway_charges. Bloqueado fora do modo demonstração.
 */
export const demoGateway: Gateway = {
  name: 'demo',
  demo: true,
  async createCharge(c, inv) {
    const chargeId = `demo_ch_${inv.id}`;
    await c.query(`insert into demo_gateway_charges (charge_id, tenant_id, amount_cents) values ($1,$2,$3) on conflict (charge_id) do nothing`,
      [chargeId, inv.tenant_id, inv.amount_cents]);
    return { chargeId, methods: {
      pix_copia_e_cola: `DEMONSTRACAO-NAO-PAGAVEL-PIX-${inv.id.slice(0, 8)}`,
      boleto_linha_digitavel: `00000.00000 00000.000000 00000.000000 0 DEMONSTRACAO`,
      aviso: 'Meios de pagamento fictícios do gateway de demonstração.',
    } };
  },
  verifyWebhook(rawBody, headers) {
    const ts = String(headers['x-nexo-timestamp'] ?? ''), sig = String(headers['x-nexo-signature'] ?? '');
    if (!secret() || !ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // janela anti-replay
    const a = Buffer.from(demoSign(rawBody, ts)), b = Buffer.from(sig);
    return a.length === b.length && timingSafeEqual(a, b);
  },
  parseWebhook(body) {
    return { eventId: String(body.id), type: String(body.type), chargeId: body.charge_id ? String(body.charge_id) : null,
      payment: body.payment ? { paymentId: String(body.payment.id), amountCents: Number(body.payment.amount_cents), paidAt: String(body.payment.paid_at), method: body.payment.method } : undefined };
  },
  async getCharge(c, chargeId) {
    const r = (await c.query('select payments from demo_gateway_charges where charge_id = $1', [chargeId])).rows[0];
    return r ? { payments: r.payments.map((p: any) => ({ paymentId: p.id, amountCents: p.amount_cents, paidAt: p.paid_at, method: p.method })) } : null;
  },
};

export function getGateway(name: string): Gateway | null {
  if (name === 'demo') return process.env.NEXO_DEMO_MODE === '1' ? demoGateway : null;
  return null;
}
